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
