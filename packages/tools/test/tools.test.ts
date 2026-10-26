import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeededRandom } from '../../rules-core/src/index.ts';
import { createCoc7eTools, ToolRegistry, toolError, validateArgs } from '../src/index.ts';
import type { Coc7eToolContext } from '../src/index.ts';

function makeContext(seed = 'tools-test'): Coc7eToolContext {
  return {
    random: createSeededRandom(seed),
    seatId: 'seat_p1',
    scene: {
      sceneId: 'sc_chapel',
      name: '礼拜堂',
      summary: '正午的光从彩窗斜射进来，长椅空着。',
      visibleFacts: ['管风琴', '彩窗'],
      exits: [{ label: '圣器室', state: 'locked' }],
      actors: [
        { actorId: 'ch_lin', name: '林晚', status: [{ key: 'HP', value: '11/11' }] },
        { actorId: 'ch_zhou', name: '周叙' },
      ],
    },
    characters: {
      ch_lin: {
        name: '林晚',
        skills: { 侦查: 65, 闪避: 55, 潜行: 50, 格斗: 45 },
        characteristics: { STR: 45, CON: 50, SIZ: 50, DEX: 70, APP: 55, INT: 70, POW: 60, EDU: 80 },
        san: { current: 55, max: 60 },
      },
      ch_zhou: {
        name: '周叙',
        skills: { 格斗: 70, 闪避: 40, 侦查: 35 },
        characteristics: { STR: 70, CON: 60, SIZ: 65, DEX: 50, APP: 45, INT: 55, POW: 50, EDU: 60 },
        san: { current: 40, max: 50 },
      },
    },
  };
}

test('注册表拒绝重名工具', () => {
  const registry = new ToolRegistry();
  const [first] = createCoc7eTools();
  assert.ok(first !== undefined);
  registry.register(first);
  assert.throws(() => registry.register(first), /工具重名/);
});

test('清单按层级裁剪，L3 默认不可见', () => {
  const registry = new ToolRegistry({ maxLevel: 'L1' });
  registry.registerAll(createCoc7eTools());
  registry.register({
    name: 'gm_override',
    level: 'L3',
    summary: 'GM 强制裁决',
    params: { reason: { type: 'string', required: true, description: '理由' } },
    run: () => ({ ok: true }),
  });

  const names = registry.manifest().map((entry) => entry.name);
  assert.ok(names.includes('roll_check'));
  assert.ok(!names.includes('gm_override'));

  // 受限工具即使被点名也不执行
  return registry.execute('gm_override', { reason: 'x' }, makeContext()).then((outcome) => {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, 'TOOL_UNKNOWN');
  });
});

test('参数校验给出可读的错误与纠正提示', () => {
  const bad = validateArgs(
    {
      skill: { type: 'string', required: true, description: '技能名', enum: ['潜行', '侦查'] },
      dc: { type: 'number', description: '目标值', min: 1, max: 100, integer: true },
    },
    { skill: '口才', dc: 120 },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.message, /只能是以下之一/);
    assert.match(bad.message, /不能大于 100/);
    assert.match(bad.hint, /不要自己编造结果/);
  }

  const good = validateArgs(
    { skill: { type: 'string', required: true, description: '技能名', enum: ['潜行'] } },
    { skill: '潜行' },
  );
  assert.equal(good.ok, true);
});

test('roll_check 返回引擎判定，模型拿不到可伪造的成败字段以外的数字', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const ctx = makeContext('roll-1');

  const outcome = await registry.execute(
    'roll_check',
    { actor: 'ch_lin', skill: '侦查', difficulty: 'regular' },
    ctx,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const result = outcome.result as {
    roll: number;
    level: string;
    success: boolean;
    seed: string;
    verdict: string;
  };
  assert.ok(result.roll >= 1 && result.roll <= 100);
  assert.equal(typeof result.success, 'boolean');
  assert.equal(result.seed, 'roll-1');
  assert.match(result.verdict, /林晚 的「侦查」检定/);
});

test('未知技能名被拒绝，并提示技能表', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute(
    'roll_check',
    { actor: 'ch_lin', skill: '口才' },
    makeContext(),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'INVALID_ARGS');
    assert.match(outcome.message, /只能是以下之一/);
  }
});

test('角色卡上没有该技能时报 SKILL_UNKNOWN', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute(
    'roll_check',
    { actor: 'ch_lin', skill: '炮术' },
    makeContext(),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'SKILL_UNKNOWN');
    assert.match(outcome.message, /卡上没有「炮术」/);
  }
});

test('不存在的角色报 PRECONDITION_FAILED', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute('roll_check', { actor: 'ch_nobody', skill: '侦查' }, makeContext());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'PRECONDITION_FAILED');
});

test('get_scene 只返回裁剪后的场景视图', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute('get_scene', {}, makeContext());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const scene = outcome.result as { name: string; exits: Array<{ label: string }> };
  assert.equal(scene.name, '礼拜堂');
  assert.equal(scene.exits[0]?.label, '圣器室');
});

test('工具抛出的错误被转成 ToolFailure', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'boom',
    level: 'L1',
    summary: '总是失败',
    params: {},
    run: () => {
      throw toolError('PRECONDITION_FAILED', '门是锁着的', '先想办法开锁。');
    },
  });
  const outcome = await registry.execute('boom', {}, makeContext());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'PRECONDITION_FAILED');
    assert.equal(outcome.hint, '先想办法开锁。');
  }
});

test('roll_opposed 让引擎比较双方等级', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute(
    'roll_opposed',
    { actorA: 'ch_lin', skillA: '闪避', actorB: 'ch_zhou', skillB: '格斗' },
    makeContext('opposed'),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const result = outcome.result as { a: { roll: number }; b: { roll: number }; winner: string };
  assert.ok([result.a.roll, result.b.roll].every((roll) => roll >= 1 && roll <= 100));
  assert.ok(['a', 'b', 'tie'].includes(result.winner));
});

test('roll_dice 只接受 NdM±K', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const ok = await registry.execute('roll_dice', { expression: '2d6+1', reason: '坠落伤害' }, makeContext());
  assert.equal(ok.ok, true);

  const bad = await registry.execute('roll_dice', { expression: '2d6+1d4' }, makeContext());
  assert.equal(bad.ok, false);
});

test('sanity_check 扣减后 SAN 下降', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const outcome = await registry.execute(
    'sanity_check',
    { actor: 'ch_lin', lossOnSuccess: '0', lossOnFailure: '1d6' },
    makeContext('san'),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const result = outcome.result as { sanBefore: number; sanAfter: number; loss: number };
  assert.equal(result.sanBefore, 55);
  assert.equal(result.sanAfter, 55 - result.loss);
});

test('伤害加成按 STR+SIZ 查表', async () => {
  const registry = new ToolRegistry();
  registry.registerAll(createCoc7eTools());
  const lin = await registry.execute('get_damage_bonus', { actor: 'ch_lin' }, makeContext());
  assert.equal(lin.ok, true);
  if (lin.ok) assert.equal((lin.result as { bonus: string }).bonus, '0');

  const zhou = await registry.execute('get_damage_bonus', { actor: 'ch_zhou' }, makeContext());
  assert.equal(zhou.ok, true);
  if (zhou.ok) assert.equal((zhou.result as { bonus: string }).bonus, '1d4');
});
