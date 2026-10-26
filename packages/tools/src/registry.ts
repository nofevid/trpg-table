import type {
  ManifestEntry,
  ToolContext,
  ToolDefinition,
  ToolErrorCode,
  ToolLevel,
  ToolOutcome,
  ToolParam,
} from './types.ts';

/**
 * 参数校验。手写而不是引 zod：
 *   1. 工具参数结构极浅（一层对象 + 六种类型），引一个 schema 库不划算；
 *   2. 校验失败的信息要能被模型读懂——「dc 应为 1–100 的整数」比 zod 的
 *      `expected number, received string` 更能让它自我修正。
 */
export function validateArgs(
  params: Record<string, ToolParam>,
  args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string; hint: string } {
  const value: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, spec] of Object.entries(params)) {
    const raw = args[name];
    if (raw === undefined || raw === null) {
      if (spec.required === true) problems.push(`缺少必填参数 ${name}（${spec.description}）`);
      continue;
    }

    switch (spec.type) {
      case 'string': {
        if (typeof raw !== 'string') {
          problems.push(`${name} 应为字符串`);
          break;
        }
        if (spec.enum !== undefined && !spec.enum.includes(raw)) {
          problems.push(`${name} 只能是以下之一：${spec.enum.join(' / ')}`);
          break;
        }
        value[name] = raw;
        break;
      }
      case 'number': {
        if (typeof raw !== 'number' || Number.isNaN(raw)) {
          problems.push(`${name} 应为数字`);
          break;
        }
        if (spec.integer === true && !Number.isInteger(raw)) {
          problems.push(`${name} 应为整数`);
          break;
        }
        if (spec.min !== undefined && raw < spec.min) {
          problems.push(`${name} 不能小于 ${spec.min}`);
          break;
        }
        if (spec.max !== undefined && raw > spec.max) {
          problems.push(`${name} 不能大于 ${spec.max}`);
          break;
        }
        value[name] = raw;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') {
          problems.push(`${name} 应为 true 或 false`);
          break;
        }
        value[name] = raw;
        break;
      }
      case 'string[]': {
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
          problems.push(`${name} 应为字符串数组`);
          break;
        }
        value[name] = raw;
        break;
      }
      case 'object': {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          problems.push(`${name} 应为对象`);
          break;
        }
        value[name] = raw;
        break;
      }
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      message: problems.join('；'),
      hint: '修正参数后重试；不需要换用别的工具，也不要自己编造结果。',
    };
  }
  return { ok: true, value };
}

export interface RegistryOptions {
  /** 允许调用的最高层级；默认 L2（L3 的 GM 专用工具要显式放开） */
  maxLevel?: ToolLevel;
}

const LEVEL_RANK: Record<ToolLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #maxLevel: ToolLevel;

  constructor(options: RegistryOptions = {}) {
    this.#maxLevel = options.maxLevel ?? 'L2';
  }

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  registerAll(tools: readonly ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** 本次对局实际可见的工具清单——被裁剪掉的根本不出现在提示词里。 */
  manifest(): ManifestEntry[] {
    return [...this.#tools.values()]
      .filter((tool) => LEVEL_RANK[tool.level] <= LEVEL_RANK[this.#maxLevel])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        level: tool.level,
        summary: tool.summary,
        params: tool.params,
      }));
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return {
        ok: false,
        code: 'TOOL_UNKNOWN',
        message: `没有名为 ${name} 的工具`,
        hint: `可用工具：${this.manifest().map((entry) => entry.name).join('、')}`,
      };
    }
    if (LEVEL_RANK[tool.level] > LEVEL_RANK[this.#maxLevel]) {
      return {
        ok: false,
        code: 'TOOL_UNKNOWN',
        message: `工具 ${name} 在本局已关闭`,
        hint: '改用其他可用工具，不要重复调用它。',
      };
    }

    const checked = validateArgs(tool.params, args);
    if (!checked.ok) {
      return { ok: false, code: 'INVALID_ARGS', message: checked.message, hint: checked.hint };
    }

    try {
      const result = await tool.run(checked.value, ctx);
      return { ok: true, result };
    } catch (error) {
      const known = error as { code?: ToolErrorCode; message?: string; hint?: string };
      return {
        ok: false,
        code: known.code ?? 'TOOL_FAILED',
        message: known.message ?? String(error),
        hint: known.hint,
      };
    }
  }
}

/** 抛一个带错误码的异常，由 `execute` 统一转成 ToolFailure。 */
export function toolError(code: ToolErrorCode, message: string, hint?: string): Error {
  return Object.assign(new Error(message), { code, hint });
}
