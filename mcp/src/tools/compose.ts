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
