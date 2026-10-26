import type { ChatRequest, ChatResponse, LlmProvider, ToolCall } from './types.ts';

export type MockStep =
  | { kind: 'text'; content: string; stopReason?: 'stop' | 'length' }
  | { kind: 'tools'; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

/**
 * 脚本化的 provider：按预置的步骤依次返回。
 * 用来把「模型怎么反应」变成测试输入，而不是靠真实 API 碰运气。
 */
export function createMockProvider(steps: MockStep[]): LlmProvider & { calls: ChatRequest[] } {
  const queue = [...steps];
  const calls: ChatRequest[] = [];
  let counter = 0;

  return {
    name: 'mock',
    calls,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      calls.push(request);
      const step = queue.shift();
      if (step === undefined) throw new Error('mock provider 的脚本用完了');

      const promptTokens = Math.max(
        1,
        Math.ceil(
          request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
        ),
      );

      if (step.kind === 'text') {
        return {
          message: { role: 'assistant', content: step.content },
          usage: {
            promptTokens,
            completionTokens: Math.ceil(step.content.length / 4),
            cachedTokens: 0,
          },
          stopReason: step.stopReason ?? 'stop',
        };
      }

      const toolCalls: ToolCall[] = step.calls.map((call) => {
        counter += 1;
        return { id: `call_${counter}`, name: call.name, arguments: call.arguments };
      });
      return {
        message: { role: 'assistant', content: '', toolCalls },
        usage: { promptTokens, completionTokens: 40 * toolCalls.length, cachedTokens: 0 },
        stopReason: 'tool_calls',
      };
    },
  };
}
