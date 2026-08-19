import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';
import { shouldDropPath } from '../redaction';
import { DEFAULT_PATH_DENY_GLOBS } from '../redaction/paths';
import { applyBudget } from './budget.js';

export interface GrepParams {
  pattern: string;
  path?: string;
  caseInsensitive?: boolean;
  fileGlob?: string;
  maxCount?: number;
  budget_tokens?: number;
}

export interface GrepResult {
  nodeId: string;
  matches: string[];
}

export async function ctxTreeGrep(
  store: StoreBackend,
  config: CtxTreeConfig,
  params: GrepParams
): Promise<GrepResult> {
  const { pattern, path = '.', caseInsensitive, fileGlob, maxCount = 500, budget_tokens = 2000 } = params;

  if (budget_tokens <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `budget_tokens must be positive, got ${budget_tokens}`);
  }

  const pathDenylistExtra = config.capture.pathDenylistExtra ?? [];

  if (shouldDropPath(path, pathDenylistExtra)) {
    throw new Error(`Path rejected by denylist: ${path}`);
  }

  const args: string[] = ['rg', '--line-number', '--no-heading'];
  if (caseInsensitive) args.push('-i');
  if (fileGlob) args.push('--glob', fileGlob);
  // Exclude denylisted paths at rg level so they are never read.
  for (const glob of [...DEFAULT_PATH_DENY_GLOBS, ...pathDenylistExtra]) {
    args.push('--glob', `!${glob}`);
  }
  args.push('--max-count', String(maxCount));
  args.push('--', pattern, path);

  // Use a generous buffer so large results are truncated in post-processing,
  // not killed with ENOBUFS.
  const spawnBuffer = Math.max(config.capture.maxBytes * 10, 10 * 1024 * 1024);

  let rawOutput = '';
  const result = spawnSync('rg', args.slice(1), {
    maxBuffer: spawnBuffer,
    encoding: 'buffer',
  });

  if (result.status === null) {
    throw new Error(`rg failed to start: ${result.error}`);
  } else if (result.status === 0 || result.status === 1) {
    rawOutput = result.stdout?.toString('utf8') ?? '';
  } else {
    throw new Error(`rg failed with exit code ${result.status}: ${result.stderr?.toString('utf8')}`);
  }

  // Defense-in-depth: post-filter any lines whose file path is denylisted,
  // in case rg glob exclusions don't cover every path form.
  const allMatches = rawOutput.split('\n').filter(Boolean);
  const matches = allMatches.filter(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) return true;
    const filePath = line.slice(0, colonIdx);
    return !shouldDropPath(filePath, pathDenylistExtra);
  });

  const content = matches.join('\n');
  const originalBytes = Buffer.byteLength(content, 'utf8');
  const truncContent = Buffer.from(content).subarray(0, config.capture.maxBytes).toString('utf8');
  const contentHash = createHash('sha256').update(truncContent).digest('hex');
  const nodeId = ulid();

  if (Buffer.byteLength(content, 'utf8') >= config.capture.filterMinSize) {
    await store.insertNode(nodeId, {
      parent_id: null,
      kind: 'tool_output',
      source_uri: `tool:Grep#${contentHash.slice(0, 8)}`,
      content: truncContent,
      content_hash: contentHash,
      status: 'live',
      mtime: 0,
      truncated: originalBytes > config.capture.maxBytes ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ tool: 'Grep', pattern, path }),
    });

    // Build file→lines map in O(matches) instead of O(files × matches).
    const fileMatchMap = new Map<string, string[]>();
    for (const line of matches) {
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const filePath = line.slice(0, colonIdx);
      if (shouldDropPath(filePath, pathDenylistExtra)) continue;
      const rest = line.slice(colonIdx + 1);
      if (!/^\d+:/.test(rest)) continue;
      const arr = fileMatchMap.get(filePath);
      if (arr) arr.push(line);
      else fileMatchMap.set(filePath, [line]);
    }

    for (const [filePath, fileLines] of fileMatchMap) {
      const fileContent = fileLines.join('\n');
      if (Buffer.byteLength(fileContent, 'utf8') < config.capture.filterMinSize) continue;
      const fileHash = createHash('sha256').update(fileContent).digest('hex');
      await store.insertNode(ulid(), {
        parent_id: nodeId,
        kind: 'file_chunk',
        source_uri: `file://${filePath}`,
        content: fileContent,
        content_hash: fileHash,
        status: 'live',
        mtime: 0,
        truncated: 0,
        original_bytes: Buffer.byteLength(fileContent, 'utf8'),
        metadata: JSON.stringify({ tool: 'Grep', pattern, filePath }),
      });
    }
  }

  const { parts: budgetedMatches } = applyBudget(
    matches.map((line, i) => ({ id: String(i), content: line })),
    budget_tokens,
  );

  return { nodeId, matches: budgetedMatches };
}
