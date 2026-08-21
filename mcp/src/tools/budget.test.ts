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

  test('outline format falls back to content when item.outline is not provided', () => {
    const result = applyBudget([{ id: 'x', content: 'body only, no outline' }], 500, 'outline');
    expect(result.parts[0]).toBe('body only, no outline');
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
