export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant 发起工具调用时携带 */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时指向哪一次调用 */
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 子集，由 ToolRegistry.manifest() 转换而来 */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature: number;
  maxTokens: number;
  /** 结构化输出要求（叙述返回 public/privates 时用） */
  responseFormat?: 'text' | 'json';
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: Usage;
  stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface LlmProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** 价目（美元 / 百万 token），对齐 DESIGN.md §14.2 的估算口径。 */
export interface Pricing {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

export const DEFAULT_PRICING: Pricing = {
  inputPerM: 0.6,
  cachedInputPerM: 0.08,
  outputPerM: 2.4,
};

export function costOf(usage: Usage, pricing: Pricing = DEFAULT_PRICING): number {
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (fresh / 1_000_000) * pricing.inputPerM +
    (usage.cachedTokens / 1_000_000) * pricing.cachedInputPerM +
    (usage.completionTokens / 1_000_000) * pricing.outputPerM
  );
}

/**
 * token 估算。不引 tokenizer：
 *   - 中文字符按 1 token 计（实际 BPE 多在 1–1.5 之间，偏保守）；
 *   - 拉丁文字按 4 字符 1 token；
 *   - 只用来做预算守卫，不用来计费（计费读 provider 返回的真实 usage）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content);
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
      }
    }
  }
  return total;
}
