import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'path';
import { openDb, closeDb } from '../store/db';
import { ctxTreeRead } from './read';
import { DEFAULT_CONFIG } from '../config';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/ctx-tree-read-test.db';
const FIXTURE_DIR = '/tmp/ctx-tree-read-fixtures';
let db: Database;
let store: StoreBackend;
const cfg = DEFAULT_CONFIG;

beforeEach(() => {
  db = openDb(TEST_DB);
  store = wrapDatabase(db);
  mkdirSync(FIXTURE_DIR, { recursive: true });
});
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('ctxTreeRead', () => {
  test('reads a file and returns content within budget', async () => {
    const filePath = join(FIXTURE_DIR, 'sample.ts');
    writeFileSync(filePath, 'export const foo = 1;\nexport const bar = 2;\n');
    const result = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 200 });
    expect(result.content).toContain('foo');
    expect(result.nodeIds[0]).toBeTruthy();
  });

  test('creates file_chunk node in store with symbol-name source_uri', async () => {
    const filePath = join(FIXTURE_DIR, 'cached.ts');
    writeFileSync(filePath, 'export function hello() { return "world"; }\n');
    await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 500 });
    type Row = { id: string; source_uri: string; parent_id: string | null; metadata: string };
    const nodes = db.query("SELECT id, source_uri, parent_id, metadata FROM nodes WHERE kind = 'file_chunk'").all() as Row[];
    const root = nodes.find(n => !n.source_uri.includes('#'));
    const sym  = nodes.find(n => n.source_uri.endsWith('#hello'));
    expect(root).toBeTruthy();
    expect(JSON.parse(root!.metadata).is_file_root).toBe(true);
    expect(sym).toBeTruthy();
    expect(sym!.parent_id).toBe(root!.id);
  });

  test('returns cached result when mtime unchanged', async () => {
    const filePath = join(FIXTURE_DIR, 'stable.ts');
    writeFileSync(filePath, 'export const x = 42;\n// padding to meet size threshold\n');
    const r1 = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 500 });
    const count1 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const r2 = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 500 });
    const count2 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(count2).toBe(count1);
    expect(r2.nodeIds[0]).toBe(r1.nodeIds[0]);
    expect(r2.content).toBe(r1.content);
  });

  test('symbol-name URI is stable when function shifts lines', async () => {
    const filePath = join(FIXTURE_DIR, 'shift.ts');
    writeFileSync(filePath, 'function greet() { return "hi"; }\n');
    const r1 = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 500 });
    const uri1 = (db.query("SELECT source_uri FROM nodes WHERE kind='file_chunk' AND source_uri LIKE '%#%' LIMIT 1").get() as any).source_uri;
    expect(uri1).toMatch(/#greet$/);

    // Prepend a line — function shifts down but keeps its name.
    // Force a distinct mtime so the cache invalidates even within the same clock tick.
    writeFileSync(filePath, '// header comment\nfunction greet() { return "hi"; }\n');
    const future = new Date(Date.now() + 2000);
    utimesSync(filePath, future, future);
    const r2 = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 500 });
    const uri2 = (db.query("SELECT source_uri FROM nodes WHERE kind='file_chunk' AND status='live' AND source_uri LIKE '%#%' LIMIT 1").get() as any).source_uri;
    expect(uri2).toMatch(/#greet$/);
    expect(uri2).toBe(uri1);
    // New node was created (mtime changed) but URI is identical.
    expect(r2.nodeIds[0]).not.toBe(r1.nodeIds[0]);
  });

  test('filters chunks to requested line range (0-based)', async () => {
    const filePath = join(FIXTURE_DIR, 'ranged.ts');
    // Write a file with two distinct blocks across lines 0-2 and 4-6 (0-based)
    writeFileSync(filePath, [
      'const BLOCK_A = 1;',  // line 0
      'const A2 = 2;',       // line 1
      'const A3 = 3;',       // line 2
      '',                    // line 3
      'const BLOCK_B = 10;', // line 4
      'const B2 = 20;',      // line 5
      'const B3 = 30;',      // line 6
    ].join('\n'));
    const result = await ctxTreeRead(store, cfg, { path: filePath, lines: [4, 6], budget_tokens: 2000 });
    expect(result.content).toContain('BLOCK_B');
    expect(result.content).not.toContain('BLOCK_A');
  });

  test('falls back to window chunking for unknown file type', async () => {
    const filePath = join(FIXTURE_DIR, 'data.xyz');
    writeFileSync(filePath, Array(210).fill('x').join('\n'));
    const result = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 2000 });
    expect(result.content).toBeTruthy();
    const meta = JSON.parse(
      (db.query("SELECT metadata FROM nodes WHERE kind='file_chunk' AND json_extract(metadata,'$.is_file_root') IS NULL LIMIT 1").get() as any).metadata
    );
    expect(meta.chunking).toBe('window');
  });

  test('window chunks use L<start>-<end> source_uri fragment', async () => {
    const filePath = join(FIXTURE_DIR, 'plain.txt');
    writeFileSync(filePath, Array(10).fill('line').join('\n'));
    await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 2000 });
    const nodes = db.query("SELECT source_uri FROM nodes WHERE kind='file_chunk' AND source_uri LIKE '%#%'").all() as Array<{ source_uri: string }>;
    expect(nodes[0].source_uri).toMatch(/#L\d+-\d+$/);
  });

  test('rejects path matching denylist (.env)', async () => {
    const filePath = join(FIXTURE_DIR, '.env');
    writeFileSync(filePath, 'SECRET=abc\n');
    await expect(ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 200 }))
      .rejects.toThrow('Path rejected by denylist');
  });

  test('uses treesitter chunking for .ts files when parsers are installed', async () => {
    const filePath = join(FIXTURE_DIR, 'functions.ts');
    writeFileSync(filePath, `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export function farewell(name: string): string {
  return \`Goodbye, \${name}\`;
}

export class Greeter {
  greet(name: string) {
    return greet(name);
  }
}
`);
    const result = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 2000 });
    expect(result.content).toBeTruthy();
    // Verify that the chunking strategy is 'treesitter', not 'window'
    expect(result.chunking).toBe('treesitter');
    
    // Check the persisted metadata for proof of actual tree-sitter parsing
    const nodeRow = db.query(
      "SELECT metadata FROM nodes WHERE kind='file_chunk' ORDER BY rowid DESC LIMIT 1"
    ).get() as any;
    expect(nodeRow).toBeTruthy();
    const meta = JSON.parse(nodeRow.metadata);
    expect(meta.chunking).toBe('treesitter');
    expect(meta.chunkCount).toBeGreaterThan(1);
  });

  test('caps returned content within budget_tokens even for a single oversized chunk', async () => {
    const filePath = join(FIXTURE_DIR, 'big-class.ts');
    const methods = Array.from({ length: 60 }, (_, i) => `  method${i}() { return ${i}; }`).join('\n');
    writeFileSync(filePath, `export class Big {\n${methods}\n}\n`);
    const result = await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 100 });
    expect(result.content.length).toBeLessThanOrEqual(100 * 4);
  });

  test('stores full chunk content in the graph even when the returned excerpt is truncated', async () => {
    const filePath = join(FIXTURE_DIR, 'big-class-2.ts');
    const methods = Array.from({ length: 60 }, (_, i) => `  method${i}() { return ${i}; }`).join('\n');
    const fullSource = `export class Big2 {\n${methods}\n}\n`;
    writeFileSync(filePath, fullSource);
    await ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 100 });
    const stored = db.query(
      "SELECT content FROM nodes WHERE kind='file_chunk' AND json_extract(metadata,'$.is_file_root') IS NULL LIMIT 1"
    ).get() as { content: string };
    expect(stored.content.length).toBeGreaterThan(100 * 4);
  });

  test('rejects non-positive budget_tokens', async () => {
    const filePath = join(FIXTURE_DIR, 'any.ts');
    writeFileSync(filePath, 'export const x = 1;\n');
    await expect(ctxTreeRead(store, cfg, { path: filePath, budget_tokens: 0 }))
      .rejects.toThrow('budget_tokens must be positive');
  });
});
