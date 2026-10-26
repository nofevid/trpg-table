import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeededRandom, parseDice, rollDice } from '../../rules-core/src/index.ts';
import {
  classify,
  damageBonus,
  isKnownSkill,
  LEVEL_ORDER,
  rollCheck,
  rollOpposed,
  sanityCheck,
  skillBase,
  SKILL_NAMES,
} from '../src/index.ts';

/** 按给定序列吐数的随机源——用来断言奖励骰/惩罚骰的具体选择。 */
function scripted(values: number[]): {
  nextFloat: () => number;
  nextInt: (max: number) => number;
  seed: string;
} {
  let i = 0;
  const pick = (): number => {
    const v = values[i++];
    if (v === undefined) throw new Error('scripted random 用完了');
    return v;
  };
  return {
    seed: 'scripted',
    nextFloat: () => pick() / 10,
    nextInt: (max: number) => {
      const v = pick();
      // d10 直接取脚本值；其它面数（如 1d6）取模，方便写理智检定的用例
      return max === 10 ? v : v % max;
    },
  };
}

test('同一种子的检定结果可复现', () => {
  const input = { skill: '潜行', skillValue: 60 };
  const first = rollCheck(input, createSeededRandom('seed-42'));
  const second = rollCheck(input, createSeededRandom('seed-42'));

  assert.equal(first.roll, second.roll);
  assert.equal(first.level, second.level);
  assert.equal(first.seed, second.seed);
});

test('成功等级的分档边界', () => {
  // 技能 45：极难 ≤9，困难 ≤22，普通 ≤45，失败 46–95，大失败 96+
  assert.equal(classify(1, 45), 'critical');
  assert.equal(classify(9, 45), 'extreme');
  assert.equal(classify(10, 45), 'hard');
  assert.equal(classify(22, 45), 'hard');
  assert.equal(classify(23, 45), 'regular');
  assert.equal(classify(45, 45), 'regular');
  assert.equal(classify(46, 45), 'failure');
  assert.equal(classify(95, 45), 'failure');
  assert.equal(classify(96, 45), 'fumble');
});

test('技能值 50 以上只有掷 100 才大失败', () => {
  assert.equal(classify(96, 50), 'failure');
  assert.equal(classify(99, 50), 'failure');
  assert.equal(classify(100, 50), 'fumble');
  // 技能很低时 01 依然是大成功
  assert.equal(classify(1, 5), 'critical');
});

test('困难检定要求达到困难等级才算过', () => {
  // 技能 60，掷 25 → hard（60/2=30），困难检定下算过
  const rng = scripted([5, 2]); // 个位 5、十位 2 → 25
  const result = rollCheck({ skill: '侦查', skillValue: 60, difficulty: 'hard' }, rng);
  assert.equal(result.roll, 25);
  assert.equal(result.level, 'hard');
  assert.equal(result.success, true);

  // 同一个骰面，改为极难检定（需 60/5=12）就不过
  const again = rollCheck({ skill: '侦查', skillValue: 60, difficulty: 'extreme' }, scripted([5, 2]));
  assert.equal(again.success, false);
});

test('奖励骰取更小的十位，惩罚骰取更大的十位', () => {
  // 个位 0；十位掷出 7 与 2
  const bonus = rollCheck({ skill: '潜行', skillValue: 50, bonusDice: 1 }, scripted([0, 7, 2]));
  assert.equal(bonus.roll, 20);

  const penalty = rollCheck({ skill: '潜行', skillValue: 50, penaltyDice: 1 }, scripted([0, 7, 2]));
  assert.equal(penalty.roll, 70);
});

test('对抗检定先比等级，再比技能值', () => {
  // A 掷 05（技能 50 → hard），B 掷 80（技能 80 → regular）
  const result = rollOpposed(
    {
      a: { actorId: '林晚', skill: '闪避', skillValue: 50 },
      b: { actorId: '周叙', skill: '格斗', skillValue: 80 },
    },
    scripted([5, 0, 0, 8]),
  );

  // 技能 50，掷 05 → 50/5=10，05 ≤ 10 → 极难
  assert.equal(result.a.roll, 5);
  assert.equal(result.a.level, 'extreme');
  assert.equal(result.b.roll, 80);
  assert.equal(result.b.level, 'regular');
  assert.equal(result.winner, 'a');
  assert.match(result.explanation, /极难成功/);
});

test('技能名是封闭集合', () => {
  assert.equal(isKnownSkill('潜行'), true);
  assert.equal(isKnownSkill('侦查'), true);
  assert.equal(isKnownSkill('口才'), false);
  assert.equal(isKnownSkill('随便编一个'), false);
  assert.ok(SKILL_NAMES.length >= 45, `技能表只有 ${SKILL_NAMES.length} 项`);
});

test('派生技能基础值来自属性', () => {
  const chars = { STR: 50, CON: 50, SIZ: 50, DEX: 70, APP: 50, INT: 50, POW: 50, EDU: 80 };
  assert.equal(skillBase('闪避', chars), 35);
  assert.equal(skillBase('母语', chars), 80);
  assert.equal(skillBase('侦查', chars), 25);
  assert.throws(() => skillBase('口才', chars), /未知技能/);
});

test('伤害加成按 STR+SIZ 查表', () => {
  assert.equal(damageBonus(30, 30), '-2');
  assert.equal(damageBonus(40, 40), '-1');
  assert.equal(damageBonus(60, 60), '0');
  assert.equal(damageBonus(80, 60), '1d4');
  assert.equal(damageBonus(90, 80), '1d6');
  assert.equal(damageBonus(120, 90), '2d6');
});

test('理智检定按成功/失败扣不同的量', () => {
  // 个位 0、十位 9 → 90，SAN 50 → 失败，扣 1d6（脚本掷出 3 → 4）
  const result = sanityCheck(
    { currentSan: 50, lossOnSuccess: '0', lossOnFailure: '1d6' },
    scripted([0, 9, 3]),
  );
  assert.equal(result.roll.roll, 90);
  assert.equal(result.roll.success, false);
  assert.equal(result.loss, 4);
  assert.equal(result.sanAfter, 46);
});

test('骰子表达式与随机源', () => {
  assert.deepEqual(parseDice('2d6+1'), { count: 2, sides: 6, modifier: 1 });
  assert.deepEqual(parseDice('d100'), { count: 1, sides: 100, modifier: 0 });
  assert.throws(() => parseDice('2d6+1d4'), /无法解析/);

  const rng = createSeededRandom('dice');
  const roll = rollDice('3d6', rng);
  assert.equal(roll.faces.length, 3);
  for (const face of roll.faces) assert.ok(face >= 1 && face <= 6);
  assert.equal(
    roll.total,
    roll.faces.reduce((a, b) => a + b, 0),
  );
});

test('等级顺序常量自洽', () => {
  assert.ok(LEVEL_ORDER.critical > LEVEL_ORDER.extreme);
  assert.ok(LEVEL_ORDER.extreme > LEVEL_ORDER.hard);
  assert.ok(LEVEL_ORDER.hard > LEVEL_ORDER.regular);
  assert.ok(LEVEL_ORDER.regular > LEVEL_ORDER.failure);
  assert.ok(LEVEL_ORDER.failure > LEVEL_ORDER.fumble);
});
