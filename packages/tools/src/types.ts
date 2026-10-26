import type { RandomSource } from '../../rules-core/src/index.ts';

/** 工具分层：越靠下越危险，可被裁剪策略整体关闭。 */
export type ToolLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** 参数类型只做六种，够用且能生成 JSON Schema / 提示词。 */
export type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object';

export interface ToolParam {
  type: ParamType;
  required?: boolean;
  description: string;
  /** 受控枚举——写进 schema 的同时也用于运行时校验。 */
  enum?: readonly string[];
  min?: number;
  max?: number;
  /** 整型约束（CoC 里 dc、伤害值都是整数） */
  integer?: boolean;
}

export interface ToolContext {
  random: RandomSource;
  /** 发起这次工具调用的席位；服务端填充，模型无法伪造 */
  seatId: string;
  /** 当前场景快照，L0 只读工具从这里取数据 */
  scene?: SceneStateLike;
}

/** 只声明工具真正需要的字段，避免 tools 包反向依赖领域模型。 */
export interface SceneStateLike {
  sceneId: string;
  name: string;
  summary: string;
  visibleFacts?: string[];
  exits?: Array<{ label: string; state: string }>;
  actors?: Array<{ actorId: string; name: string; status?: Array<{ key: string; value: string }> }>;
}

export interface ToolResult<T = unknown> {
  ok: true;
  result: T;
}

export interface ToolFailure {
  ok: false;
  code: ToolErrorCode;
  message: string;
  /** 给模型看的可操作提示：它下一步该改什么 */
  hint?: string;
}

export type ToolOutcome<T = unknown> = ToolResult<T> | ToolFailure;

/** 与 DESIGN.md §11.3 的错误码表一致，全大写。 */
export type ToolErrorCode =
  | 'TOOL_UNKNOWN'
  | 'INVALID_ARGS'
  | 'SKILL_UNKNOWN'
  | 'PRECONDITION_FAILED'
  | 'NOT_YOUR_TURN'
  | 'CONFLICT'
  | 'BUDGET_EXCEEDED'
  | 'TOOL_FAILED';

export interface ToolDefinition<O = unknown> {
  name: string;
  level: ToolLevel;
  /** 给模型的一句话说明——写进工具清单，直接影响它会不会调对 */
  summary: string;
  params: Record<string, ToolParam>;
  run(input: Record<string, unknown>, ctx: ToolContext): O | Promise<O>;
}

export interface ManifestEntry {
  name: string;
  level: ToolLevel;
  summary: string;
  params: Record<string, ToolParam>;
}
