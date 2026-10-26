import { BudgetGuard } from './budget.ts';
import {
  costOf,
  DEFAULT_PRICING,
  type ChatMessage,
  type ChatResponse,
  type LlmProvider,
  type Pricing,
  type ToolCall,
  type ToolSchema,
  type Usage,
} from './types.ts';

/** 与 tools 包的 ToolOutcome 结构一致，但用结构类型解耦，避免两个包互相依赖。 */
export type ToolOutcomeLike =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; hint?: string };

export type ToolExecutor = (call: ToolCall) => Promise<ToolOutcomeLike>;

export interface ToolLoopOptions {
  provider: LlmProvider;
  messages: readonly ChatMessage[];
  tools: readonly ToolSchema[];
  executeTool: ToolExecutor;
  /** 默认 6：够完成「查场景 → 检定 → 再查一次」的往返，再长就是模型在打转 */
  maxSteps?: number;
  guard?: BudgetGuard;
  pricing?: Pricing;
  temperature?: number;
  maxTokens?: number;
  onStep?: (step: number, response: ChatResponse) => void;
}

export interface ToolLoopResult {
  messages: ChatMessage[];
  steps: number;
  stopReason: 'done' | 'step_limit' | 'budget_exceeded' | 'error';
  usage: Usage;
  costUsd: number;
  toolInvocations: number;
  toolFailures: number;
}

const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

/**
 * 工具循环（DESIGN.md §10.4 Mode B）。
 *
 * 三条刻意的设计：
 *   1. **工具失败不抛给调用方**，而是作为 tool 消息回灌给模型——模型看到
 *      `SKILL_UNKNOWN` 才能自我修正；直接抛错就变成「玩家说不出话」。
 *   2. **步数硬上限**，到点就停，把已有的 assistant 文本作为结果返回。
 *   3. **每步之前查预算**，超了立刻停，不会为了写完一段叙述把整局的钱花光。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxSteps = options.maxSteps ?? 6;
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const messages: ChatMessage[] = [...options.messages];
  const usage: Usage = { ...ZERO_USAGE };
  let costUsd = 0;
  let steps = 0;
  let toolInvocations = 0;
  let toolFailures = 0;

  while (steps < maxSteps) {
    if (options.guard !== undefined) {
      try {
        options.guard.assertCanSpend(1000, 0.002);
      } catch {
        return { messages, steps, stopReason: 'budget_exceeded', usage, costUsd, toolInvocations, toolFailures };
      }
    }

    const response = await options.provider.chat({
      messages,
      tools: [...options.tools],
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 900,
      responseFormat: 'json',
    });

    usage.promptTokens += response.usage.promptTokens;
    usage.completionTokens += response.usage.completionTokens;
    usage.cachedTokens += response.usage.cachedTokens;
    const stepCost = costOf(response.usage, pricing);
    costUsd += stepCost;
    options.guard?.record(
      response.usage.promptTokens + response.usage.completionTokens,
      stepCost,
    );

    messages.push(response.message);
    steps += 1;
    options.onStep?.(steps, response);

    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      return { messages, steps, stopReason: 'done', usage, costUsd, toolInvocations, toolFailures };
    }

    for (const call of calls) {
      toolInvocations += 1;
      let outcome: ToolOutcomeLike;
      try {
        outcome = await options.executeTool(call);
      } catch (error) {
        outcome = {
          ok: false,
          code: 'TOOL_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!outcome.ok) toolFailures += 1;

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(outcome),
      });
    }
  }

  return { messages, steps, stopReason: 'step_limit', usage, costUsd, toolInvocations, toolFailures };
}
