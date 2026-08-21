# Design: fix `ctx_tree_read`/`ctx_tree_grep` token-budget enforcement

**Date:** 2026-08-19
**Origin:** `docs/postmortems/2026-08-18-read-grep-token-regression.md` (confirmed, not yet fixed)

## Problem

An A/B test found that enabling ctx-tree **increased** context usage by 16% on a real exploration
task and left it incomplete, instead of reducing it as advertised. Two causes, both traced to the
same underlying gap:

1. `mcp/src/tools/read.ts:203-211`'s budget loop exempts chunk 0 from the budget check
   (`if (i > 0 && used + tokens > budget) break`), so an oversized first chunk — e.g. a file that's
   essentially one `export class Foo { ...many methods... }`, which `treeSitterChunk`'s
   `LEAF_TYPES` treats as a single non-recursed leaf — is included whole regardless of size. One
   observed call returned ~10x the target file's actual size.
2. `mcp/src/tools/grep.ts` has no budget concept at all — `matches` is returned as the full raw
   ripgrep result set, capped only by `maxCount` (a result-count limit, not a size limit).

Both are instances of the same missing piece: `mcp/src/tools/compose.ts` already implements
correct per-item budget enforcement (fits budget → return full; over budget → truncate-to-budget
or substitute a summary; else drop with a reason) — but only for *revisited* nodes via
`compose`/`neighbors`/`search`. `read.ts` and `grep.ts` never run their output through it, so every
first-pass call (which is nearly all of them, in a real exploration task) returns unbounded raw
content. Confirmed: `read.ts`'s `budget_tokens` already defaults to 2000
(`const { path, lines, budget_tokens = 2000 } = params;`, line 152) and
`hooks/pretooluse-redirect.mjs`'s Read redirect never overrides it — so this default is exactly
what real first-pass reads see today, and it is not being honored.

## Goals

- `ctx_tree_read` and `ctx_tree_grep` enforce `budget_tokens` on every chunk/match, including the
  first, using the same logic `compose.ts` already uses and already tests well.
- No new API surface: a caller that wants more content already has the lever (`budget_tokens`) —
  it just needs to actually work.
- Hook messaging stops promising "identical content" once that's no longer true.

## Non-goals

- No new "detail level" / "expand" parameter. Rejected during brainstorming: the existing
  `budget_tokens` param already serves that purpose once per-item enforcement is real.
- No redesign of `compose.ts` itself — it's already correct and well-tested; it's the source of
  truth being extracted, not touched behaviorally.
- No attempt in this spec to fix the "3 wasted native-tool-then-redirect round trips" issue from
  the postmortem — tracked separately in Track D of the parent plan as an acceptance-gate check,
  not a code change scoped here.

## Design

### Shared budget helper (`mcp/src/tools/budget.ts`, new)

Extract `compose.ts`'s existing per-item budget logic into a standalone function:

```ts
interface BudgetItem {
  id: string;
  content: string;
  summary?: string;
}
interface BudgetResult {
  included: Array<BudgetItem & { truncated?: boolean }>;
  manifest: Array<{ id: string; reason: 'included' | 'truncated' | 'summarized' | 'over_budget' | 'over_budget_no_summary' }>;
}
function applyBudget(items: BudgetItem[], budgetTokens: number, estimateTokens: (s: string) => number): BudgetResult
```

Behavior mirrors `compose.ts`'s current per-node loop exactly (same truncate-to-`budget * 4`-chars
math, same summary-substitution fallback, same drop-with-reason manifest entries) — this is a pure
extraction, not new logic. `compose.ts` is refactored to call it instead of inlining the loop.

### `read.ts`

Replace the current inclusion loop (lines 203-211) with: build the full `chunks` list as today
(chunking logic is unchanged — only the budget-inclusion step changes), then call
`applyBudget(chunks, budget_tokens, estimateTokens)` and assemble `content` from `included` the
same way as today (`.map(c => c.content).join('\n\n')`). Chunk 0 is no longer special-cased.

### `grep.ts`

Add `budget_tokens?: number` to the tool's input. After the existing `maxCount`-based ripgrep
result limiting (unchanged — still the first-pass filter on match *count*), map matches to
`BudgetItem`s (one per match line) and run them through `applyBudget` before returning, so total
returned match content is now token-bounded, not just count-bounded. Default `budget_tokens` for
grep: 2000, matching `read.ts`'s default for consistency.

### `hooks/pretooluse-redirect.mjs`

Update the Read redirect's injected message (line 58) from "Returns identical content" to
something accurate, e.g. "Returns content up to budget_tokens (default 2000), truncating or
summarizing large symbols — pass a larger budget_tokens for more." Same update for Grep's "Same
ripgrep results" (line 70).

## Testing

- `budget.test.ts` (new, or relocate `compose.test.ts`'s relevant cases): unit tests for the
  extracted helper's truncate / summarize / drop paths, independent of read/grep/compose.
- `read.test.ts`: add a test asserting returned content length stays within `budget_tokens` (the
  existing budget-tagged test only checks content presence, never the cap — this is the direct
  regression test for the postmortem's headline bug). Add a fixture file shaped like
  `ClaudeProcessManager.ts` (one large `export class` with several methods) to lock in the fix for
  the exact reported scenario.
- `grep.test.ts`: add a test with a pattern producing many/large matches, asserting the returned
  result stays within `budget_tokens`.
- `compose.test.ts`: unchanged behaviorally; adjust imports if the loop it tests moves into the
  shared helper (should still pass without modification if the refactor is behavior-preserving).

## Rollout

Ship alongside a CI workflow that actually runs the test suite on PR (none exists today — see
parent plan's Track A/B CI item), a caveat on the README's "95-99% reduction" claim until the
parent plan's Track D re-test produces real replacement numbers, and the Track D A/B re-run itself
as the acceptance gate for the whole effort. Those are tracked in the parent plan
(`docs/superpowers/plans/` — written next) rather than duplicated here.
