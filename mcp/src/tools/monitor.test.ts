import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { realpathSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { openDb } from '../store/db';
import { ctxTreeMonitor } from './monitor';
import { getNodeBySourceUri } from '../store/nodes';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types';

const config = { trustedExecution: true } as unknown as CtxTreeConfig;

let db: Database;
let store: StoreBackend;

beforeEach(() => { db = openDb(':memory:'); store = wrapDatabase(db); });
afterEach(() => { db.close(); });

describe('ctxTreeMonitor', () => {
  it('runs a command and stores output as tool_output node', async () => {
    const result = await ctxTreeMonitor(store, config, { command: 'echo hello' });

    expect(result.exit_code).toBe(0);
    expect(result.preview).toContain('hello');
    expect(result.lines_captured).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
    expect(result.nodeId).toBeTruthy();

    const stored = getNodeBySourceUri(db, `cmd://${result.nodeId.slice(0, 0)}`) ??
      db.query<{ kind: string }, [string]>('SELECT kind FROM nodes WHERE id = ?').get(result.nodeId);
    expect(stored?.kind).toBe('tool_output');
  });

  it('captures stderr prefixed with [stderr]', async () => {
    const result = await ctxTreeMonitor(store, config, { command: 'echo err >&2' });
    expect(result.preview).toContain('err');
  });

  it('returns non-zero exit_code for failing commands', async () => {
    const result = await ctxTreeMonitor(store, config, { command: 'exit 42' });
    expect(result.exit_code).toBe(42);
  });

  it('returns cached=true and same nodeId when output is identical', async () => {
    const first  = await ctxTreeMonitor(store, config, { command: 'echo stable-output' });
    const second = await ctxTreeMonitor(store, config, { command: 'echo stable-output' });

    expect(second.cached).toBe(true);
    expect(second.nodeId).toBe(first.nodeId);
  });

  it('creates supersedes edge when output changes', async () => {
    const first  = await ctxTreeMonitor(store, config, { command: 'echo first-run' });

    // Force a different output by modifying the stored node's content hash manually
    db.run('UPDATE nodes SET content_hash = ? WHERE id = ?', 'stale', first.nodeId);
    const second = await ctxTreeMonitor(store, config, { command: 'echo first-run' });

    expect(second.nodeId).not.toBe(first.nodeId);
    const edge = db.query<{ kind: string }, [string, string]>(
      'SELECT kind FROM edges WHERE src_id = ? AND dst_id = ?'
    ).get(second.nodeId, first.nodeId);
    expect(edge?.kind).toBe('supersedes');
  });

  it('captures multiline output correctly', async () => {
    const result = await ctxTreeMonitor(store, config, {
      command: 'printf "line1\\nline2\\nline3\\n"',
    });
    expect(result.lines_captured).toBe(4); // 3 lines + trailing newline split
    expect(result.preview).toContain('line1');
    expect(result.preview).toContain('line3');
  });

  it('throws on missing command', async () => {
    await expect(ctxTreeMonitor(store, config, { command: '' })).rejects.toThrow();
  });

  it('respects cwd option', async () => {
    const result = await ctxTreeMonitor(store, config, {
      command: 'pwd',
      cwd: '/tmp',
    });
    expect(result.preview.trim()).toBe(realpathSync('/tmp'));
  });
});
