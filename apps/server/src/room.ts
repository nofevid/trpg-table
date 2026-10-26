import type { WebSocket } from 'ws';

import type { Storage } from '../../../packages/storage-sqlite/src/index.ts';
import type { LlmProvider } from '../../../packages/llm-gateway/src/index.ts';
import type { ToolRegistry } from '../../../packages/tools/src/index.ts';
import type { RandomSource } from '../../../packages/rules-core/src/index.ts';
import { TurnBatcher, type SubmitResult, type TurnBatch, type TurnInput } from '../../../packages/turn-batcher/src/index.ts';
import { runTurn, type SceneLike } from '../../../packages/turn-pipeline/src/index.ts';
import { visibleTo, type Viewer, type Visibility } from '../../../packages/visibility/src/index.ts';

export interface Seat {
  seatId: string;
  role: 'gm' | 'player' | 'spectator';
  actorIds: string[];
  factions: string[];
}

export interface RoomOptions {
  sessionId: string;
  storage: Storage;
  provider: LlmProvider;
  tools: ToolRegistry;
  random: RandomSource;
  sceneOf?: (sceneId: string) => SceneLike | undefined;
  charactersOf?: () => Record<string, { name: string; skills: Record<string, number> }>;
  actorsOf?: (seatId: string) => string[];
  /** 调度间隔；测试可调小 */
  tickMs?: number;
}

interface Client {
  socket: WebSocket;
  viewer: Viewer;
}

/**
 * 一局游戏的内存态：席位、连接、批次窗口。
 * 持久化的一切都在 storage 里，这里丢了可以从事件流重放。
 */
export class Room {
  readonly sessionId: string;
  private readonly options: RoomOptions;
  private readonly seats = new Map<string, Seat>();
  private readonly clients = new Set<Client>();
  private readonly batcher: TurnBatcher;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private closed = false;
  private queueDepth = 0;

  constructor(options: RoomOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.batcher = new TurnBatcher({
      now: () => Date.now(),
      onFreeze: (batch) => {
        this.queueDepth = Math.max(0, this.queueDepth - batch.inputs.length);
        void this.runBatch(batch);
      },
    });
  }

  get seatCount(): number {
    return this.seats.size;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  seat(seatId: string): Seat | undefined {
    return this.seats.get(seatId);
  }

  join(seat: Seat, socket: WebSocket): void {
    this.seats.set(seat.seatId, seat);
    const viewer: Viewer = {
      seatId: seat.seatId,
      role: seat.role,
      actorIds: seat.actorIds,
      factions: seat.factions,
      seq: 0,
    };
    this.clients.add({ socket, viewer });
    if (this.timer === undefined && !this.closed) this.start();
  }

  leave(socket: WebSocket): void {
    for (const client of this.clients) {
      if (client.socket === socket) this.clients.delete(client);
    }
  }

  /** 提交一条输入；ooc / rule 直接旁路返回，不进批次。 */
  submit(input: TurnInput): SubmitResult {
    const result = this.batcher.submit(input);
    if (result.accepted) this.queueDepth += 1;
    return result;
  }

  typing(seatId: string, sceneId: string): void {
    this.batcher.typing(seatId, sceneId);
  }

  retract(clientTurnId: string): boolean {
    const ok = this.batcher.retract(clientTurnId);
    if (ok) this.queueDepth = Math.max(0, this.queueDepth - 1);
    return ok;
  }

  /** 断线重连补发（§13.3）：只发这个席位看得见的、seq 大于 afterSeq 的。 */
  replay(seatId: string, afterSeq: number): Array<{ seq: number; type: string; payload: unknown }> {
    const seat = this.seats.get(seatId);
    if (seat === undefined) return [];
    const viewer: Viewer = {
      seatId,
      role: seat.role,
      actorIds: seat.actorIds,
      factions: seat.factions,
      seq: afterSeq,
    };
    const events = this.options.storage.readEvents({ sessionId: this.sessionId, afterSeq, limit: 1000 });
    const out: Array<{ seq: number; type: string; payload: unknown }> = [];
    for (const event of events) {
      const visibility = event.visibility as Visibility;
      if (visibleTo(viewer, visibility)) out.push({ seq: event.seq, type: event.type, payload: event.payload });
    }
    return out;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.batcher.tick(), this.options.tickMs ?? 100);
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  close(): void {
    this.stop();
    // 挂起但未冻结的输入直接丢弃——关服时不再发起新的模型调用
    this.batcher.close();
    for (const client of this.clients) client.socket.close();
    this.clients.clear();
  }

  private async runBatch(batch: TurnBatch): Promise<void> {
    if (this.busy) {
      // 单 turn 在途（§7.7.7）：把这一批退回队列，下一轮再冻结
      for (const input of batch.inputs) {
        this.batcher.submit({ ...input, clientTurnId: `${input.clientTurnId}#retry` });
      }
      return;
    }
    this.busy = true;
    try {
      const outcome = await runTurn(batch, {
        provider: this.options.provider,
        tools: this.options.tools,
        random: this.options.random,
        sceneOf: this.options.sceneOf,
        charactersOf: this.options.charactersOf,
        actorsOf: this.options.actorsOf,
      });

      if (!outcome.ok) {
        this.broadcastRaw({
          type: 'error',
          payload: { code: outcome.error?.code ?? 'TURN_FAILED', message: outcome.error?.message ?? '这一轮没有产生叙述' },
          visibility: { kind: 'public' },
        });
        return;
      }

      const stored = await this.options.storage.appendEvents(
        outcome.events.map((event) => ({
          sessionId: this.sessionId,
          type: event.type,
          payload: event.payload,
          visibility: event.visibility as unknown as Record<string, unknown>,
          turnId: batch.turnId,
        })),
      );

      for (const event of stored) {
        this.broadcastRaw({
          type: event.type,
          payload: event.payload,
          visibility: event.visibility as unknown as Visibility,
          seq: event.seq,
        });
      }
    } finally {
      this.busy = false;
    }
  }

  private broadcastRaw(message: { type: string; payload: unknown; visibility: Visibility; seq?: number }): void {
    for (const client of this.clients) {
      if (!visibleTo(client.viewer, message.visibility)) continue;
      this.send(client, {
        id: `e${message.seq ?? 0}`,
        type: message.type,
        payload: message.payload,
        seq: message.seq,
      });
    }
  }

  private send(client: Client, message: unknown): void {
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      this.clients.delete(client);
    }
  }
}
