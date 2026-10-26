/** 存储层对外暴露的类型。字段命名跟 DESIGN.md §6.2 的表结构一一对应。 */

/** `visibility` 的结构在 §8.2 定义（public / gm_only / seats / actor_owner / …）。 */
export type Visibility = Record<string, unknown>;

export interface StoredEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  /** 事件 schema 版本，读取侧用 upcaster 迁移（§3.5）。 */
  readonly version: number;
  readonly payload: unknown;
  readonly visibility: Visibility;
  readonly actorSeatId: string | null;
  readonly turnId: string | null;
  readonly clientTurnId: string | null;
  readonly createdAt: number;
}

export interface NewEvent {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly visibility?: Visibility;
  readonly actorSeatId?: string | null;
  readonly turnId?: string | null;
  /**
   * 客户端提交幂等键。同一会话内重复的 `clientTurnId` 只会落一条，
   * 第二次写入直接返回已存在的那条（§11.4）。
   */
  readonly clientTurnId?: string | null;
  readonly version?: number;
}

export interface ReadEventsOptions {
  readonly sessionId: string;
  /** 只取 seq 大于该值的事件（重连补发用，§13.3）。 */
  readonly afterSeq?: number;
  readonly limit?: number;
  /** 只取这些类型；省略表示全部。 */
  readonly types?: readonly string[];
  /** true 时倒序返回（玩家侧检索按 seq 倒序，§7.13）。 */
  readonly descending?: boolean;
}

export interface NewSession {
  readonly id: string;
  readonly rulesetId: string;
  readonly moduleId?: string | null;
  readonly title?: string;
  readonly settings?: Record<string, unknown>;
}

export interface StoredSession {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly rulesetId: string;
  readonly moduleId: string | null;
  readonly title: string;
  readonly settings: Record<string, unknown>;
}
