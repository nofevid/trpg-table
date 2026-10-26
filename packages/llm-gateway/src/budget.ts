import { estimateTokens } from './types.ts';

/**
 * 上下文分段。编号与 DESIGN.md §12.2 一致：
 *   S0 系统提示 / S1 规则摘要 / S2 场景 / S3 记忆 / S4 最近回合 / S5 本批次输入 / S6 工具结果
 */
export type SegmentId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

export interface Segment {
  id: SegmentId;
  text: string;
}

export interface SegmentBudget {
  S0: number;
  S1: number;
  S2: number;
  S3: number;
  S4: number;
  S5: number;
  S6: number;
}

/** 默认分配，合计 12000，与 DESIGN.md 的硬上限一致。 */
export const DEFAULT_SEGMENT_BUDGET: SegmentBudget = {
  S0: 600,
  S1: 300,
  S2: 400,
  S3: 1200,
  S4: 6000,
  S5: 700,
  S6: 2800,
};

/** 降级顺序：先丢工具结果，再砍记忆，最后才动最近回合。S0/S2/S5 永不丢。 */
const TRIM_ORDER: SegmentId[] = ['S6', 'S3', 'S4', 'S1'];

export interface PackedContext {
  text: string;
  used: Record<SegmentId, number>;
  dropped: SegmentId[];
  truncated: SegmentId[];
  totalTokens: number;
  /** 超出 S5 预算、需要顺延到下一批的输入段 */
  deferred: SegmentId[];
}

function truncateToBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/**
 * 按段装填上下文。任何一段都不允许把总量顶过 `hardLimit`：
 * 超了先按 TRIM_ORDER 丢段，还不够就抛错——宁可让调用失败，
 * 也不要在用户不知情的情况下把规则或场景截掉一半。
 */
export function packContext(
  segments: readonly Segment[],
  options: { budget?: SegmentBudget; hardLimit?: number } = {},
): PackedContext {
  const budget = options.budget ?? DEFAULT_SEGMENT_BUDGET;
  const hardLimit = options.hardLimit ?? 12000;

  const used = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0 } as Record<SegmentId, number>;
  const dropped: SegmentId[] = [];
  const truncated: SegmentId[] = [];
  const deferred: SegmentId[] = [];
  const texts = new Map<SegmentId, string>();

  for (const segment of [...segments].sort((a, b) => a.id.localeCompare(b.id))) {
    const cap = budget[segment.id];
    let text = segment.text;

    if (segment.id === 'S5') {
      // 玩家刚说的话，绝不截断：超预算就整段顺延到下一批
      if (estimateTokens(text) > cap) {
        deferred.push('S5');
        continue;
      }
    } else if (estimateTokens(text) > cap) {
      text = truncateToBudget(text, cap);
      truncated.push(segment.id);
    }

    const cost = estimateTokens(text);
    used[segment.id] = cost;
    texts.set(segment.id, text);
  }

  let total = 0;
  for (const text of texts.values()) total += estimateTokens(text);

  for (const id of TRIM_ORDER) {
    if (total <= hardLimit) break;
    const text = texts.get(id);
    if (text === undefined) continue;
    texts.delete(id);
    dropped.push(id);
    total -= estimateTokens(text);
    used[id] = 0;
  }

  if (total > hardLimit) {
    throw new Error(`上下文 ${total} token 超过硬上限 ${hardLimit}，无法安全装填`);
  }

  const ordered: SegmentId[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const parts: string[] = [];
  for (const id of ordered) {
    const text = texts.get(id);
    if (text !== undefined && text !== '') parts.push(text);
  }

  return {
    text: parts.join('\n\n'),
    used,
    dropped,
    truncated,
    totalTokens: total,
    deferred,
  };
}

/** 会话级预算：金额 + 总 token 双闸门。 */
export interface SessionBudget {
  maxCostUsd: number;
  maxTokens: number;
}

function budgetError(message: string): Error {
  return Object.assign(new Error(message), { code: 'BUDGET_EXCEEDED' });
}

export class BudgetGuard {
  readonly #budget: SessionBudget;
  #spentUsd = 0;
  #spentTokens = 0;

  constructor(budget: SessionBudget) {
    this.#budget = budget;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get spentTokens(): number {
    return this.#spentTokens;
  }

  get remainingUsd(): number {
    return this.#budget.maxCostUsd - this.#spentUsd;
  }

  assertCanSpend(estimatedTokens: number, estimatedCostUsd: number): void {
    if (this.#spentTokens + estimatedTokens > this.#budget.maxTokens) {
      throw budgetError('本局 token 预算已用尽');
    }
    if (this.#spentUsd + estimatedCostUsd > this.#budget.maxCostUsd) {
      throw budgetError('本局金额预算已用尽');
    }
  }

  record(tokens: number, costUsd: number): void {
    this.#spentTokens += tokens;
    this.#spentUsd += costUsd;
  }

  /** 剩余比例，用于 UI 的成本条与「接近上限」提示 */
  get usageRatio(): number {
    const byCost = this.#spentUsd / this.#budget.maxCostUsd;
    const byTokens = this.#spentTokens / this.#budget.maxTokens;
    return Math.max(byCost, byTokens);
  }
}
