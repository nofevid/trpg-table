/**
 * 输入通道（DESIGN.md §7.11）。
 * 只有 `ic` 进批次走裁决；`ooc` 与 `rule` 直接旁路，避免十几条「哈哈」
 * 把叙事拖死，也避免桌外讨论被当成角色知识写进上下文。
 */
export type Channel = 'ic' | 'ooc' | 'rule';

/** 输入在队列里的五态（DESIGN.md §7.7.7）。 */
export type InputState = 'pending' | 'frozen' | 'deferred' | 'superseded' | 'done';

export interface TurnInput {
  seatId: string;
  sceneId: string;
  clientTurnId: string;
  text: string;
  channel: Channel;
  /** 提交时刻，用于批内按到达序结算 */
  atMs: number;
  replyTo?: string;
  audience?: string[];
}

export interface FrozenInput extends TurnInput {
  state: 'frozen';
}

/** 一个批次 = 一个回合（DESIGN.md §7.7.3）。 */
export interface TurnBatch {
  batchId: string;
  turnId: string;
  sceneId: string;
  inputs: FrozenInput[];
  frozenAt: number;
}

export type SubmitRejection =
  /** ooc / rule 通道不走批次，由调用方直接处理 */
  | 'channel_bypass'
  /** 同一 clientTurnId 已经收下过（幂等） */
  | 'duplicate'
  /** 已经关闭（进程在退出） */
  | 'closed';

export interface SubmitResult {
  accepted: boolean;
  clientTurnId: string;
  /** 预计还要等多久才冻结；用于 UI 显示「等待其他玩家…」 */
  waitMs: number;
  /** 排在这一条前面的条数（含其它场景） */
  backlog: number;
  reason?: SubmitRejection;
}

export interface BatcherOptions {
  /** 静默多久认为这一轮说完了 */
  idleMs?: number;
  /** 有人正在输入时延长到这个值 */
  typingIdleMs?: number;
  /** 从第一条到强制放行的硬上限 */
  maxMs?: number;
  /** 只有一条且没人在输入时的静默期 */
  singleMs?: number;
  /** 正在输入状态的存活时间，超过即失效 */
  typingTtlMs?: number;
  now: () => number;
  /** 冻结回调；seq 由上游分配 */
  onFreeze: (batch: TurnBatch) => void;
  /** id 生成，测试里注入确定性实现 */
  nextId?: (prefix: string) => string;
}

export const BATCH_IDLE_MS = 700;
export const BATCH_IDLE_TYPING_MS = 1200;
export const BATCH_MAX_MS = 1500;
export const BATCH_SINGLE_MS = 300;

interface Bucket {
  sceneId: string;
  inputs: TurnInput[];
  firstAt: number;
  lastAt: number;
  /** seatId → 过期时刻 */
  typing: Map<string, number>;
}

/**
 * 收集窗口状态机（DESIGN.md §7.7.2）。
 *
 * 之所以按场景分桶而不是按整桌：不同场景之间已经做了可见性隔离，
 * 让客厅里的三个人等地下室里的一对一，是纯粹的损失。
 *
 * 用 `tick()` 而不是自己起定时器：服务端只需要一个调度器轮询所有桶，
 * 测试里也能把时间捏在手里。
 */
export class TurnBatcher {
  readonly idleMs: number;
  readonly typingIdleMs: number;
  readonly maxMs: number;
  readonly singleMs: number;
  readonly typingTtlMs: number;

  private readonly now: () => number;
  private readonly onFreeze: (batch: TurnBatch) => void;
  private readonly nextId: (prefix: string) => string;
  private readonly buckets = new Map<string, Bucket>();
  private readonly seen = new Set<string>();
  private frozenCount = 0;
  private closed = false;

  constructor(options: BatcherOptions) {
    this.idleMs = options.idleMs ?? BATCH_IDLE_MS;
    this.typingIdleMs = options.typingIdleMs ?? BATCH_IDLE_TYPING_MS;
    this.maxMs = options.maxMs ?? BATCH_MAX_MS;
    this.singleMs = options.singleMs ?? BATCH_SINGLE_MS;
    this.typingTtlMs = options.typingTtlMs ?? 3000;
    this.now = options.now;
    this.onFreeze = options.onFreeze;
    let counter = 0;
    this.nextId =
      options.nextId ??
      ((prefix) => {
        counter += 1;
        return `${prefix}_${counter.toString(36)}`;
      });
  }

  submit(input: TurnInput): SubmitResult {
    if (this.closed) {
      return { accepted: false, clientTurnId: input.clientTurnId, waitMs: 0, backlog: 0, reason: 'closed' };
    }
    if (input.channel !== 'ic') {
      return { accepted: false, clientTurnId: input.clientTurnId, waitMs: 0, backlog: 0, reason: 'channel_bypass' };
    }
    if (this.seen.has(input.clientTurnId)) {
      return { accepted: false, clientTurnId: input.clientTurnId, waitMs: 0, backlog: 0, reason: 'duplicate' };
    }
    this.seen.add(input.clientTurnId);

    const now = this.now();
    const bucket = this.bucketOf(input.sceneId);
    bucket.inputs.push({ ...input, atMs: input.atMs || now });
    bucket.lastAt = now;
    if (bucket.inputs.length === 1) bucket.firstAt = now;

    return {
      accepted: true,
      clientTurnId: input.clientTurnId,
      waitMs: this.remainingMs(bucket, now),
      backlog: this.backlogBefore(bucket),
    };
  }

  /** 客户端声明「正在输入」，只用于延长窗口，不作为可靠信号。 */
  typing(seatId: string, sceneId: string): void {
    const bucket = this.bucketOf(sceneId);
    const now = this.now();
    bucket.typing.set(seatId, now + this.typingTtlMs);
    // 有人还在敲就把静默期从这一刻重新算起——否则「一直在敲」会被
    // 当成「一直没说话」，1.2 秒就把话截断了。
    if (bucket.inputs.length > 0) bucket.lastAt = now;
  }

  /** 冻结前撤回；已冻结的撤回不了。 */
  retract(clientTurnId: string): boolean {
    for (const bucket of this.buckets.values()) {
      const index = bucket.inputs.findIndex((input) => input.clientTurnId === clientTurnId);
      if (index >= 0) {
        bucket.inputs.splice(index, 1);
        this.seen.delete(clientTurnId);
        if (bucket.inputs.length === 0) {
          bucket.firstAt = 0;
          bucket.lastAt = 0;
        }
        return true;
      }
    }
    return false;
  }

  /** 由调度器周期性调用；到期的桶冻结并通过 `onFreeze` 交出去。 */
  tick(): TurnBatch[] {
    if (this.closed) return [];
    const now = this.now();
    const frozen: TurnBatch[] = [];

    for (const bucket of this.buckets.values()) {
      if (bucket.inputs.length === 0) continue;
      if (!this.shouldFreeze(bucket, now)) continue;

      const batch: TurnBatch = {
        batchId: this.nextId('b'),
        turnId: this.nextId('t'),
        sceneId: bucket.sceneId,
        inputs: bucket.inputs.map((input) => ({ ...input, state: 'frozen' as const })),
        frozenAt: now,
      };
      bucket.inputs = [];
      bucket.firstAt = 0;
      bucket.lastAt = 0;
      bucket.typing.clear();
      this.frozenCount += 1;
      this.onFreeze(batch);
      frozen.push(batch);
    }

    return frozen;
  }

  /** 当前所有场景里待处理的条数。 */
  pendingCount(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.inputs.length;
    return total;
  }

  pendingIn(sceneId: string): number {
    return this.buckets.get(sceneId)?.inputs.length ?? 0;
  }

  get batchesFrozen(): number {
    return this.frozenCount;
  }

  /** 关闭时把还挂着的输入全部交出去，避免玩家的话被静默丢弃。 */
  close(): TurnBatch[] {
    this.closed = true;
    const now = this.now();
    const batches: TurnBatch[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.inputs.length === 0) continue;
      const batch: TurnBatch = {
        batchId: this.nextId('b'),
        turnId: this.nextId('t'),
        sceneId: bucket.sceneId,
        inputs: bucket.inputs.map((input) => ({ ...input, state: 'frozen' as const })),
        frozenAt: now,
      };
      bucket.inputs = [];
      batches.push(batch);
    }
    return batches;
  }

  private bucketOf(sceneId: string): Bucket {
    let bucket = this.buckets.get(sceneId);
    if (bucket === undefined) {
      bucket = { sceneId, inputs: [], firstAt: 0, lastAt: 0, typing: new Map() };
      this.buckets.set(sceneId, bucket);
    }
    return bucket;
  }

  private activeTyping(bucket: Bucket, now: number): number {
    let count = 0;
    for (const [seatId, expiresAt] of bucket.typing) {
      if (expiresAt <= now) {
        bucket.typing.delete(seatId);
        continue;
      }
      count += 1;
    }
    return count;
  }

  private idleWindow(bucket: Bucket, now: number): number {
    const typing = this.activeTyping(bucket, now);
    if (typing > 0) return this.typingIdleMs;
    if (bucket.inputs.length === 1) return this.singleMs;
    return this.idleMs;
  }

  private shouldFreeze(bucket: Bucket, now: number): boolean {
    if (bucket.inputs.length === 0) return false;
    // 硬上限先判：无论有没有人在敲，1.5 秒必须放行
    if (now - bucket.firstAt >= this.maxMs) return true;
    return now - bucket.lastAt >= this.idleWindow(bucket, now);
  }

  private remainingMs(bucket: Bucket, now: number): number {
    const idle = this.idleWindow(bucket, now);
    const byIdle = bucket.lastAt + idle - now;
    const byMax = bucket.firstAt + this.maxMs - now;
    return Math.max(0, Math.min(byIdle, byMax));
  }

  private backlogBefore(bucket: Bucket): number {
    let total = 0;
    for (const other of this.buckets.values()) {
      total += other.inputs.length;
    }
    return Math.max(0, total - 1);
  }
}

/**
 * 覆盖性校验（DESIGN.md §7.7.5）：每个提交了行动的席位都必须在模型的
 * `acknowledged` 里出现，否则那句话说出去没人回应。
 */
export function missingSeats(batch: TurnBatch, acknowledged: readonly string[]): string[] {
  const got = new Set(acknowledged);
  const missing: string[] = [];
  for (const input of batch.inputs) {
    if (!got.has(input.seatId) && !missing.includes(input.seatId)) missing.push(input.seatId);
  }
  return missing;
}
