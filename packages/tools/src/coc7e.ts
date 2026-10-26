import {
  classify,
  damageBonus,
  LEVEL_LABEL,
  rollCheck,
  rollOpposed,
  sanityCheck,
  SKILL_NAMES,
  type Characteristics,
  type Difficulty,
  type SuccessLevel,
} from '../../rules-coc7e/src/index.ts';
import { parseDice, rollDice } from '../../rules-core/src/index.ts';
import { toolError } from './registry.ts';
import type { ToolContext, ToolDefinition } from './types.ts';

/** 角色卡里工具真正需要的那一小片，避免 tools 包被角色卡完整结构绑死。 */
export interface CharacterStub {
  name: string;
  skills: Record<string, number>;
  characteristics?: Characteristics;
  san?: { current: number; max: number };
}

export interface Coc7eToolContext extends ToolContext {
  characters?: Record<string, CharacterStub>;
}

const SKILL_VALUE_HINT = '技能名必须来自技能表；不要自造技能名。';

function requireCharacter(ctx: ToolContext, actor: string): CharacterStub {
  const characters = (ctx as Coc7eToolContext).characters;
  const found = characters?.[actor];
  if (found === undefined) {
    throw toolError(
      'PRECONDITION_FAILED',
      `场上没有编号为 ${actor} 的角色`,
      '从场景在场名单里选一个 actorId；不要自己编造角色。',
    );
  }
  return found;
}

function skillValueOf(character: CharacterStub, skill: string): number {
  const value = character.skills[skill];
  if (value === undefined) {
    throw toolError(
      'SKILL_UNKNOWN',
      `${character.name} 的卡上没有「${skill}」的技能值`,
      SKILL_VALUE_HINT,
    );
  }
  return value;
}

const SUCCESS_LABEL: Record<SuccessLevel, string> = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '普通成功',
  failure: '失败',
  fumble: '大失败',
};

/**
 * CoC 7e 的确定性工具集。
 *
 * 这一层的意义是：模型只能**提出检定请求**，不能给出检定结果。
 * 掷骰发生在服务端、用可注入的随机源、带上 seed，事后能重放验证。
 */
export function createCoc7eTools(): ToolDefinition[] {
  const getScene: ToolDefinition = {
    name: 'get_scene',
    level: 'L0',
    summary: '查看当前场景：名称、描述、在场人物、出口与显眼事物。写叙述前需要确认环境时调用。',
    params: {},
    run(_input, ctx) {
      const scene = ctx.scene;
      if (scene === undefined) {
        throw toolError('PRECONDITION_FAILED', '当前没有场景', '直接按已知描述叙述，不要编造场景。');
      }
      return {
        sceneId: scene.sceneId,
        name: scene.name,
        summary: scene.summary,
        visibleFacts: scene.visibleFacts ?? [],
        exits: scene.exits ?? [],
        actors: (scene.actors ?? []).map((actor) => ({
          actorId: actor.actorId,
          name: actor.name,
          status: actor.status ?? [],
        })),
      };
    },
  };

  const rollCheckTool: ToolDefinition = {
    name: 'roll_check',
    level: 'L1',
    summary:
      '让某个角色对一个技能做检定。你只提交「谁、用哪个技能、什么难度」，结果由引擎给出——不要自己判定成败。',
    params: {
      actor: { type: 'string', required: true, description: '行动者编号，来自在场名单' },
      skill: {
        type: 'string',
        required: true,
        description: '技能名，必须是技能表里的名字',
        enum: SKILL_NAMES,
      },
      difficulty: {
        type: 'string',
        description: '难度：regular（常规，默认）/ hard（困难）/ extreme（极难）',
        enum: ['regular', 'hard', 'extreme'],
      },
      bonusDice: { type: 'number', description: '奖励骰个数（0–2）', min: 0, max: 2, integer: true },
      penaltyDice: { type: 'number', description: '惩罚骰个数（0–2）', min: 0, max: 2, integer: true },
    },
    run(input, ctx) {
      const actor = String(input.actor);
      const skill = String(input.skill);
      const character = requireCharacter(ctx, actor);
      const skillValue = skillValueOf(character, skill);
      const difficulty = (input.difficulty as Difficulty | undefined) ?? 'regular';

      const roll = rollCheck(
        {
          skill,
          skillValue,
          difficulty,
          bonusDice: input.bonusDice as number | undefined,
          penaltyDice: input.penaltyDice as number | undefined,
        },
        ctx.random,
      );
      return {
        actor,
        name: character.name,
        ...roll,
        levelLabel: SUCCESS_LABEL[roll.level],
        /** 给模型的一句话结论，它可以直接引用，但不得改写数值 */
        verdict: `${character.name} 的「${skill}」检定：掷出 ${String(roll.roll).padStart(3, '0')}，${SUCCESS_LABEL[roll.level]}`,
      };
    },
  };

  const rollOpposedTool: ToolDefinition = {
    name: 'roll_opposed',
    level: 'L1',
    summary:
      '两个角色对抗时使用（如一方推门另一方顶住）。只提交双方的技能，胜负由引擎判定——同批次冲突必须走这个工具。',
    params: {
      actorA: { type: 'string', required: true, description: '主动方编号' },
      skillA: { type: 'string', required: true, description: '主动方技能名', enum: SKILL_NAMES },
      actorB: { type: 'string', required: true, description: '被动方编号' },
      skillB: { type: 'string', required: true, description: '被动方技能名', enum: SKILL_NAMES },
    },
    run(input, ctx) {
      const actorA = String(input.actorA);
      const actorB = String(input.actorB);
      const charA = requireCharacter(ctx, actorA);
      const charB = requireCharacter(ctx, actorB);
      const skillA = String(input.skillA);
      const skillB = String(input.skillB);

      const result = rollOpposed(
        {
          a: { actorId: actorA, skill: skillA, skillValue: skillValueOf(charA, skillA) },
          b: { actorId: actorB, skill: skillB, skillValue: skillValueOf(charB, skillB) },
        },
        ctx.random,
      );
      return {
        ...result,
        aName: charA.name,
        bName: charB.name,
        aLevelLabel: SUCCESS_LABEL[result.a.level],
        bLevelLabel: SUCCESS_LABEL[result.b.level],
      };
    },
  };

  const rollDiceTool: ToolDefinition = {
    name: 'roll_dice',
    level: 'L1',
    summary: '掷普通骰子（伤害、随机表等）。只支持 NdM±K 形式，不支持多段相加。',
    params: {
      expression: {
        type: 'string',
        required: true,
        description: '骰子表达式，如 1d6、2d10+2',
      },
      reason: { type: 'string', description: '为什么掷这一次，写给人看' },
    },
    run(input, ctx) {
      const expression = String(input.expression);
      parseDice(expression); // 非法表达式在这里抛，转成 INVALID_ARGS 之外的 TOOL_FAILED
      return {
        ...rollDice(expression, ctx.random),
        reason: input.reason === undefined ? undefined : String(input.reason),
      };
    },
  };

  const sanityCheckTool: ToolDefinition = {
    name: 'sanity_check',
    level: 'L1',
    summary: '理智检定。提交角色的当前 SAN 与成功/失败各扣多少，由引擎掷骰并扣减。',
    params: {
      actor: { type: 'string', required: true, description: '角色编号' },
      lossOnSuccess: { type: 'string', description: '成功时扣的表达式，如 0、1d3', required: true },
      lossOnFailure: { type: 'string', description: '失败时扣的表达式，如 1d6、1d10', required: true },
    },
    run(input, ctx) {
      const actor = String(input.actor);
      const character = requireCharacter(ctx, actor);
      if (character.san === undefined) {
        throw toolError(
          'PRECONDITION_FAILED',
          `${character.name} 没有 SAN 数据`,
          '这不是需要理智检定的对象，换一个工具。',
        );
      }

      const result = sanityCheck(
        {
          currentSan: character.san.current,
          lossOnSuccess: String(input.lossOnSuccess),
          lossOnFailure: String(input.lossOnFailure),
        },
        ctx.random,
      );

      // 工具自身不回写角色卡：状态变更走 effects/stateMutations，由回合提交时统一落库
      return {
        actor,
        name: character.name,
        ...result,
        levelLabel: SUCCESS_LABEL[result.roll.level],
        skillValue: character.san.current,
      };
    },
  };

  const getClauseTool: ToolDefinition = {
    name: 'get_clause',
    level: 'L0',
    summary: '按条款号取规则原文（如 coc7e/combat/opposed）。引用规则时用，不要背诵规则书。',
    params: {
      id: { type: 'string', required: true, description: '条款号' },
    },
    run(input, ctx) {
      const clauses = (ctx as Coc7eToolContext & { clauses?: Record<string, string> }).clauses;
      const id = String(input.id);
      const body = clauses?.[id];
      if (body === undefined) {
        throw toolError(
          'PRECONDITION_FAILED',
          `没有条款 ${id}`,
          '换一个条款号；不确定条款号时先用 search_rules。',
        );
      }
      return { id, body };
    },
  };

  const searchRulesTool: ToolDefinition = {
    name: 'search_rules',
    level: 'L0',
    summary: '按关键词搜规则条款（最多返回 3 条）。用于「被攻击时我能反击吗」这类规则问答。',
    params: {
      query: { type: 'string', required: true, description: '关键词，中文即可' },
    },
    run(input, ctx) {
      const clauses = (ctx as Coc7eToolContext & { clauses?: Record<string, string> }).clauses;
      const query = String(input.query).trim();
      if (query === '') throw toolError('INVALID_ARGS', '关键词不能为空', '换一个有实际意义的词。');

      const hits = Object.entries(clauses ?? {})
        .map(([id, body]) => ({
          id,
          body,
          score: (body.includes(query) ? 2 : 0) + (id.includes(query) ? 1 : 0),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ id, body }) => ({ id, excerpt: body.slice(0, 160) }));

      return { query, hits, total: hits.length };
    },
  };

  const getDamageBonusTool: ToolDefinition = {
    name: 'get_damage_bonus',
    level: 'L0',
    summary: '按 STR+SIZ 查伤害加成（-2/-1/0/1d4/1d6/2d6）。近战伤害计算前先查。',
    params: {
      actor: { type: 'string', required: true, description: '角色编号' },
    },
    run(input, ctx) {
      const character = requireCharacter(ctx, String(input.actor));
      const chars = character.characteristics;
      if (chars === undefined) {
        throw toolError(
          'PRECONDITION_FAILED',
          `${character.name} 没有属性数据`,
          '伤害加成需要 STR 与 SIZ。',
        );
      }
      return {
        actor: input.actor,
        name: character.name,
        str: chars.STR,
        siz: chars.SIZ,
        bonus: damageBonus(chars.STR, chars.SIZ),
      };
    },
  };

  return [
    getScene,
    getClauseTool,
    searchRulesTool,
    rollCheckTool,
    rollOpposedTool,
    rollDiceTool,
    sanityCheckTool,
    getDamageBonusTool,
  ];
}

export { LEVEL_LABEL, classify };
