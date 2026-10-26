/**
 * 规则引擎的公共底座：可注入的随机源 + 骰子表达式。
 *
 * 为什么随机必须可注入：`DESIGN.md` §15 M0 的出口准则第一条是
 * 「100 次检定结果可由种子复现」。回放、审计、写测试、复现玩家的 bug report
 * 全都依赖这一点。真实对局用系统熵，其余场景用种子。
 */

export interface RandomSource {
  /** 均匀分布 [0, 1)。 */
  nextFloat(): number;
  /** 均匀整数 [0, maxExclusive)。 */
  nextInt(maxExclusive: number): number;
  /** 复现用的种子描述，会写进 `dice.result` 事件的 payload。 */
  readonly seed: string;
}

/** mulberry32：32 位状态、速度快、统计性质对骰子来说足够。 */
export function createSeededRandom(seed: string | number): RandomSource {
  const numeric = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));

  let state = numeric >>> 0;
  const label = String(seed);

  const nextFloat = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed: label,
    nextFloat,
    nextInt(maxExclusive: number): number {
      if (maxExclusive <= 0) throw new Error('nextInt 的上界必须为正');
      return Math.floor(nextFloat() * maxExclusive);
    },
  };
}

/** 系统熵版本——真实对局用这个，种子是本次掷骰的可追溯凭据。 */
export function createEntropyRandom(): RandomSource {
  const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return createSeededRandom(seed);
}

/** FNV-1a，把任意种子字符串折成 32 位。 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 把种子固定下来（回放时用），不改变算法。 */
export function withSeed(seed: string): RandomSource {
  return createSeededRandom(seed);
}

// ---------------------------------------------------------------------------
// 骰子表达式
// ---------------------------------------------------------------------------

export interface DiceTerm {
  readonly count: number;
  readonly sides: number;
  /** 平值修正，如 `1d8+1` 的 `+1`。 */
  readonly modifier: number;
}

const DICE_PATTERN = /^\s*(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/;

/**
 * 解析 `1d8+1` / `2d6` / `d100` / `3d6-2`。
 *
 * 只支持「N 个骰子 + 平值修正」这一种形状——CoC 的武器伤害与理智损失
 * 实际只用到这种。要支持 `2d6+1d4` 那种得多写一个词法分析器，
 * 而设计文档里没有这种需求，先不引入。
 */
export function parseDice(expression: string): DiceTerm {
  const match = DICE_PATTERN.exec(expression);
  if (match === null) {
    throw new Error(`无法解析骰子表达式：${expression}`);
  }

  const count = match[1] === undefined || match[1] === '' ? 1 : Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2] as string, 10);
  const sign = match[3] === '-' ? -1 : 1;
  const modifier = match[4] === undefined ? 0 : sign * Number.parseInt(match[4], 10);

  if (count < 1 || count > 100) throw new Error(`骰子个数越界：${expression}`);
  if (sides < 2 || sides > 1000) throw new Error(`骰子面数越界：${expression}`);

  return { count, sides, modifier };
}

export interface DiceRoll {
  readonly expression: string;
  readonly faces: readonly number[];
  readonly total: number;
}

/** 掷一个骰子表达式。`faces` 保留原始点数，写进日志供人核对。 */
export function rollDice(expression: string, random: RandomSource): DiceRoll {
  const term = parseDice(expression);
  const faces: number[] = [];

  for (let i = 0; i < term.count; i++) {
    faces.push(random.nextInt(term.sides) + 1);
  }

  const total = faces.reduce((a, b) => a + b, 0) + term.modifier;
  return { expression, faces, total };
}

/** 百分骰：十位 + 个位，得到 1–100。`00`+`0` 视为 100。 */
export function rollPercentile(random: RandomSource): number {
  const tens = random.nextInt(10);
  const units = random.nextInt(10);
  const value = tens * 10 + units;
  return value === 0 ? 100 : value;
}
