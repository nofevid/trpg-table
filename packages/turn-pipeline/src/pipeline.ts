import type { BudgetGuard, ChatMessage, LlmProvider, Usage } from '../../llm-gateway/src/index.ts';
import { packContext, runToolLoop } from '../../llm-gateway/src/index.ts';
import type { ToolRegistry } from '../../tools/src/index.ts';
import type { CharacterStub } from '../../tools/src/coc7e.ts';
import type { Channel, TurnBatch } from '../../turn-batcher/src/index.ts';
import { missingSeats } from '../../turn-batcher/src/index.ts';
import type { RandomSource } from '../../rules-core/src/index.ts';
import type { Visibility } from '../../visibility/src/index.ts';
import { parseLlmOutput, OutputParseError, type LlmOutput } from './output.ts';

export interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
  visibility: Visibility;
}

export interface SceneLike {
  sceneId: string;
  name: string;
  summary: string;
  visibleFacts?: readonly string[];
  exits?: readonly { label: string; state: string }[];
  /** 在场角色；工具执行器靠它校验 actorId 是否真实存在 */
  actors?: readonly { actorId: string; name: string }[];
}

export interface TurnPipelineOptions {
  provider: LlmProvider;
  tools: ToolRegistry;
  random: RandomSource;
  guard?: BudgetGuard;
  /** 场景读取；没有就退化成纯文字场景 */
  sceneOf?: (sceneId: string) => SceneLike | undefined;
  /** 每个 seat 控制的角色，用于工具上下文与可见性 */
  actorsOf?: (seatId: string) => string[];
  /** 角色卡快照（actorId → 卡）；工具裁决靠它，不传则所有检定都报「没有这个角色」 */
  charactersOf?: () => Record<string, CharacterStub>;
  /** 最多补调用几次（DESIGN.md §7.7.5 规定 2 次后放弃） */
  maxSupplements?: number;
  systemPrompt?: string;
  now?: () => number;
}

export interface TurnOutcome {
  ok: boolean;
  output?: LlmOutput;
  events: PendingEvent[];
  supplements: number;
  usage: Usage;
  costUsd: number;
  error?: { code: string; message: string };
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是《克苏鲁的呼唤》第七版的守秘人，负责叙述世界与扮演所有 NPC。',
  '规则永远由工具裁决：需要判定时调用 roll_check / roll_opposed，不要自己编造骰子结果。',
  '输出必须是单个 JSON 对象，字段：public（给所有人看的叙述）、privates（数组，{audience,text}）、',
  'mentions（数组，{surface,refId,kind}）、acknowledged（数组，本轮每个提交了行动的席位都要出现）、',
  'gmNotes（只给主持人）、effects（字符串数组）、stateMutations（数组，{path,value}）。',
].join('\n');

/** 把本批输入序列化成上下文段（DESIGN.md §12.2 的 S5）。 */
export function renderBatchInputs(batch: TurnBatch): string {
  const lines = batch.inputs.map(
    (input) => `<turn_input seat="${input.seatId}" client="${input.clientTurnId}">${input.text}</turn_input>`,
  );
  return ['此刻桌面上的情况', ...lines].join('\n');
}

/** 补调用只带缺失席位的话，避免把整批再跑一遍多花钱。 */
export function renderSupplementInputs(batch: TurnBatch, missing: readonly string[]): string {
  const lines = batch.inputs
    .filter((input) => missing.includes(input.seatId))
    .map((input) => `<turn_input seat="${input.seatId}">${input.text}</turn_input>`);
  const others = batch.inputs.filter((input) => !missing.includes(input.seatId));
  const context =
    others.length === 0
      ? []
      : ['其他席位正在做的事（已经叙述过，不要重复）', ...others.map((input) => `- ${input.text}`)];
  return [...lines, ...context].join('\n');
}

function channelOf(batch: TurnBatch): Channel {
  return batch.inputs.some((input) => input.channel === 'ic') ? 'ic' : 'ooc';
}

/**
 * 把工具注册表的清单转成模型要的 JSON Schema 子集。
 * `required` 在这里从参数内部提出来——工具定义里写 `required: true`，
 * 模型协议要的是顶层 `required: [...]`，两者不对齐的话模型会漏参数。
 */
export function toToolSchema(entry: {
  name: string;
  summary: string;
  params: Record<string, { type: string; description: string; required?: boolean; enum?: readonly string[]; min?: number; max?: number; integer?: boolean }>;
}): { name: string; description: string; parameters: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(entry.params)) {
    const property: Record<string, unknown> = {
      type: param.type === 'string[]' ? 'array' : param.type,
      description: param.description,
    };
    if (param.type === 'string[]') property['items'] = { type: 'string' };
    if (param.enum !== undefined) property['enum'] = [...param.enum];
    if (param.min !== undefined) property['minimum'] = param.min;
    if (param.max !== undefined) property['maximum'] = param.max;
    if (param.integer === true) property['type'] = 'integer';
    properties[key] = property;
    if (param.required === true) required.push(key);
  }

  return {
    name: entry.name,
    description: entry.summary,
    parameters: { type: 'object', properties, required },
  };
}

/**
 * 一次回合的编排（DESIGN.md §7.4）。
 *
 * 刻意保持纯逻辑：不碰数据库、不发网络消息，只返回「应该写哪些事件」。
 * 落库那一步由调用方在一个事务里做完，这样「LMM 调用绝不在事务内」
 * 这条纪律在结构上就不可能被违反。
 */
export async function runTurn(
  batch: TurnBatch,
  options: TurnPipelineOptions,
): Promise<TurnOutcome> {
  const maxSupplements = options.maxSupplements ?? 2;
  const now = options.now ?? (() => Date.now());
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const scene = batch.sceneId === '' ? undefined : options.sceneOf?.(batch.sceneId);
  const packed = packContext([
    { id: 'S0', text: systemPrompt },
    { id: 'S2', text: scene === undefined ? '（场景未知）' : `${scene.name}\n${scene.summary}` },
    { id: 'S5', text: renderBatchInputs(batch) },
  ]);

  const messages: ChatMessage[] = [
    { role: 'system', content: packed.text },
    { role: 'user', content: '请根据上面的输入叙述这一轮。' },
  ];

  const manifest = options.tools.manifest();
  const schemas = manifest.map(toToolSchema);
  const characters = options.charactersOf?.();
  const executeTool = async (call: { name: string; arguments: Record<string, unknown> }) => {
    const context = {
      random: options.random,
      seatId: batch.inputs[0]?.seatId ?? 'seat_gm',
      characters,
      scene:
        scene === undefined
          ? undefined
          : {
              sceneId: scene.sceneId,
              name: scene.name,
              summary: scene.summary,
              visibleFacts: [...(scene.visibleFacts ?? [])],
              exits: (scene.exits ?? []).map((exit) => ({ label: exit.label, state: exit.state })),
              actors: (scene.actors ?? []).map((actor) => ({ ...actor })),
            },
    };
    // `characters` 是 CoC 7e 工具集的扩展字段，通用 ToolContext 里没有
    return options.tools.execute(call.name, call.arguments, context as never);
  };

  let usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let costUsd = 0;
  let supplements = 0;
  let output: LlmOutput | undefined;
  let stopReason: string = 'done';

  for (let attempt = 0; attempt <= maxSupplements; attempt += 1) {
    const isSupplement = attempt > 0 && output !== undefined;
    const loopMessages = isSupplement
      ? [
          { role: 'system' as const, content: systemPrompt },
          {
            role: 'user' as const,
            content: `上一轮漏掉了这些席位的行动，请只补写他们的部分。\n${renderSupplementInputs(
              batch,
              missingSeats(batch, output?.acknowledged ?? []),
            )}`,
          },
        ]
      : messages;

    const result = await runToolLoop({
      provider: options.provider,
      messages: loopMessages,
      tools: schemas,
      executeTool,
      guard: options.guard,
      maxSteps: 6,
    });

    usage = {
      promptTokens: usage.promptTokens + result.usage.promptTokens,
      completionTokens: usage.completionTokens + result.usage.completionTokens,
      cachedTokens: usage.cachedTokens + result.usage.cachedTokens,
    };
    costUsd += result.costUsd;
    stopReason = result.stopReason;

    if (result.stopReason === 'budget_exceeded') {
      return {
        ok: false,
        events: [],
        supplements,
        usage,
        costUsd,
        error: { code: 'BUDGET_EXCEEDED', message: '这一轮的预算已用尽，未产生叙述' },
      };
    }

    const last = [...result.messages].reverse().find((message) => message.role === 'assistant');
    const raw = last?.content ?? '';
    try {
      const parsed = parseLlmOutput(raw);
      if (isSupplement) {
        output = mergeSupplement(output as LlmOutput, parsed);
        supplements += 1;
      } else {
        output = parsed;
      }
    } catch (error) {
      if (isSupplement && output !== undefined) {
        // 补调用没救回来就带着已有内容收工，不要再花第三次钱
        supplements += 1;
        break;
      }
      return {
        ok: false,
        events: [],
        supplements,
        usage,
        costUsd,
        error: {
          code: error instanceof OutputParseError ? error.code : 'OUTPUT_INVALID',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const missing = missingSeats(batch, output.acknowledged);
    if (missing.length === 0 || supplements >= maxSupplements) break;
  }

  if (output === undefined) {
    return {
      ok: false,
      events: [],
      supplements,
      usage,
      costUsd,
      error: { code: 'OUTPUT_INVALID', message: '没有拿到可用的叙述' },
    };
  }

  const events = buildEvents(batch, output, now());

  return {
    ok: true,
    output,
    events,
    supplements,
    usage,
    costUsd,
    error: stopReason === 'step_limit' ? { code: 'STEP_LIMIT', message: '工具步数用尽，已用现有内容收尾' } : undefined,
  };
}

/** 补调用的结果只补缺失的部分，不覆盖已经写好的叙述。 */
export function mergeSupplement(base: LlmOutput, extra: LlmOutput): LlmOutput {
  return {
    public: `${base.public}\n\n${extra.public}`.trim(),
    privates: [...base.privates, ...extra.privates],
    mentions: [...base.mentions, ...extra.mentions],
    acknowledged: [...new Set([...base.acknowledged, ...extra.acknowledged])],
    gmNotes: [base.gmNotes, extra.gmNotes].filter((note) => note !== '').join('\n'),
    effects: [...new Set([...base.effects, ...extra.effects])],
    stateMutations: [...base.stateMutations, ...extra.stateMutations],
  };
}

/** 把叙述变成要落库的事件序列。顺序即广播顺序，seq 由存储层分配。 */
export function buildEvents(batch: TurnBatch, output: LlmOutput, atMs: number): PendingEvent[] {
  const events: PendingEvent[] = [
    {
      type: 'turn.batch_frozen',
      payload: {
        batchId: batch.batchId,
        turnId: batch.turnId,
        sceneId: batch.sceneId,
        inputs: batch.inputs.map((input) => ({
          seatId: input.seatId,
          clientTurnId: input.clientTurnId,
          text: input.text,
        })),
      },
      visibility: { kind: 'public' },
    },
  ];

  if (output.public !== '') {
    events.push({
      type: 'narration.final',
      payload: { turnId: batch.turnId, text: output.public, mentions: output.mentions },
      visibility: { kind: 'public' },
    });
  }

  for (const note of output.privates) {
    events.push({
      type: 'narration.private',
      payload: { turnId: batch.turnId, text: note.text },
      visibility: { kind: 'seats', seats: note.audience },
    });
  }

  if (output.gmNotes !== '') {
    events.push({
      type: 'gm.note',
      payload: { turnId: batch.turnId, text: output.gmNotes },
      visibility: { kind: 'gm_only' },
    });
  }

  if (output.stateMutations.length > 0 || output.effects.length > 0) {
    events.push({
      type: 'state.patch',
      payload: { turnId: batch.turnId, mutations: output.stateMutations, effects: output.effects },
      visibility: { kind: 'public' },
    });
  }

  events.push({
    type: 'turn.completed',
    payload: { turnId: batch.turnId, channel: channelOf(batch), atMs },
    visibility: { kind: 'public' },
  });

  return events;
}
