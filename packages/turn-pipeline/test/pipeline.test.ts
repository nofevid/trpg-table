import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockProvider } from '../../llm-gateway/src/index.ts';
import { createSeededRandom } from '../../rules-core/src/index.ts';
import { ToolRegistry } from '../../tools/src/index.ts';
import { createCoc7eTools } from '../../tools/src/index.ts';
import type { TurnBatch } from '../../turn-batcher/src/index.ts';
import { mergeSupplement, parseLlmOutput, runTurn } from '../src/index.ts';

function makeBatch(seats: string[], sceneId = 'sc_chapel'): TurnBatch {
  return {
    batchId: 'b_1',
    turnId: 't_1',
    sceneId,
    frozenAt: 0,
    inputs: seats.map((seatId, index) => ({
      seatId,
      sceneId,
      clientTurnId: `ct_${index + 1}`,
      text: `${seatId} 的行动`,
      channel: 'ic' as const,
      atMs: index * 100,
      state: 'frozen' as const,
    })),
  };
}

function makeTools(): ToolRegistry {
  const registry = new ToolRegistry({ maxLevel: 'L1' });
  registry.registerAll(createCoc7eTools());
  return registry;
}

test('解析：剥掉 ```json 围栏并补齐缺省字段', () => {
  const raw = '```json\n{"public":"林晚推开礼拜堂的门。","acknowledged":["seat_p1"]}\n```';
  const output = parseLlmOutput(raw);

  assert.equal(output.public, '林晚推开礼拜堂的门。');
  assert.deepEqual(output.acknowledged, ['seat_p1']);
  assert.deepEqual(output.privates, []);
  assert.deepEqual(output.mentions, []);
  assert.deepEqual(output.effects, []);
});

test('解析：public 为空是硬失败，不能当成功', () => {
  assert.throws(() => parseLlmOutput('{"public":"   "}'), /public 为空/);
  assert.throws(() => parseLlmOutput('{"acknowledged":[]}'), /public 为空/);
});

test('解析：非 JSON 给出可读的错误', () => {
  assert.throws(() => parseLlmOutput('我推开那扇门。'), /不是合法 JSON/);
});

test('解析：丢弃非法 mention 与没有受众的私密', () => {
  const output = parseLlmOutput(
    JSON.stringify({
      public: '正文',
      privates: [
        { audience: ['seat_p1'], text: '有效' },
        { audience: [], text: '没有受众' },
        { audience: ['seat_p2'] },
      ],
      mentions: [
        { surface: '神父', refId: 'npc_priest', kind: 'actor' },
        { surface: '门', refId: 'obj_door', kind: '不存在的类型' },
        { surface: '', refId: 'x', kind: 'actor' },
      ],
    }),
  );

  assert.equal(output.privates.length, 1);
  assert.equal(output.privates[0]?.text, '有效');
  assert.deepEqual(output.mentions.map((m) => m.refId), ['npc_priest']);
});

test('一次回合：正常产出叙述事件与私有事件', async () => {
  const provider = createMockProvider([
    {
      kind: 'text',
      content: JSON.stringify({
        public: '你们在门口撞了个满怀，火把掉在地上。',
        privates: [{ audience: ['seat_p2'], text: '你注意到神父的袖口有血。' }],
        mentions: [{ surface: '神父', refId: 'npc_priest', kind: 'actor' }],
        acknowledged: ['seat_p1', 'seat_p2'],
        gmNotes: '神父在撒谎。',
        effects: ['stained_hand'],
        stateMutations: [{ path: 'actors.ch_lin.status.strained', value: true }],
      }),
    },
  ]);

  const outcome = await runTurn(makeBatch(['seat_p1', 'seat_p2']), {
    provider,
    tools: makeTools(),
    random: createSeededRandom('demo'),
    now: () => 1000,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.supplements, 0);
  assert.equal(outcome.events.length, 6);

  const types = outcome.events.map((event) => event.type);
  assert.deepEqual(types, [
    'turn.batch_frozen',
    'narration.final',
    'narration.private',
    'gm.note',
    'state.patch',
    'turn.completed',
  ]);

  const privateEvent = outcome.events.find((event) => event.type === 'narration.private');
  assert.deepEqual(privateEvent?.visibility, { kind: 'seats', seats: ['seat_p2'] });
  const gmEvent = outcome.events.find((event) => event.type === 'gm.note');
  assert.deepEqual(gmEvent?.visibility, { kind: 'gm_only' });
});

test('覆盖性校验：漏掉一个席位会触发补调用', async () => {
  const provider = createMockProvider([
    {
      kind: 'text',
      content: JSON.stringify({
        public: '林晚冲向圣器室的门。',
        acknowledged: ['seat_p1'],
      }),
    },
    {
      kind: 'text',
      content: JSON.stringify({
        public: '周叙一把拦住她：这么冲过去会出事。',
        acknowledged: ['seat_p2'],
      }),
    },
  ]);

  const outcome = await runTurn(makeBatch(['seat_p1', 'seat_p2']), {
    provider,
    tools: makeTools(),
    random: createSeededRandom('demo'),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.supplements, 1);
  assert.equal(provider.calls.length, 2);
  assert.match(outcome.output?.public ?? '', /冲向圣器室/);
  assert.match(outcome.output?.public ?? '', /拦住她/);
  assert.deepEqual(outcome.output?.acknowledged, ['seat_p1', 'seat_p2']);
});

test('补调用最多两次，然后带着已有内容收工', async () => {
  const alwaysMissing = JSON.stringify({ public: '只回应了一个人。', acknowledged: ['seat_p1'] });
  const provider = createMockProvider([
    { kind: 'text', content: alwaysMissing },
    { kind: 'text', content: alwaysMissing },
    { kind: 'text', content: alwaysMissing },
  ]);

  const outcome = await runTurn(makeBatch(['seat_p1', 'seat_p2']), {
    provider,
    tools: makeTools(),
    random: createSeededRandom('demo'),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.supplements, 2);
  assert.equal(provider.calls.length, 3);
});

test('工具往返：模型调 roll_check，引擎裁决后模型再叙述', async () => {
  const provider = createMockProvider([
    { kind: 'tools', calls: [{ name: 'roll_check', arguments: { actor: 'ch_lin', skill: '侦查', difficulty: 'regular', skillValue: 65 } }] },
    {
      kind: 'text',
      content: JSON.stringify({ public: '你在木地板上发现了几滴暗红色的痕迹。', acknowledged: ['seat_p1'] }),
    },
  ]);

  const outcome = await runTurn(makeBatch(['seat_p1']), {
    provider,
    tools: makeTools(),
    random: createSeededRandom('fixed-seed'),
    sceneOf: () => ({
      sceneId: 'sc_chapel',
      name: '礼拜堂',
      summary: '正午的光从彩窗斜射进来',
      actors: [
        { actorId: 'ch_lin', name: '林晚' },
        { actorId: 'ch_zhou', name: '周叙' },
      ],
    }),
    actorsOf: () => ['ch_lin'],
    charactersOf: () => ({
      ch_lin: { name: '林晚', skills: { 侦查: 65 } },
      ch_zhou: { name: '周叙', skills: { 侦查: 45 } },
    }),
  });

  assert.equal(outcome.ok, true);
  const toolCall = provider.calls[1]?.messages.find((message) => message.role === 'tool');
  assert.ok(toolCall !== undefined);
  assert.match(toolCall.content, /"ok":true/);
  assert.match(toolCall.content, /level/);
});

test('预算耗尽：不产出叙述，返回可读错误', async () => {
  const { BudgetGuard } = await import('../../llm-gateway/src/index.ts');
  const guard = new BudgetGuard({ maxCostUsd: 1, maxTokens: 10 });
  guard.record(10, 0.5);

  const provider = createMockProvider([{ kind: 'text', content: '{}' }]);
  const outcome = await runTurn(makeBatch(['seat_p1']), {
    provider,
    tools: makeTools(),
    random: createSeededRandom('demo'),
    guard,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'BUDGET_EXCEEDED');
  assert.equal(outcome.events.length, 0);
});

test('mergeSupplement 追加而不覆盖', () => {
  const base = {
    public: '甲',
    privates: [{ audience: ['seat_p1'], text: 'p1' }],
    mentions: [],
    acknowledged: ['seat_p1'],
    gmNotes: 'n1',
    effects: ['e1'],
    stateMutations: [],
  };
  const extra = {
    public: '乙',
    privates: [{ audience: ['seat_p2'], text: 'p2' }],
    mentions: [{ surface: '门', refId: 'obj_door', kind: 'scene' as const }],
    acknowledged: ['seat_p2'],
    gmNotes: 'n2',
    effects: ['e2'],
    stateMutations: [{ path: 'a.b', value: 1 }],
  };

  const merged = mergeSupplement(base, extra);
  assert.equal(merged.public, '甲\n\n乙');
  assert.deepEqual(merged.acknowledged, ['seat_p1', 'seat_p2']);
  assert.equal(merged.privates.length, 2);
  assert.equal(merged.effects.length, 2);
  assert.equal(merged.gmNotes, 'n1\nn2');
});
