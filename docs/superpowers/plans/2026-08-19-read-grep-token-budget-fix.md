# Read/Grep Token-Budget Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement Tasks 1-9 task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 10 is explicitly excluded from automated execution** — see its header for why (it spends real API budget and requires human judgment on the result).

**Goal:** Fix the confirmed token-budget regression in `ctx_tree_read`/`ctx_tree_grep`
(`docs/postmortems/2026-08-18-read-grep-token-regression.md`) by extracting `compose.ts`'s
already-correct per-item budget logic into a shared helper both tools use, then gate the whole
effort on a re-run of the original A/B test.

**Architecture:** One new module, `mcp/src/tools/budget.ts`, holds the truncate-to-budget /
summary-substitute / drop-with-reason logic currently duplicated (and broken) across
`compose.ts`, `read.ts`, and `grep.ts`. `compose.ts` is refactored to call it (behavior-preserving
— its existing test suite is the regression check). `read.ts` and `grep.ts` are fixed to call it
too, which is the actual bug fix (chunk 0 is no longer exempt; grep gets real budget enforcement
for the first time). Graph durability is preserved throughout: nodes are always stored with full,
untruncated content — only the text *returned to the caller* is budget-limited.

**Tech Stack:** TypeScript, Bun (`bun test`), existing `bun:sqlite`-backed test fixtures.

**Full design context:** `docs/superpowers/specs/2026-08-19-read-grep-token-budget-fix-design.md`
(read that first if anything below is unclear about *why*, not just *what*).

---

## Task 1: Shared budget helper (`mcp/src/tools/budget.ts`)

**Files:**
- Create: `mcp/src/tools/budget.ts`
- Test: `mcp/src/tools/budget.test.ts`

This is a pure extraction of `compose.ts`'s existing per-item loop (lines 90-115 of the current
file) into a standalone, store-agnostic function. Write it test-first even though the logic is
copied from working code — the tests lock in the exact truncation-threshold behavior (the `budget
< 50` cliff between "truncate" and "drop") so a future change to this file can't silently break it.

- [ ] **Step 1: Write the failing tests**

```ts
// mcp/src/tools/budget.test.ts
import { describe, test, expect } from 'bun:test';
import { applyBudget } from './budget';

const LONG = (n: number) => Array(n).fill('word').join(' ');

describe('applyBudget', () => {
  test('includes items that fit within budget', () => {
    const result = applyBudget([{ id: 'a', content: LONG(5) }], 100, 'raw');
    expect(result.manifest.included).toEqual(['a']);
    expect(result.manifest.dropped).toHaveLength(0);
  });

  test('truncates an item that exceeds remaining budget when budget is still >= 50', () => {
    const result = applyBudget([{ id: 'big', content: LONG(200) }], 60, 'raw');
    expect(result.manifest.included).toEqual(['big']);
    expect(result.parts[0].length).toBeLessThanOrEqual(60 * 4);
  });

  test('drops an item when remaining budget falls below 50 tokens', () => {
    const result = applyBudget([{ id: 'big', content: LONG(200) }], 10, 'raw');
    expect(result.manifest.included).toHaveLength(0);
    expect(result.manifest.dropped).toEqual([{ id: 'big', reason: 'over_budget' }]);
  });

  test('mixed format substitutes summary when content exceeds budget', () => {
    const result = applyBudget(
      [{ id: 'x', content: LONG(200), summary: 'short summary' }],
      60,
      'mixed',
    );
    expect(result.manifest.included).toEqual(['x']);
    expect(result.manifest.summary_substituted).toEqual(['x']);
    expect(result.parts[0]).toBe('short summary');
  });

  test('mixed format with no summary drops with over_budget_no_summary reason', () => {
    const result = applyBudget([{ id: 'x', content: LONG(200) }], 10, 'mixed');
    expect(result.manifest.dropped).toEqual([{ id: 'x', reason: 'over_budget_no_summary' }]);
  });

  test('outline format uses item.outline text instead of content', () => {
    const result = applyBudget(
      [{ id: 'x', content: 'full body content here', outline: 'x: short preview' }],
      500,
      'outline',
    );
    expect(result.parts[0]).toBe('x: short preview');
  });

  test('marks items with sourceTruncated as truncated in the manifest', () => {
    const result = applyBudget([{ id: 'x', content: LONG(10), sourceTruncated: true }], 500, 'raw');
    expect(result.manifest.truncated).toEqual(['x']);
  });

  test('remaining budget decreases across items in order', () => {
    const result = applyBudget(
      [{ id: 'a', content: LONG(20) }, { id: 'b', content: LONG(20) }],
      25,
      'raw',
    );
    // 'a' consumes ~25 tokens exactly, leaving 0 remaining (< 50) so 'b' must drop.
    expect(result.manifest.included).toEqual(['a']);
    expect(result.manifest.dropped.map(d => d.id)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && bun test src/tools/budget.test.ts`
Expected: FAIL — `Cannot find module './budget'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// mcp/src/tools/budget.ts
export type BudgetFormat = 'raw' | 'outline' | 'mixed';

export interface BudgetItem {
  id: string;
  content: string;
  summary?: string;
  outline?: string;
  sourceTruncated?: boolean;
}

export interface BudgetDropped {
  id: string;
  reason: 'over_budget' | 'over_budget_no_summary';
}

export interface BudgetManifest {
  included: string[];
  dropped: BudgetDropped[];
  truncated: string[];
  summary_substituted?: string[];
}

export interface BudgetResult {
  parts: string[];
  manifest: BudgetManifest;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MIN_BUDGET_FOR_TRUNCATION = 50;

export function applyBudget(
  items: BudgetItem[],
  budgetTokens: number,
  format: BudgetFormat = 'raw',
): BudgetResult {
  let budget = budgetTokens;
  const included: string[] = [];
  const dropped: BudgetDropped[] = [];
  const truncated: string[] = [];
  const summary_substituted: string[] = [];
  const parts: string[] = [];

  for (const item of items) {
    let text = format === 'outline' && item.outline !== undefined ? item.outline : item.content;
    const usesSummary = format === 'mixed' && !!item.summary && item.summary.length < item.content.length;
    if (usesSummary) {
      text = item.summary!;
      summary_substituted.push(item.id);
    }

    const tokens = estimateTokens(text);
    if (tokens > budget) {
      if (budget < MIN_BUDGET_FOR_TRUNCATION) {
        if (format === 'mixed' && !item.summary) {
          dropped.push({ id: item.id, reason: 'over_budget_no_summary' });
        } else {
          dropped.push({ id: item.id, reason: 'over_budget' });
        }
        continue;
      }
      const chars = budget * 4;
      text = text.slice(0, chars);
    }
    budget -= estimateTokens(text);
    included.push(item.id);
    if (item.sourceTruncated) truncated.push(item.id);
    parts.push(text);
  }

  return {
    parts,
    manifest: {
      included,
      dropped,
      truncated,
      ...(summary_substituted.length ? { summary_substituted } : {}),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && bun test src/tools/budget.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/budget.ts mcp/src/tools/budget.test.ts
git commit -m "feat(mcp): extract shared budget helper from compose.ts's per-item logic"
```

---

## Task 2: Refactor `compose.ts` to use the shared helper (behavior-preserving)

**Files:**
- Modify: `mcp/src/tools/compose.ts`
- Test: `mcp/src/tools/compose.test.ts` (unchanged — it's the regression check for this task)

No new test is written here — `compose.test.ts`'s 11 existing tests already pin the exact
behavior being extracted. The bar for this task is: after the refactor, every one of those tests
still passes unmodified.

- [ ] **Step 1: Confirm the baseline is green before touching anything**

Run: `cd mcp && bun test src/tools/compose.test.ts`
Expected: PASS — 11 tests green (this is the pre-refactor baseline you'll diff against).

- [ ] **Step 2: Replace `compose.ts`'s inline budget loop with a call to `applyBudget`**

Replace the entire file with:

```ts
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeNode, ComposeManifest } from '../store/types.js';
import { applyBudget, type BudgetItem } from './budget.js';

export interface ComposeParams {
  node_ids: string[];
  budget_tokens: number;
  format?: 'raw' | 'outline' | 'mixed';
  query?: string;
  depth?: number;
}

export interface ComposeResult {
  content: string;
  manifest: ComposeManifest;
}

function scoreNode(
  node: CtxTreeNode,
  graphDistance: number,
  queryRank: number,
  hasQuery: boolean
): number {
  const wDist = 0.7;
  const wRecency = 0.3;
  const wQuery = hasQuery ? 0.1 : 0.0;
  const ageHours = (Date.now() - node.updated_at) / (1000 * 60 * 60);
  const recencyDecay = Math.exp(-ageHours / 24);
  return wDist * (1 / (1 + graphDistance)) + wRecency * recencyDecay + wQuery * queryRank;
}

function formatOutline(node: CtxTreeNode): string {
  const prefix = `[${node.id}] ${node.kind}: `;
  const suffix = '…';
  const maxPreview = Math.max(0, Math.min(120, node.content.length - prefix.length - suffix.length - 1));
  const preview = node.content.slice(0, maxPreview).replace(/\n/g, ' ');
  return `${prefix}${preview}${suffix}`;
}

export async function ctxTreeCompose(
  store: StoreBackend,
  params: ComposeParams
): Promise<ComposeResult> {
  const { node_ids, budget_tokens, format = 'raw', query } = params;
  const depth = Math.min(params.depth ?? 2, 2);

  const distanceMap = await store.expandGraph(node_ids, depth);
  if (distanceMap.size === 0) {
    return { content: '', manifest: { included: [], dropped: [], truncated: [] } };
  }

  const allIds = [...distanceMap.keys()];
  const candidates = await store.getNodesByIds(allIds);

  const ftsRanks = query
    ? await store.getFtsRanks(query, allIds)
    : new Map<string, number>();

  const scored = candidates.map(node => ({
    node,
    score: scoreNode(
      node,
      distanceMap.get(node.id) ?? 0,
      ftsRanks.get(node.id) ?? 0,
      !!query,
    ),
  }));
  scored.sort((a, b) => b.score - a.score);

  const preDropped: ComposeManifest['dropped'] = [];
  const items: BudgetItem[] = [];
  for (const { node } of scored) {
    if (node.status === 'superseded') {
      preDropped.push({ id: node.id, reason: 'superseded' });
      continue;
    }
    if (node.status === 'pruned') {
      preDropped.push({ id: node.id, reason: 'pruned' });
      continue;
    }
    items.push({
      id: node.id,
      content: node.content,
      summary: node.summary ?? undefined,
      outline: format === 'outline' ? formatOutline(node) : undefined,
      sourceTruncated: node.truncated === 1,
    });
  }

  const { parts, manifest } = applyBudget(items, budget_tokens, format);

  return {
    content: parts.join('\n\n'),
    manifest: {
      included: manifest.included,
      dropped: [...preDropped, ...manifest.dropped],
      truncated: manifest.truncated,
      ...(manifest.summary_substituted ? { summary_substituted: manifest.summary_substituted } : {}),
    },
  };
}
```

- [ ] **Step 3: Run the existing compose tests to confirm the refactor is behavior-preserving**

Run: `cd mcp && bun test src/tools/compose.test.ts`
Expected: PASS — same 11 tests green, unmodified. If anything fails, the refactor changed
behavior — fix `compose.ts` to match the original semantics exactly rather than editing the test.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/tools/compose.ts
git commit -m "refactor(mcp): compose.ts uses the shared applyBudget helper"
```

---

## Task 3: Fix `read.ts`'s chunk-0 budget bug (the postmortem's headline defect)

**Files:**
- Modify: `mcp/src/tools/read.ts`
- Test: `mcp/src/tools/read.test.ts`

This is the actual fix for `docs/postmortems/2026-08-18-read-grep-token-regression.md`'s primary
finding. Current buggy code (`read.ts:30-32` and `:203-212`):

```ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
// ...
  const budget = budget_tokens;
  let used = 0;
  const included: Chunk[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const tokens = estimateTokens(chunk.content);
    // Always include at least the first chunk so callers get some content.
    if (i > 0 && used + tokens > budget) break;
    included.push(chunk);
    used += tokens;
  }
```

Design decision locked in: graph durability is preserved — chunks that get selected for
inclusion are **always stored with their full, untruncated content** (unchanged from today).
Only the `content` string *returned to the caller* is budget-limited via `applyBudget`'s
truncation. Write the regression test first, using the exact shape that broke in production: a
file that's essentially one `export class Foo { ...many methods... }`. `treeSitterChunk`'s
`LEAF_TYPES` includes `export_statement` but not `class_declaration`, so `export class` collapses
to a single chunk covering the whole class body — this is precisely why chunk 0 alone can be 10x
the intended budget.

- [ ] **Step 1: Write the failing tests**

Add to `mcp/src/tools/read.test.ts`, inside the existing `describe('ctxTreeRead', ...)` block:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && bun test src/tools/read.test.ts -t "oversized chunk"`
Expected: FAIL — `result.content.length` is far larger than `100 * 4` (reproduces the postmortem's
~10x-oversize finding).

- [ ] **Step 3: Fix `read.ts`**

Remove the local `estimateTokens` function (lines 30-32) and add the import at the top of the
file (after the existing imports):

```ts
import { applyBudget, type BudgetItem } from './budget.js';
```

Replace the budget loop (lines 203-212):

```ts
  const chunkItems: BudgetItem[] = chunks.map((chunk, i) => ({ id: String(i), content: chunk.content }));
  const { parts, manifest } = applyBudget(chunkItems, budget_tokens);
  const included: Chunk[] = manifest.included.map(id => chunks[Number(id)]);
```

Replace the final content assembly (line 283, `const content = included.map(c => c.content).join('\n\n');`):

```ts
  const content = parts.join('\n\n');
```

Everything else in the function — chunking, file-root node creation, the per-chunk node storage
loop at lines 252-281 (which still iterates `included` and still stores `chunk.content`, the full
untruncated text) — is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && bun test src/tools/read.test.ts`
Expected: PASS — all tests green, including the two new ones and the pre-existing ones (the
existing "reads a file and returns content within budget" test at the top of the file should
still pass since it never asserted a cap; verify it doesn't newly break).

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/read.ts mcp/src/tools/read.test.ts
git commit -m "fix(mcp): enforce budget_tokens on chunk 0 in ctx_tree_read

Chunk 0 was unconditionally included regardless of size, so a file
that's essentially one 'export class Foo { ...many methods... }'
(export_statement is a LEAF_TYPES leaf and isn't recursed into) could
return up to ~10x the requested budget. Fixes the primary defect in
docs/postmortems/2026-08-18-read-grep-token-regression.md."
```

---

## Task 4: Add real budget enforcement to `grep.ts`

**Files:**
- Modify: `mcp/src/tools/grep.ts`
- Test: `mcp/src/tools/grep.test.ts`

`grep.ts` currently has no token-budget concept at all — `matches` is returned as the full raw
ripgrep result set, capped only by `maxCount` (a result-*count* limit, not a size limit). Same
durability rule as Task 3: the stored `tool_output`/`file_chunk` nodes keep the full match set;
only the array returned to the caller is budget-limited.

- [ ] **Step 1: Write the failing test**

Add to `mcp/src/tools/grep.test.ts`, inside the existing `describe('ctxTreeGrep', ...)` block:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && bun test src/tools/grep.test.ts -t "caps returned matches"`
Expected: FAIL — `result.matches` contains all 200 matched lines, far over the 50-token budget
(there's no enforcement path for it to hit yet).

- [ ] **Step 3: Fix `grep.ts`**

Add the import at the top of the file:

```ts
import { applyBudget } from './budget.js';
```

Add `budget_tokens` to the params interface:

```ts
export interface GrepParams {
  pattern: string;
  path?: string;
  caseInsensitive?: boolean;
  fileGlob?: string;
  maxCount?: number;
  budget_tokens?: number;
}
```

Update the destructure at the top of `ctxTreeGrep` (currently
`const { pattern, path = '.', caseInsensitive, fileGlob, maxCount = 500 } = params;`):

```ts
  const { pattern, path = '.', caseInsensitive, fileGlob, maxCount = 500, budget_tokens = 2000 } = params;
```

Replace the final `return { nodeId, matches };` with:

```ts
  const { parts: budgetedMatches } = applyBudget(
    matches.map((line, i) => ({ id: String(i), content: line })),
    budget_tokens,
  );

  return { nodeId, matches: budgetedMatches };
```

Everything above this (ripgrep invocation, denylist filtering, `tool_output`/`file_chunk` node
storage, all of which still use the full `matches` array) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && bun test src/tools/grep.test.ts`
Expected: PASS — all tests green, including the new one. The existing "returns matches for a
pattern" test uses no `budget_tokens` override so it gets the new 2000 default, which is large
enough not to affect its single-match assertion.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/grep.ts mcp/src/tools/grep.test.ts
git commit -m "feat(mcp): enforce budget_tokens in ctx_tree_grep

grep.ts previously had no size limit on returned matches, only
maxCount (a result-count cap). Applies the same shared budget helper
read.ts and compose.ts use."
```

---

## Task 5: Wire `budget_tokens` through the MCP server schema/handler for grep

**Files:**
- Modify: `mcp/src/server.ts`

`ctxTreeGrep` now accepts `budget_tokens`, but the MCP tool's advertised schema and the
request handler that calls it don't pass it through yet — an agent calling `ctx_tree_grep`
via MCP has no way to set it.

- [ ] **Step 1: Add `budget_tokens` to the `ctx_tree_grep` tool schema**

In `mcp/src/server.ts`, find the `ctx_tree_grep` tool definition (currently):

```ts
    {
      name: 'ctx_tree_grep',
      description: 'ripgrep integration — search file content by regex pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search' },
          path: { type: 'string', description: 'Path to search within' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
          file_glob: { type: 'string', description: 'File glob filter' },
        },
        required: ['pattern'],
      },
    },
```

Add a `budget_tokens` property matching the style used for `ctx_tree_read` and `ctx_tree_bash`:

```ts
    {
      name: 'ctx_tree_grep',
      description: 'ripgrep integration — search file content by regex pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search' },
          path: { type: 'string', description: 'Path to search within' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
          file_glob: { type: 'string', description: 'File glob filter' },
          budget_tokens: { type: 'number', description: 'Token budget for output (default 2000)' },
        },
        required: ['pattern'],
      },
    },
```

- [ ] **Step 2: Pass `budget_tokens` through the `ctx_tree_grep` request handler**

Find the handler (currently):

```ts
      case 'ctx_tree_grep': {
        const { pattern, path, case_insensitive, file_glob } = args as {
          pattern: string;
          path?: string;
          case_insensitive?: boolean;
          file_glob?: string;
        };
        if (typeof pattern !== 'string') throw new McpError(ErrorCode.InvalidParams, '"pattern" is required and must be a string');
        if (!rgAvailable) throw new McpError(ErrorCode.InvalidParams, '`rg` (ripgrep) is not installed. Install via: brew install ripgrep');
        const result = await ctxTreeGrep(store, config, {
          pattern,
          path,
          caseInsensitive: case_insensitive,
          fileGlob: file_glob,
        });
        return { content: [{ type: 'text', text: result.matches.join('\n') }] };
      }
```

Replace with:

```ts
      case 'ctx_tree_grep': {
        const { pattern, path, case_insensitive, file_glob, budget_tokens } = args as {
          pattern: string;
          path?: string;
          case_insensitive?: boolean;
          file_glob?: string;
          budget_tokens?: number;
        };
        if (typeof pattern !== 'string') throw new McpError(ErrorCode.InvalidParams, '"pattern" is required and must be a string');
        if (!rgAvailable) throw new McpError(ErrorCode.InvalidParams, '`rg` (ripgrep) is not installed. Install via: brew install ripgrep');
        const result = await ctxTreeGrep(store, config, {
          pattern,
          path,
          caseInsensitive: case_insensitive,
          fileGlob: file_glob,
          budget_tokens,
        });
        return { content: [{ type: 'text', text: result.matches.join('\n') }] };
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd mcp && bun run build` (or the project's typecheck script — check `mcp/package.json`'s
`scripts` block for the exact name if `build` doesn't exist; it must run `tsc --noEmit` or
equivalent).
Expected: no new type errors.

- [ ] **Step 4: Run the full test suite as an integration smoke check**

Run: `cd mcp && bun test`
Expected: PASS — everything from Tasks 1-4 plus pre-existing tests, all green.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/server.ts
git commit -m "feat(mcp): expose budget_tokens on the ctx_tree_grep MCP tool"
```

---

## Task 6: Update hook messaging to match reality

**Files:**
- Modify: `hooks/pretooluse-redirect.mjs`

The Read and Grep redirect messages currently promise "Returns identical content" / "Same
ripgrep results" — no longer true now that budget enforcement actually works. There are no
automated tests for this file (it's a standalone hook script parsing stdin JSON); verify by
re-reading the diff.

- [ ] **Step 1: Update the Read redirect message**

In `hooks/pretooluse-redirect.mjs`, find (around line 56-59):

```js
    deny(
      `Use ctx_tree_read instead of Read for "${filePath}".`,
      `Call: ctx_tree_read({ path: ${JSON.stringify(filePath)}${extra} })\n\nReturns identical content. Also symbol-chunks the file, stores nodes in the session graph, and returns nodeIds you can pass to ctx_tree_neighbors to find related code.`,
    );
```

Replace the message text with:

```js
    deny(
      `Use ctx_tree_read instead of Read for "${filePath}".`,
      `Call: ctx_tree_read({ path: ${JSON.stringify(filePath)}${extra} })\n\nReturns content up to budget_tokens (default 2000), truncating large symbols to fit — pass a larger budget_tokens for more. Also symbol-chunks the file, stores full nodes in the session graph, and returns nodeIds you can pass to ctx_tree_neighbors to find related code.`,
    );
```

- [ ] **Step 2: Update the Grep redirect message**

Find (around line 68-71):

```js
  deny(
    `Use ctx_tree_grep instead of Grep.`,
    `Call: ctx_tree_grep({ pattern: ${JSON.stringify(pattern)}${pathArg} })\n\nSame ripgrep results. Stores each match as a graph node so you can revisit via ctx_tree_search or ctx_tree_neighbors without re-running the search.`,
  );
```

Replace the message text with:

```js
  deny(
    `Use ctx_tree_grep instead of Grep.`,
    `Call: ctx_tree_grep({ pattern: ${JSON.stringify(pattern)}${pathArg} })\n\nReturns matches up to budget_tokens (default 2000) — pass a larger budget_tokens for more. Stores every match as a graph node so you can revisit via ctx_tree_search or ctx_tree_neighbors without re-running the search.`,
  );
```

- [ ] **Step 3: Verify by re-reading**

Read the two changed sections back and confirm neither still contains the strings "identical
content" or "Same ripgrep results".

- [ ] **Step 4: Commit**

```bash
git add hooks/pretooluse-redirect.mjs
git commit -m "docs(hooks): stop promising identical/same content from ctx_tree_read/grep"
```

---

## Task 7: Add CI to actually run the test suite

**Files:**
- Create: `.github/workflows/test.yml`

No workflow currently runs `bun test` on push/PR (`.github/workflows/` only has
`docs.yml`/`publish-viz.yml`/`publish-vscode.yml`) — this is how the chunk-0 bug shipped and
merged without any automated check catching it. `grep.test.ts` needs the `rg` binary present,
which isn't preinstalled on GitHub-hosted `ubuntu-latest` runners by default, so it's installed
explicitly.

- [ ] **Step 1: Write the workflow**

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: bun test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install ripgrep
        run: sudo apt-get update && sudo apt-get install -y ripgrep

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bun run test
```

- [ ] **Step 2: Verify the command it runs matches the root script**

Run: `cat package.json | grep '"test"'`
Expected: `"test": "bun test --filter @ctx-tree/mcp"` — confirms `bun run test` in the workflow
resolves to the same command a local contributor would run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run bun test on push/PR to main

No workflow previously ran the test suite automatically — the
chunk-0 budget bug (docs/postmortems/2026-08-18-read-grep-token-regression.md)
merged with ~3,800 lines of tests present but nothing gating on them."
```

---

## Task 8: Caveat the README's reduction claim until Track D re-measures it

**Files:**
- Modify: `README.md`

The README currently states "95–99% context reduction" and a table showing 98.6%/98.1% for
Read/Grep specifically, uniformly, with no distinction between first-pass (currently broken,
per the postmortem) and revisit-via-compose (proven, and where these numbers actually apply).
Don't leave a disproven number live while Task 9's gate is unresolved.

- [ ] **Step 1: Add a caveat under the reduction table**

In `README.md`, find the table (currently ends at):

```
| Operation | Without | With | Saved |
| --------- | ------- | ---- | ----- |
| Read file | ~4,200 tok | ~60 tok | **98.6%** |
| Grep (8 files) | ~8,400 tok | ~160 tok | **98.1%** |
| WebFetch | ~11,000 tok | ~110 tok | **99.0%** |
| MCP tool | ~3,600 tok | ~70 tok | **98.1%** |
```

Add immediately after it:

```
> **Read/Grep note:** these per-operation numbers describe *revisiting* already-captured content
> via `ctx_tree_compose`/`neighbors`/`search`. First-time reads of a file or search results are
> budget-limited (default 2000 tokens) as of [PR link/version — fill in at merge time], not
> pre-truncated to these exact figures — see
> [`docs/postmortems/2026-08-18-read-grep-token-regression.md`](docs/postmortems/2026-08-18-read-grep-token-regression.md)
> for the full investigation and fix.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: caveat Read/Grep reduction numbers pending re-measurement

The 95-99% figures were measured for the compose/revisit path;
first-pass Read/Grep didn't honor budget_tokens at all until this
branch. Link the postmortem so the caveat doesn't go stale silently."
```

---

## Task 9: Port the A/B benchmark harness into this repo

**Files:**
- Create: `bench/ab-explore.sh`
- Create: `bench/task-prompt.md`

The postmortem's A/B comparison only exists as an ad hoc invocation documented in prose, with
transcripts in a session-scoped scratch path that's likely already gone. Recreating it as a
checked-in script makes the go/no-go gate (this plan's actual acceptance test — see the parent
plan's Track D) re-runnable by anyone, not a one-off nobody can reproduce.

This task only creates the scripts — it does **not** run them. Running them makes real, paid
`claude` API calls and produces a result that needs human judgment to interpret against the
pre-registered pass/fail criteria (see Task 10). That's why Task 10 is a separate, manual step
outside subagent-driven-development.

- [ ] **Step 1: Write the task prompt fixture**

```markdown
<!-- bench/task-prompt.md -->
Explore this codebase and summarize four things, using only Read and Grep:

1. The entry point (how the extension/process starts up).
2. The IPC/MessageBroker layer (how messages move between processes).
3. The process manager responsible for spawning/supervising the Claude process.
4. The webview UI layer.

Target 15-25 tool calls total. When done, write a summary of what you found, no more than 300
words, covering all four areas above.
```

- [ ] **Step 2: Write the harness script**

```bash
#!/usr/bin/env bash
# bench/ab-explore.sh — re-run the A/B comparison from
# docs/postmortems/2026-08-18-read-grep-token-regression.md.
#
# Usage: bench/ab-explore.sh <target-repo-path> <output-dir>
#
# Requires: claude CLI on PATH, TARGET_REPO checked out locally.
# Runs two full `claude -p` sessions against TARGET_REPO — each makes real,
# billed API calls. Do not run this in a loop or automated pipeline without
# reviewing cost first (the original pair cost ~$3.79 combined).

set -euo pipefail

TARGET_REPO="${1:?Usage: bench/ab-explore.sh <target-repo-path> <output-dir>}"
OUT_DIR="${2:?Usage: bench/ab-explore.sh <target-repo-path> <output-dir>}"
CTX_TREE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_PROMPT="$(cat "${CTX_TREE_ROOT}/bench/task-prompt.md")"

mkdir -p "${OUT_DIR}"

echo "== Baseline (no ctx-tree) =="
(
  cd "${TARGET_REPO}"
  claude -p "${TASK_PROMPT}" \
    --output-format stream-json --verbose \
    --setting-sources "" \
    --tools "Read,Grep" \
    --dangerously-skip-permissions
) > "${OUT_DIR}/run_baseline.jsonl"

echo "== Treatment (ctx-tree via --plugin-dir) =="
(
  cd "${TARGET_REPO}"
  claude -p "${TASK_PROMPT}" \
    --output-format stream-json --verbose \
    --setting-sources "" \
    --tools "Read,Grep" \
    --dangerously-skip-permissions \
    --plugin-dir "${CTX_TREE_ROOT}"
) > "${OUT_DIR}/run_ctxtree.jsonl"

echo "Done. Transcripts in ${OUT_DIR}/{run_baseline,run_ctxtree}.jsonl"
echo "Compute final context tokens per run via each transcript's last turn's"
echo "cache_read_input_tokens + cache_creation_input_tokens (see the postmortem's"
echo "'Headline numbers' section for the exact method), and check turn count /"
echo "cost / topic completeness against Task 10's pre-registered criteria."
```

- [ ] **Step 3: Make it executable and syntax-check it**

Run: `chmod +x bench/ab-explore.sh && bash -n bench/ab-explore.sh`
Expected: no output from `bash -n` (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add bench/ab-explore.sh bench/task-prompt.md
git commit -m "test: port the postmortem's A/B harness into the repo

Makes the go/no-go re-test (parent plan's Track D) reproducible
instead of a one-off nobody can re-run. Does not run automatically —
see Task 10 in docs/superpowers/plans/2026-08-19-read-grep-token-budget-fix.md."
```

---

## Task 10: Run the go/no-go gate (manual — not part of subagent-driven-development)

**Do not delegate this task to an autonomous subagent.** It spends real API budget on two full
`claude -p` sessions and its outcome requires a judgment call (revisit scope vs. ship) that's
explicitly the maintainer's to make per the parent plan. Run it yourself after Tasks 1-9 are
merged to `main`.

- [ ] **Step 1:** Pick (or re-confirm) the target repo used in the original postmortem run
  (`cc-vscode-ext`) and a scratch output directory, e.g.
  `/tmp/ctx-tree-ab-$(date +%s)`.
- [ ] **Step 2:** Run `bench/ab-explore.sh <target-repo-path> <output-dir>` from this repo's root
  (on `main`, after Tasks 1-9 are merged — not from this worktree/branch, so the run reflects
  what `--plugin-dir` would actually load for a real user).
- [ ] **Step 3:** For each transcript, compute final context tokens
  (`cache_read_input_tokens + cache_creation_input_tokens` from the last turn's usage block),
  turn count, whether all 4 topics were covered, and total cost — same method the postmortem used.
- [ ] **Step 4:** Check against the parent plan's pre-registered criteria: treatment turns ≤
  baseline turns, treatment tokens ≤ baseline tokens, treatment cost ≤ baseline cost, zero wasted
  native-tool-then-redirect round trips.
- [ ] **Step 5a — if it passes:** update the README caveat added in Task 8 with the real measured
  numbers from this run (replacing the `[PR link/version — fill in at merge time]` placeholder
  left there), mark `docs/postmortems/2026-08-18-read-grep-token-regression.md`'s status line as
  resolved with a link to this run's data, and proceed to release per the changelog roadmap.
- [ ] **Step 5b — if it fails:** that's real evidence, not a guess. Bring it back to a
  brainstorming session on next steps (re-scope the project's positioning, or revisit whether to
  shutter) — don't silently ship a claim the re-test just disproved a second time.
