import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { openDb, closeDb } from '../store/db';
import { ctxTreeGrep } from './grep';
import { DEFAULT_CONFIG } from '../config';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/ctx-tree-grep-test.db';
const FIXTURE_DIR = '/tmp/ctx-tree-grep-fixtures';
let db: Database;
let store: StoreBackend;

beforeEach(() => {
  db = openDb(TEST_DB);
  store = wrapDatabase(db);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'a.ts'), 'export function doThing() { return 42; }\n');
  writeFileSync(join(FIXTURE_DIR, 'b.ts'), 'const x = 1; // no match\n');
});
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('ctxTreeGrep', () => {
  test('returns matches for a pattern', async () => {
    const result = await ctxTreeGrep(store, DEFAULT_CONFIG, {
      pattern: 'doThing',
      path: FIXTURE_DIR,
    });
    expect(result.matches.some(m => m.includes('a.ts'))).toBe(true);
    expect(result.nodeId).toBeTruthy();
  });

  test('creates tool_output node and file_chunk children in store', async () => {
    await ctxTreeGrep(store, DEFAULT_CONFIG, { pattern: 'doThing', path: FIXTURE_DIR });
    const toolNode = db.query("SELECT * FROM nodes WHERE kind = 'tool_output' LIMIT 1").get();
    expect(toolNode).not.toBeNull();
    const children = db.query("SELECT * FROM nodes WHERE kind = 'file_chunk' AND parent_id = ?").all((toolNode as { id: string }).id);
    expect(children.length).toBeGreaterThan(0);
  });

  test('returns empty matches when pattern not found', async () => {
    const result = await ctxTreeGrep(store, DEFAULT_CONFIG, {
      pattern: 'nonexistent_xyz_pattern',
      path: FIXTURE_DIR,
    });
    expect(result.matches).toHaveLength(0);
  });

  test('rejects path matching denylist (.env file as search path)', async () => {
    await expect(ctxTreeGrep(db, DEFAULT_CONFIG, { pattern: 'SECRET', path: '/home/user/.env' }))
      .rejects.toThrow('Path rejected by denylist');
  });

  test('excludes lines from denylisted files in matches and stored content', async () => {
    writeFileSync(join(FIXTURE_DIR, '.env'), 'SECRET=supersecret\nAPI_KEY=abc123\n');
    writeFileSync(join(FIXTURE_DIR, 'safe.ts'), 'const SECRET_NAME = "non-secret";\n');
    const result = await ctxTreeGrep(store, DEFAULT_CONFIG, {
      pattern: 'SECRET',
      path: FIXTURE_DIR,
    });
    // .env lines must not appear in returned matches
    expect(result.matches.every(m => !m.includes('.env'))).toBe(true);
    // .env lines must not appear in stored tool_output content
    const node = db.query("SELECT content FROM nodes WHERE kind = 'tool_output' LIMIT 1").get() as { content: string } | null;
    if (node) expect(node.content).not.toContain('supersecret');
  });

  test('caps returned matches to budget_tokens', async () => {
    const bigFile = join(FIXTURE_DIR, 'many.ts');
    const lines = Array.from(
      { length: 200 },
      (_, i) => `const marker_${i} = "padding to make this matched line long enough to matter";`,
    ).join('\n');
    writeFileSync(bigFile, lines);
    const result = await ctxTreeGrep(store, DEFAULT_CONFIG, {
      pattern: 'marker_',
      path: FIXTURE_DIR,
      budget_tokens: 50,
    });
    const approxTokens = Math.ceil(result.matches.join('\n').length / 4);
    expect(approxTokens).toBeLessThanOrEqual(60);
  });

  test('rejects non-positive budget_tokens', async () => {
    await expect(ctxTreeGrep(store, DEFAULT_CONFIG, {
      pattern: 'doThing',
      path: FIXTURE_DIR,
      budget_tokens: 0,
    })).rejects.toThrow('budget_tokens must be positive');
  });
});
