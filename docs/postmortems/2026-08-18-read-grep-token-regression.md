# Postmortem: ctx-tree A/B test shows net-negative token usage on first-pass Read/Grep

**Date:** 2026-08-18
**Status:** confirmed, not yet fixed
**Severity:** defeats the plugin's core value proposition for exploration-style tasks

## Summary

An A/B test comparing a real exploration task with ctx-tree enabled vs. disabled found that
enabling ctx-tree **increased** context usage by 16% and left the task incomplete, instead of
reducing token usage as intended. Root cause: `ctx_tree_read`/`ctx_tree_grep` return full raw
content on first capture (by design, per the redirect hook's own message to the model) rather
than a compact reference — the compact-reference savings only apply on *revisit* via
`ctx_tree_compose`/`neighbors`/`search`, which never fires during a normal first-pass
exploration task. On top of that, `mcp/src/tools/read.ts`'s `budget_tokens` parameter is not a
real upper bound: one call returned ~10x a file's actual on-disk size despite a `budget_tokens`
request roughly 4x smaller than what was returned.

## Setup

Same read-only exploration task, run twice via `claude -p --output-format stream-json --verbose
--setting-sources "" --tools "Read,Grep" --dangerously-skip-permissions` against the real
`cc-vscode-ext` codebase:

- **Baseline**: nothing else loaded (`--setting-sources ""` gives a clean plugin-free run —
  ctx-tree isn't registered in `~/.claude/settings.json` by default, so "disabled" needed no
  toggling).
- **Treatment**: same command + `--plugin-dir /Users/joe/github/joeblackwaslike/ctx-tree`
  (ephemeral load, zero changes to real config).

Same model both runs (`claude-opus-5[1m]`, 1M context window) — rules out a model-selection
confound. Task: explore 4 specific areas of the codebase (entry point, IPC/MessageBroker,
ClaudeProcessManager, webview UI) using only Read/Grep, target 15-25 tool calls, write a
≤300-word summary.

Context size at each point = `cache_read_input_tokens + cache_creation_input_tokens` from each
turn's real API usage block — exact, not a `chars/4` estimate. Raw transcripts (as of this
writing) at
`/private/tmp/claude-501/-Users-joe-github-joeblackwaslike-anti-compact/41721d64-36f5-4fa9-87f6-bdff624bf415/scratchpad/ctxtree-ab/{run_baseline,run_ctxtree}.jsonl`
— a session-scoped scratch path, likely not durable; re-run the harness described below if these
are gone.

## Headline numbers

| | baseline | ctx-tree |
|---|---|---|
| tool calls | 12 (Read/Grep) | 11 (3 denied-native + 8 `ctx_tree_*`) |
| turns | 13, all 4 topics covered | 12, **stopped early** (`error_max_budget_usd`) — topic 4 (webview UI) never reached |
| final context tokens | 130,067 | **151,024 (+16%)** |
| cost | $1.76 | $2.03 |

ctx-tree used more context, cost more, and finished less of the task.

## The smoking gun: budget_tokens is not honored, and content can exceed the real file

`ClaudeProcessManager.ts` is **4,708 bytes / 136 lines on disk** (verified via `wc -c -l`). In
the baseline run, native `Read` on that exact file returned **5,144 chars** — correct, matches
the file. In the ctx-tree run, `ctx_tree_read({path: ".../ClaudeProcessManager.ts",
budget_tokens: 4500})` returned **47,394 chars** — roughly **10x the file's real size**, and
~2.6x over even the requested 4,500-token budget (~18,000 chars). That single call alone added
+30,536 tokens to context (118,165 → 148,701 cumulative).

By contrast, the same run's `ctx_tree_read` on `MessageBroker.ts` with `budget_tokens: 6000`
returned 14,467 chars — *under* budget, fine. So `budget_tokens` isn't universally ignored;
something file-specific blew past it by an order of magnitude for this one file.

## Two confirmed, code-level causes

### 1. Design intent, not a bug — but it defeats the point for first-pass exploration

The `PreToolUse` hook that redirects `Read` → `ctx_tree_read` says this directly in its own
denial message (`hooks/pretooluse-redirect.mjs`, the `deny()` call for Read):

> "Returns identical content. Also symbol-chunks the file, stores nodes in the session graph,
> and returns nodeIds..."

And for Grep: "Same ripgrep results." The compact-reference behavior (the 95-99% reduction the
README advertises) only exists in `ctx_tree_compose`/`neighbors`/`search`
(`mcp/src/tools/compose.ts`) — tools for *revisiting* already-captured nodes.
`ctx_tree_read`/`ctx_tree_grep` are explicitly documented, by the plugin's own hook, to return
full content on first capture. An exploration task is almost entirely first-passes, so the
savings mechanism never triggers.

### 2. A real budget-enforcement gap in `mcp/src/tools/read.ts:203-211`

```js
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

Chunk 0 is **always** included regardless of its own size — the budget check only applies
starting at `i > 0`. `budget_tokens` is therefore not an upper bound; it's "stop adding *more*
once already over." A single oversized first chunk can blow past it unbounded.

`treeSitterChunk`'s `LEAF_TYPES` set treats `export_statement` as a leaf and does not recurse
into it (`read.ts:120-127`), so a file that's essentially one `export class Foo { ...many
methods... }` collapses to a **single chunk spanning the whole class body** — chunk 0,
unconditionally included, full size. That mechanism explains "budget ignored, full file
returned" but not the **10x-larger-than-the-actual-file** part specifically, which wasn't fully
pinned down in this investigation. Two things worth checking before trusting either explanation:

- Whether `chunks` for this file contained more than one entry overlapping in source range.
  `walk()` `return`s after pushing a `LEAF_TYPES` chunk, which *should* prevent double-capture of
  nested methods — but this was verified only by static reading, not by instrumenting a live
  call.
- Whether the per-project SQLite store (`~/.ctx-tree/<hash>/store.db`) had any node accumulation
  across the 8 `ctx_tree_*` calls in that one 12-turn run that could compound into a later call's
  returned content. `ctxTreeRead`'s `content` variable appears to be built only from `included`
  chunks computed fresh each call per the code read during this investigation, so accumulation
  looks unlikely — but this is not ruled out empirically.

**Reproduction recipe:** call `ctx_tree_read({path:
"/Users/joe/github/joeblackwaslike/cc-vscode-ext/src/process/ClaudeProcessManager.ts",
budget_tokens: 4500})` against a clean/fresh store, and log `chunks.length`, each chunk's
`startLine`/`endLine`/`content.length`, and `included.length` right before the `for (const chunk
of included)` loop at `read.ts:252`. That will show directly whether it's one oversized chunk or
several overlapping ones.

## The other confirmed problem: 3 wasted round trips

Despite the `SessionStart` hook explicitly instructing the model to prefer `ctx_tree_*` tools
from turn one, the model still attempted native `Read`/`Grep` 3 times in the ctx-tree run before
the hook denied and redirected it — each a fully wasted round trip (deny response → redirect
instruction → re-issue as `ctx_tree_*`). Visible directly in the transcript as `is_error: true`
tool_results with tiny content (34, 34, 105 chars) followed immediately by the equivalent
`ctx_tree_*` call.

## Recommendation

No-go on relying on ctx-tree for context-rot mitigation as it currently behaves. The mechanism
that would justify it (compact references instead of raw content) doesn't fire on the read path
that dominates real exploration work, and there's a genuine budget-enforcement bug making a
`budget_tokens` request meaningless in at least one observed case.

Concrete fixes worth prioritizing, in order of expected impact:

1. Cap chunk 0's own size against the budget instead of including it unconditionally
   (`read.ts:207-211`) — e.g. truncate an oversized first chunk to the budget rather than
   returning it whole.
2. Make `ctx_tree_read`/`ctx_tree_grep` return a compact reference on *first* capture too, not
   only on revisit via `compose` — since that's the behavior the hook's own denial message
   already promises the model ("Returns identical content").
3. Instrument/trace the specific 10x-oversize case on `ClaudeProcessManager.ts` per the
   reproduction recipe above, since the two hypothesized mechanisms above don't fully account for
   it on their own.

## Origin

Produced from an A/B test run during a cross-repo investigation into preventing context rot in
long-running Claude Code sessions (anti-compact / cc-vscode-ext / ctx-tree), 2026-08-17/18. See
that investigation's plan and outputs in the `anti-compact` and `cc-vscode-ext` repos for
context on why ctx-tree was being evaluated as a candidate mitigation.
