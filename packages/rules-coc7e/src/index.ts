import type { RandomSource } from '../../rules-core/src/index.ts';
import { rollDice } from '../../rules-core/src/index.ts';

/**
 * 克苏鲁的呼唤 7 版核心检定。
 *
 * 这一层是**确定性**的：给定同样的随机源（同一种子）与同样的输入，
 * 输出必然一致。LLM 只能请求「给林晚掷一次潜行」，不能自己编一个结果——
 * 这是 `DESIGN.md` §10.2 禁令 2 在代码里的落点。
 */

export type SuccessLevel =
  | 'critical'
  | 'extreme'
  | 'hard'
  | 'regular'
  | 'failure'
  | 'fumble';

/** 大小顺序，用于对抗检定比较。 */
export const LEVEL_ORDER: Record<SuccessLevel, number> = {
  fumble: 0,
  failure: 1,
  regular: 2,
  hard: 3,
  extreme: 4,
  critical: 5,
};

export type Difficulty = 'regular' | 'hard' | 'extreme';

/** 难度对应的除数：普通 /1、困难 /2、极难 /5。 */
const DIFFICULTY_DIVISOR: Record<Difficulty, number> = {
  regular: 1,
  hard: 2,
  extreme: 5,
};

export const LEVEL_LABEL: Record<SuccessLevel, string> = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '普通成功',
  failure: '失败',
  fumble: '大失败',
};

export interface Characteristics {
  readonly STR: number;
  readonly CON: number;
  readonly SIZ: number;
  readonly DEX: number;
  readonly APP: number;
  readonly INT: number;
  readonly POW: number;
  readonly EDU: number;
}

/**
 * 技能的基础值。数字是固定基础值，函数是从属性派生的
 * （闪避 = DEX/2、母语 = EDU）。
 */
export const SKILL_BASE: Readonly<Record<string, number | ((c: Characteristics) => number)>> = {
  会计: 5,
  人类学: 1,
  估价: 5,
  考古学: 1,
  技艺: 5,
  魅惑: 15,
  攀爬: 20,
  计算机使用: 5,
  信用评级: 0,
  克苏鲁神话: 0,
  乔装: 5,
  闪避: (c) => Math.floor(c.DEX / 2),
  汽车驾驶: 20,
  电气维修: 10,
  电子学: 1,
  话术: 5,
  格斗: 25,
  射击: 20,
  急救: 30,
  历史: 5,
  恐吓: 15,
  跳跃: 20,
  外语: 1,
  母语: (c) => c.EDU,
  法律: 5,
  图书馆使用: 20,
  聆听: 20,
  锁匠: 1,
  机械维修: 10,
  医学: 1,
  博物学: 10,
  导航: 10,
  神秘学: 5,
  操作重型机械: 1,
  说服: 10,
  精神分析: 1,
  心理学: 10,
  骑术: 5,
  科学: 1,
  妙手: 10,
  侦查: 25,
  潜行: 20,
  生存: 10,
  游泳: 20,
  投掷: 20,
  追踪: 10,
  潜水: 1,
  爆破: 1,
  读唇: 1,
  催眠: 1,
  炮术: 1,
};

/** 技能名是否属于封闭集合。§11.2 的 `skill` 校验就靠它。 */
export function isKnownSkill(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILL_BASE, name);
}

export function skillBase(name: string, characteristics: Characteristics): number {
  const base = SKILL_BASE[name];
  if (base === undefined) {
    throw new Error(`未知技能：${name}（技能名必须来自 CoC 7e 技能表）`);
  }
  return typeof base === 'function' ? base(characteristics) : base;
}

/** 技能表里所有合法的技能名——工具调用的枚举来源。 */
export const SKILL_NAMES: readonly string[] = Object.keys(SKILL_BASE);

// ---------------------------------------------------------------------------
// 检定
// ---------------------------------------------------------------------------

export interface RollCheckInput {
  readonly skill: string;
  /** 角色当前的技能值（已含成长与临时加值）。 */
  readonly skillValue: number;
  readonly difficulty?: Difficulty;
  readonly bonusDice?: number;
  readonly penaltyDice?: number;
}

export interface RollCheckOutput {
  readonly skill: string;
  readonly skillValue: number;
  /** 按难度折算后的目标值。 */
  readonly target: number;
  readonly difficulty: Difficulty;
  readonly roll: number;
  /** 奖励/惩罚骰最终选中的十位骰点数，便于解释。 */
  readonly tens: number;
  readonly level: SuccessLevel;
  readonly success: boolean;
  readonly breakdown: string;
  readonly seed: string;
}

/**
 * 判定成功等级。
 *
 * 等级只看**技能值本身**，与本次检定的难度无关——难度决定的是
 * 「要达到哪一级才算过」（见 `rollCheck` 的 `success`）。
 *
 * 两个容易记错的点：
 *   1. 掷出 **01 永远是大成功**，哪怕技能值只有 5。
 *   2. 大失败的门槛取决于技能值：技能值 ≥ 50 时只有掷 100 才算大失败，
 *      否则 96–100 都是。所以「技能越高，越不容易大失败」。
 */
export function classify(roll: number, skillValue: number): SuccessLevel {
  if (roll === 1) return 'critical';

  const fumbleFloor = skillValue >= 50 ? 100 : 96;
  if (roll >= fumbleFloor) return 'fumble';

  if (roll <= Math.floor(skillValue / 5)) return 'extreme';
  if (roll <= Math.floor(skillValue / 2)) return 'hard';
  if (roll <= skillValue) return 'regular';
  return 'failure';
}

/**
 * 掷一次 d100 检定。
 *
 * 奖励骰：额外掷的十位骰与同一个位组合成多个候选值，取最小。
 * 惩罚骰同理，取最大。CoC 7e 允许两者同时存在（互相抵消），
 * 这里直接相减，剩几个算几个。
 */
export function rollCheck(input: RollCheckInput, random: RandomSource): RollCheckOutput {
  const difficulty = input.difficulty ?? 'regular';
  const divisor = DIFFICULTY_DIVISOR[difficulty];
  const target = Math.floor(input.skillValue / divisor);

  const net = (input.bonusDice ?? 0) - (input.penaltyDice ?? 0);
  const extra = Math.abs(net);
  const useBonus = net > 0;

  // 个位固定掷一次；十位掷 1 + extra 个，择优/劣
  const units = random.nextInt(10);
  let chosenTens = random.nextInt(10);
  let roll = chosenTens === 0 && units === 0 ? 100 : chosenTens * 10 + units;

  for (let i = 0; i < extra; i++) {
    const tens = random.nextInt(10);
    const candidate = tens === 0 && units === 0 ? 100 : tens * 10 + units;
    if (useBonus ? candidate < roll : candidate > roll) {
      roll = candidate;
      chosenTens = tens;
    }
  }

  const level = classify(roll, input.skillValue);
  // 难度是「及格线」：困难检定下，困难成功与极难/大成功才算过
  const success = LEVEL_ORDER[level] >= LEVEL_ORDER[difficulty];

  const diceNote = extra > 0 ? `，${useBonus ? '奖励' : '惩罚'}骰 ${extra} 个` : '';
  const breakdown =
    `掷出 ${String(roll).padStart(3, '0')}${diceNote}；` +
    `${input.skill} ${input.skillValue}，${difficulty === 'regular' ? '常规' : difficulty === 'hard' ? '困难' : '极难'}检定（需 ≥ ${LEVEL_LABEL[difficulty]}）` +
    ` → ${LEVEL_LABEL[level]}`;

  return {
    skill: input.skill,
    skillValue: input.skillValue,
    target,
    difficulty,
    roll,
    tens: chosenTens,
    level,
    success,
    breakdown,
    seed: random.seed,
  };
}

// ---------------------------------------------------------------------------
// 对抗检定
// ---------------------------------------------------------------------------

export interface OpposedInput {
  readonly a: { readonly actorId: string; readonly skill: string; readonly skillValue: number };
  readonly b: { readonly actorId: string; readonly skill: string; readonly skillValue: number };
}

export type OpposedOutcome = 'a' | 'b' | 'tie';

export interface OpposedOutput {
  readonly a: RollCheckOutput;
  readonly b: RollCheckOutput;
  readonly winner: OpposedOutcome;
  readonly explanation: string;
}

/**
 * 对抗检定：先比成功等级，等级相同再比技能值。
 *
 * 平局按规则算「双方都没达成目的」，由 GM 决定后续（通常是再来一轮）。
 * 引擎不替 GM 编后果。
 */
export function rollOpposed(input: OpposedInput, random: RandomSource): OpposedOutput {
  const a = rollCheck(
    { skill: input.a.skill, skillValue: input.a.skillValue },
    random,
  );
  const b = rollCheck(
    { skill: input.b.skill, skillValue: input.b.skillValue },
    random,
  );

  const rankA = LEVEL_ORDER[a.level];
  const rankB = LEVEL_ORDER[b.level];

  let winner: OpposedOutcome = 'tie';
  let explanation: string;

  if (rankA !== rankB) {
    winner = rankA > rankB ? 'a' : 'b';
    explanation = `${input.a.actorId} ${LEVEL_LABEL[a.level]} 优于 ${input.b.actorId} ${LEVEL_LABEL[b.level]}`;
  } else if (input.a.skillValue !== input.b.skillValue) {
    winner = input.a.skillValue > input.b.skillValue ? 'a' : 'b';
    explanation = `双方同为${LEVEL_LABEL[a.level]}，比较技能值 ${input.a.skillValue} : ${input.b.skillValue}`;
  } else {
    explanation = `双方同为${LEVEL_LABEL[a.level]}且技能值相同，僵持`;
  }

  return { a, b, winner, explanation };
}

// ---------------------------------------------------------------------------
// 理智
// ---------------------------------------------------------------------------

export interface SanityCheckInput {
  readonly currentSan: number;
  /** 成功时的损失表达式，如 `0` 或 `1d2`。 */
  readonly lossOnSuccess: string;
  readonly lossOnFailure: string;
}

export interface SanityCheckOutput {
  readonly roll: RollCheckOutput;
  readonly loss: number;
  readonly sanBefore: number;
  readonly sanAfter: number;
  readonly breakdown: string;
}

/** 理智检定：SAN 值当作技能值检定，失败时按表达式扣。 */
export function sanityCheck(
  input: SanityCheckInput,
  random: RandomSource,
): SanityCheckOutput {
  const roll = rollCheck({ skill: '理智', skillValue: input.currentSan }, random);
  const expression = roll.success ? input.lossOnSuccess : input.lossOnFailure;
  const loss = rollNumberExpression(expression, random);
  const sanAfter = Math.max(0, input.currentSan - loss);

  return {
    roll,
    loss,
    sanBefore: input.currentSan,
    sanAfter,
    breakdown: `${roll.breakdown}；损失 ${loss} 点理智（${input.currentSan} → ${sanAfter}）`,
  };
}

/** 损失表达式允许是纯数字（`0`、`1`）或骰子（`1d6`）。 */
function rollNumberExpression(expression: string, random: RandomSource): number {
  const trimmed = expression.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return rollDice(trimmed, random).total;
}

// ---------------------------------------------------------------------------
// 伤害
// ---------------------------------------------------------------------------

/**
 * 伤害加成（DB），按 STR + SIZ 查表。
 * 返回骰子表达式或平值，与武器伤害相加。
 */
export function damageBonus(str: number, siz: number): string {
  const sum = str + siz;
  if (sum <= 64) return '-2';
  if (sum <= 84) return '-1';
  if (sum <= 124) return '0';
  if (sum <= 164) return '1d4';
  if (sum <= 204) return '1d6';
  return '2d6';
}

/** 把武器的固定伤害与 DB 合并成一个表达式（`1d8` + `1d4` → `1d8+1d4` 不支持，取近似）。 */
export function combineDamage(weapon: string, db: string): string {
  if (db === '0') return weapon;
  if (/^[+-]?\d+$/.test(db)) {
    const value = Number.parseInt(db, 10);
    if (value === 0) return weapon;
    return `${weapon}${value > 0 ? '+' : '-'}${Math.abs(value)}`;
  }
  // 骰子型 DB 没法简单地拼进 `NdM+K` 形式，交给调用方掷两次后相加
  return weapon;
}
