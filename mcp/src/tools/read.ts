import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { extname } from 'node:path';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';
import { shouldDropPath } from '../redaction';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { applyBudget, type BudgetItem } from './budget.js';

export interface ReadParams {
  path: string;
  lines?: [number, number];
  budget_tokens?: number;
}

export interface ReadResult {
  nodeIds: string[];
  content: string;
  truncated: boolean;
  chunking: 'treesitter' | 'window';
}

interface Chunk {
  startLine: number;
  endLine: number;
  content: string;
  symbolName: string;
}

function windowChunk(lines: string[], windowSize = 200): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += windowSize) {
    const slice = lines.slice(i, i + windowSize);
    const startLine = i + 1;
    const endLine = i + slice.length;
    chunks.push({ startLine, endLine, content: slice.join('\n'), symbolName: `L${startLine}-${endLine}` });
  }
  return chunks;
}

type TreeSitterLanguage = { [key: string]: unknown };

const LANG_MAP: Record<string, () => Promise<TreeSitterLanguage>> = {
  '.ts': async () => {
    const { typescript } = await import('tree-sitter-typescript');
    return typescript;
  },
  '.tsx': async () => {
    const { tsx } = await import('tree-sitter-typescript');
    return tsx;
  },
  '.js': async () => {
    const defaultExport = await import('tree-sitter-javascript');
    return defaultExport.default;
  },
  '.jsx': async () => {
    const defaultExport = await import('tree-sitter-javascript');
    return defaultExport.default;
  },
  '.py': async () => {
    const defaultExport = await import('tree-sitter-python');
    return defaultExport.default;
  },
  '.rs': async () => {
    const defaultExport = await import('tree-sitter-rust');
    return defaultExport.default;
  },
  '.go': async () => {
    const defaultExport = await import('tree-sitter-go');
    return defaultExport.default;
  },
  '.sh': async () => {
    const defaultExport = await import('tree-sitter-bash');
    return defaultExport.default;
  },
};

async function treeSitterChunk(source: string, lang: TreeSitterLanguage): Promise<Chunk[]> {
  try {
    const { default: Parser } = await import('tree-sitter');
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    const lines = source.split('\n');
    const chunks: Chunk[] = [];

    type TSNode = {
      type: string;
      text: string;
      startPosition: { row: number };
      endPosition: { row: number };
      childCount: number;
      children: TSNode[];
      childForFieldName(field: string): TSNode | null;
    };

    // Classes are containers — recurse into them to capture individual methods.
    const LEAF_TYPES = new Set([
      'function_declaration', 'method_definition',
      'lexical_declaration', 'variable_declaration', 'export_statement',
      'function_definition',
      'function_item', 'struct_item', 'enum_item', 'impl_item',
    ]);

    function extractSymbolName(node: TSNode): string {
      // BFS up to depth 3 to find the declared identifier, even for wrapped nodes
      // like export_statement → lexical_declaration → variable_declarator → name.
      type QItem = { n: TSNode; depth: number };
      const queue: QItem[] = [{ n: node, depth: 0 }];
      while (queue.length > 0) {
        const { n, depth } = queue.shift()!;
        const nameNode = n.childForFieldName('name');
        if (nameNode) return nameNode.text;
        if (depth >= 3) continue;
        for (const child of n.children) {
          if (child.type === 'identifier' || child.type === 'property_identifier') return child.text;
          queue.push({ n: child, depth: depth + 1 });
        }
      }
      return node.type;
    }

    function walk(node: TSNode) {
      if (LEAF_TYPES.has(node.type)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const content = lines.slice(startLine - 1, endLine).join('\n');
        chunks.push({ startLine, endLine, content, symbolName: extractSymbolName(node) });
        return;
      }
      if (node.childCount > 0) {
        for (const child of node.children) walk(child);
      }
    }

    walk(tree.rootNode);
    return chunks.length > 0 ? chunks : windowChunk(lines);
  } catch {
    return windowChunk(source.split('\n'));
  }
}

export async function ctxTreeRead(
  store: StoreBackend,
  config: CtxTreeConfig,
  params: ReadParams
): Promise<ReadResult> {
  const { path, lines, budget_tokens = 2000 } = params;

  if (budget_tokens <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `budget_tokens must be positive, got ${budget_tokens}`);
  }

  if (shouldDropPath(path, config.capture.pathDenylistExtra ?? [])) {
    throw new Error(`Path rejected by denylist: ${path}`);
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `File not found or inaccessible: ${path}`);
  }
  const mtime = Math.round(stat.mtimeMs);
  const ext = extname(path).toLowerCase();

  // Stale any cached reads of this file whose mtime no longer matches.
  await store.markStaleByFilePath(path, mtime);

  let raw = readFileSync(path, 'utf8');
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  let truncated = false;
  if (originalBytes > config.capture.maxBytes) {
    raw = raw.slice(0, config.capture.maxBytes);
    truncated = true;
  }

  const langLoader = LANG_MAP[ext];
  let chunks: Chunk[];
  let chunking: 'treesitter' | 'window';

  if (langLoader) {
    try {
      const lang = await langLoader();
      chunks = await treeSitterChunk(raw, lang);
      chunking = 'treesitter';
    } catch {
      chunks = windowChunk(raw.split('\n'));
      chunking = 'window';
    }
  } else {
    chunks = windowChunk(raw.split('\n'));
    chunking = 'window';
  }

  let lineRange: { start1: number; end1: number } | undefined;
  if (lines) {
    // Schema advertises 0-based lines; internal chunks use 1-based line numbers.
    lineRange = { start1: lines[0] + 1, end1: lines[1] + 1 };
    chunks = chunks.filter(c => c.startLine <= lineRange!.end1 && c.endLine >= lineRange!.start1);
  }

  // When a line range is requested, budget only the slice of each chunk that actually
  // overlaps it — otherwise budget truncation (which always slices from the start of the
  // text it's given) can cut a large chunk before ever reaching a late-lying requested range.
  function budgetableContent(chunk: Chunk): string {
    if (!lineRange) return chunk.content;
    const from = Math.max(lineRange.start1, chunk.startLine);
    const to = Math.min(lineRange.end1, chunk.endLine);
    return chunk.content.split('\n').slice(from - chunk.startLine, to - chunk.startLine + 1).join('\n');
  }

  const chunkItems: BudgetItem[] = chunks.map((chunk, i) => ({ id: String(i), content: budgetableContent(chunk) }));
  const { parts, manifest } = applyBudget(chunkItems, budget_tokens);
  const included: Chunk[] = manifest.included.map(id => chunks[Number(id)]);

  // Get or create the file root node (navigation anchor; parent of all per-chunk nodes).
  const fileRootUri = `file://${path}`;
  let fileRootId: string;
  const cachedRoot = await store.getNodeBySourceUri(fileRootUri);
  if (cachedRoot && cachedRoot.mtime === mtime) {
    fileRootId = cachedRoot.id;
  } else {
    if (cachedRoot) await store.updateNodeStatus(cachedRoot.id, 'stale');
    fileRootId = ulid();
    const emptyHash = createHash('sha256').update('').digest('hex');
    await store.insertNode(fileRootId, {
      parent_id: null,
      kind: 'file_chunk',
      source_uri: fileRootUri,
      content: '',
      content_hash: emptyHash,
      status: 'live',
      mtime,
      truncated: truncated ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ filePath: path, is_file_root: true }),
    });
    if (cachedRoot) await store.insertEdge({ src_id: fileRootId, dst_id: cachedRoot.id, kind: 'supersedes' });
  }

  const nodeIds: string[] = [];

  // Deduplicate symbol names within this read (e.g. two anonymous export_statement nodes).
  // Collisions get a :L<startLine> suffix to keep URIs stable and unique.
  const seenNames = new Set<string>();
  function uniqueSymbolKey(chunk: Chunk): string {
    if (!seenNames.has(chunk.symbolName)) {
      seenNames.add(chunk.symbolName);
      return chunk.symbolName;
    }
    return `${chunk.symbolName}:L${chunk.startLine}`;
  }

  for (const chunk of included) {
    const chunkUri = `file://${path}#${uniqueSymbolKey(chunk)}`;
    const contentHash = createHash('sha256').update(chunk.content).digest('hex');

    const cached = await store.getNodeBySourceUri(chunkUri);
    if (cached && cached.mtime === mtime) {
      nodeIds.push(cached.id);
      continue;
    }

    if (cached) await store.updateNodeStatus(cached.id, 'stale');

    const nodeId = ulid();
    await store.insertNode(nodeId, {
      parent_id: fileRootId,
      kind: 'file_chunk',
      source_uri: chunkUri,
      content: chunk.content,
      content_hash: contentHash,
      status: 'live',
      mtime,
      truncated: truncated ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ filePath: path, chunking, symbolName: chunk.symbolName, chunkCount: chunks.length }),
    });

    if (cached) await store.insertEdge({ src_id: nodeId, dst_id: cached.id, kind: 'supersedes' });

    nodeIds.push(nodeId);
  }

  const content = parts.join('\n\n');
  return { nodeIds, content, truncated, chunking };
}
