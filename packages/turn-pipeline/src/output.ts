/**
 * 结构化叙述的解析（DESIGN.md §8.3 L1 契约）。
 *
 * 模型的实际输出永远比契约脏一点：包一层 ```json 围栏、忘了某个字段、
 * 把 mentions 写成字符串数组。这里的策略是**能救就救，救不了就说清楚哪不对**，
 * 而不是抛一个 `Unexpected token <` 让玩家看到。
 */
export interface PrivateNote {
  audience: string[];
  text: string;
}

export interface Mention {
  surface: string;
  refId: string;
  kind: 'actor' | 'scene' | 'clue' | 'item';
}

export interface StateMutation {
  path: string;
  value: unknown;
}

export interface LlmOutput {
  public: string;
  privates: PrivateNote[];
  mentions: Mention[];
  acknowledged: string[];
  gmNotes: string;
  effects: string[];
  stateMutations: StateMutation[];
}

export class OutputParseError extends Error {
  readonly code = 'OUTPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'OutputParseError';
  }
}

const MENTION_KINDS = new Set(['actor', 'scene', 'clue', 'item']);

/** 剥掉模型爱加的 Markdown 围栏，顺带取出第一段花括号包裹的内容。 */
function unwrapFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fence !== null && fence[1] !== undefined) return fence[1].trim();
  return trimmed;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item) => item !== '');
}

function parsePrivates(value: unknown): PrivateNote[] {
  if (!Array.isArray(value)) return [];
  const out: PrivateNote[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const audience = asStringArray(record['audience'] ?? record['seats']);
    const text = asString(record['text'] ?? record['content']);
    if (audience.length === 0 || text === '') continue;
    out.push({ audience, text });
  }
  return out;
}

function parseMentions(value: unknown): Mention[] {
  if (!Array.isArray(value)) return [];
  const out: Mention[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const surface = asString(record['surface']);
    const refId = asString(record['refId']);
    const kind = asString(record['kind']);
    if (surface === '' || refId === '') continue;
    if (!MENTION_KINDS.has(kind)) continue;
    out.push({ surface, refId, kind: kind as Mention['kind'] });
  }
  return out;
}

function parseMutations(value: unknown): StateMutation[] {
  if (!Array.isArray(value)) return [];
  const out: StateMutation[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const path = asString(record['path']);
    if (path === '') continue;
    out.push({ path, value: record['value'] });
  }
  return out;
}

/**
 * 解析并补齐默认值。`public` 为空是唯一不可救的情况——没有叙述等于这一轮白跑，
 * 必须让上层重试或降级，而不是静默通过。
 */
export function parseLlmOutput(raw: string): LlmOutput {
  const body = unwrapFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OutputParseError('模型输出不是合法 JSON（可能需要重试或降级为纯文本叙述）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OutputParseError('模型输出的顶层必须是对象');
  }

  const record = parsed as Record<string, unknown>;
  const publicText = asString(record['public'] ?? record['narration']);
  if (publicText.trim() === '') {
    throw new OutputParseError('public 为空：这一轮没有任何叙述，不能当成成功');
  }

  return {
    public: publicText,
    privates: parsePrivates(record['privates']),
    mentions: parseMentions(record['mentions']),
    acknowledged: [...new Set(asStringArray(record['acknowledged']))],
    gmNotes: asString(record['gmNotes']),
    effects: asStringArray(record['effects']),
    stateMutations: parseMutations(record['stateMutations']),
  };
}
