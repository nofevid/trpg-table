import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BudgetGuard,
  costOf,
  DEFAULT_SEGMENT_BUDGET,
  estimateTokens,
  packContext,
  runToolLoop,
} from '../src/index.ts';
import { createMockProvider } from '../src/index.ts';

test('token 估算：中文按字、拉丁按 4 字符', () => {
  assert.equal(estimateTokens('你好'), 2);
  assert.equal(estimateTokens('hello world'), 3);
  assert.ok(estimateTokens('林晚推开礼拜堂的门，正午的光从彩窗斜射进来') > 20);
});

test('上下文按段装填并在超预算时截断', () => {
  const packed = packContext([
    { id: 'S0', text: '你是克苏鲁的呼唤守秘人。'.repeat(3) },
    { id: 'S5', text: '我冲向圣器室的门。' },
  ]);

  assert.ok(packed.totalTokens > 0);
  assert.equal(packed.used.S5, estimateTokens('我冲向圣器室的门。'));
  assert.deepEqual(packed.dropped, []);
});

test('S5 超预算时整段顺延，绝不截断玩家的话', () => {
  const longInput = '我'.repeat(2000);
  const packed = packContext([
    { id: 'S0', text: '系统' },
    { id: 'S5', text: longInput },
  ]);

  assert.deepEqual(packed.deferred, ['S5']);
  assert.equal(packed.used.S5, 0);
  assert.ok(!packed.text.includes(longInput));
});

test('总量超硬上限时按 S6 → S3 → S4 → S1 的次序丢弃', () => {
  const big = '记'.repeat(4000);
  const packed = packContext(
    [
      { id: 'S0', text: '系统' },
      { id: 'S2', text: '场景' },
      { id: 'S3', text: big },
      { id: 'S6', text: big },
    ],
    { hardLimit: 1000 },
  );

  assert.ok(packed.totalTokens <= 1000);
  assert.ok(packed.dropped.includes('S6'));
  assert.ok(packed.dropped.includes('S3'));
  assert.ok(!packed.dropped.includes('S0'));
  assert.ok(!packed.dropped.includes('S2'));
});

test('成本按缓存价与输出现价分别计', () => {
  const cost = costOf({ promptTokens: 10_000, completionTokens: 1_000, cachedTokens: 6_000 });
  // 4000 fresh × 0.6/M + 6000 cached × 0.08/M + 1000 out × 2.4/M
  const expected = (4000 / 1e6) * 0.6 + (6000 / 1e6) * 0.08 + (1000 / 1e6) * 2.4;
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test('预算守卫拒绝超额并在记录后收紧', () => {
  const guard = new BudgetGuard({ maxCostUsd: 0.01, maxTokens: 1000 });
  assert.doesNotThrow(() => guard.assertCanSpend(500, 0.005));

  guard.record(600, 0.006);
  assert.ok(guard.usageRatio > 0.5);
  assert.throws(() => guard.assertCanSpend(500, 0.0001), /token 预算已用尽/);
  assert.throws(() => guard.assertCanSpend(1, 0.01), /金额预算已用尽/);
});

test('工具循环：调用工具后带结果再问一次，最终给出叙述', async () => {
  const provider = createMockProvider([
    { kind: 'tools', calls: [{ name: 'get_scene', arguments: {} }] },
    { kind: 'text', content: '林晚推开礼拜堂的门。' },
  ]);

  const seen: string[] = [];
  const result = await runToolLoop({
    provider,
    messages: [{ role: 'user', content: '我推开门。' }],
    tools: [],
    executeTool: async (call) => {
      seen.push(call.name);
      return { ok: true, result: { sceneId: 'sc_chapel', name: '礼拜堂' } };
    },
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.steps, 2);
  assert.deepEqual(seen, ['get_scene']);
  assert.equal(result.toolInvocations, 1);
  assert.equal(result.toolFailures, 0);
  assert.equal(result.messages.at(-1)?.content, '林晚推开礼拜堂的门。');

  // 工具结果以 tool 消息回灌
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage !== undefined);
  assert.match(toolMessage.content, /礼拜堂/);
});

test('工具失败回灌给模型而不是抛错', async () => {
  const provider = createMockProvider([
    { kind: 'tools', calls: [{ name: 'roll_check', arguments: { actor: 'x', skill: '口才' } }] },
    { kind: 'text', content: '（换个技能再试）' },
  ]);

  const result = await runToolLoop({
    provider,
    messages: [{ role: 'user', content: '我想说服他。' }],
    tools: [],
    executeTool: async () => ({
      ok: false,
      code: 'INVALID_ARGS',
      message: 'skill 只能是以下之一：潜行 / 侦查',
      hint: '修正参数后重试。',
    }),
  });

  assert.equal(result.toolFailures, 1);
  assert.equal(result.stopReason, 'done');
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage !== undefined);
  assert.match(toolMessage.content, /INVALID_ARGS/);
});

test('步数硬上限：模型反复调工具时到点即停', async () => {
  const provider = createMockProvider(
    Array.from({ length: 10 }, () => ({
      kind: 'tools' as const,
      calls: [{ name: 'get_scene', arguments: {} }],
    })),
  );

  const result = await runToolLoop({
    provider,
    messages: [{ role: 'user', content: '看看四周。' }],
    tools: [],
    maxSteps: 3,
    executeTool: async () => ({ ok: true, result: {} }),
  });

  assert.equal(result.steps, 3);
  assert.equal(result.stopReason, 'step_limit');
  assert.equal(result.toolInvocations, 3);
});

test('预算耗尽时立即停止，不再发起调用', async () => {
  const guard = new BudgetGuard({ maxCostUsd: 0.0001, maxTokens: 10 });
  guard.record(10, 0.0001);

  const provider = createMockProvider([{ kind: 'text', content: '不该到这里' }]);
  const result = await runToolLoop({
    provider,
    messages: [{ role: 'user', content: '继续。' }],
    tools: [],
    guard,
    executeTool: async () => ({ ok: true, result: {} }),
  });

  assert.equal(result.stopReason, 'budget_exceeded');
  assert.equal(result.steps, 0);
  assert.equal(provider.calls.length, 0);
});

test('默认段预算合计等于硬上限', () => {
  const sum = Object.values(DEFAULT_SEGMENT_BUDGET).reduce((a, b) => a + b, 0);
  assert.equal(sum, 12000);
});
