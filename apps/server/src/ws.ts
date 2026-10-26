import type { WebSocket } from 'ws';

import type { Room, Seat } from './room.ts';

/** 信封与 DESIGN.md §13.2 一致：`{ id, type, payload }`，事件额外带 `seq`。 */
export interface Envelope {
  id: string;
  type: string;
  payload: unknown;
  seq?: number;
}

export interface WsDeps {
  rooms: Map<string, Room>;
  /** 房间不存在时按需创建（服务端只持有内存态，事件流才是真相）。 */
  ensureRoom: (sessionId: string) => Room | undefined;
  defaultSeat: (sessionId: string) => Seat;
}

let messageCounter = 0;
const nextId = (): string => `m${(messageCounter += 1)}`;

function send(socket: WebSocket, type: string, payload: unknown, id = nextId()): void {
  const envelope: Envelope = { id, type, payload };
  try {
    socket.send(JSON.stringify(envelope));
  } catch {
    // 对端已断开，等 close 事件清理
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 处理一条上行报文。
 * 上行类型（§13.2）：`room.join` / `turn.submit` / `seat.typing` / `player.input.retract` / `room.replay`
 */
export function handleClientMessage(socket: WebSocket, raw: string, deps: WsDeps): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(socket, 'error', { code: 'BAD_ENVELOPE', message: '报文不是合法 JSON' });
    return;
  }

  const envelope = asRecord(parsed);
  const type = str(envelope['type']);
  const payload = asRecord(envelope['payload']);
  const id = str(envelope['id'], nextId());
  const sessionId = str(payload['sessionId'], str(envelope['sessionId']));

  const room = deps.ensureRoom(sessionId);
  if (room === undefined) {
    send(socket, 'error', { code: 'SESSION_NOT_FOUND', message: `没有这一局：${sessionId || '（未指定）'}` }, id);
    return;
  }

  switch (type) {
    case 'room.join': {
      const seatId = str(payload['seatId'], deps.defaultSeat(sessionId).seatId);
      const seat: Seat = {
        seatId,
        role: (str(payload['role'], 'player') as Seat['role']) ?? 'player',
        actorIds: Array.isArray(payload['actorIds']) ? (payload['actorIds'] as string[]) : [],
        factions: Array.isArray(payload['factions']) ? (payload['factions'] as string[]) : [],
      };
      room.join(seat, socket);
      const afterSeq = typeof payload['afterSeq'] === 'number' ? payload['afterSeq'] : 0;
      const backlog = room.replay(seatId, afterSeq);
      send(socket, 'room.joined', { sessionId, seatId, role: seat.role, replayed: backlog.length }, id);
      for (const event of backlog) {
        send(socket, event.type, event.payload, `r${event.seq}`);
      }
      return;
    }

    case 'turn.submit': {
      const seatId = str(payload['seatId']);
      const text = str(payload['text']).trim();
      const channel = str(payload['channel'], 'ic');
      if (text === '') {
        send(socket, 'turn.batch_ack', { accepted: [], reason: 'empty_text' }, id);
        return;
      }
      if (seatId === '') {
        send(socket, 'error', { code: 'SEAT_REQUIRED', message: '提交输入必须带 seatId' }, id);
        return;
      }

      const result = room.submit({
        seatId,
        sceneId: str(payload['sceneId'], 'default'),
        clientTurnId: str(payload['clientTurnId'], `ct_${Date.now().toString(36)}`),
        text,
        channel: channel === 'ooc' || channel === 'rule' ? channel : 'ic',
        // 到达时间由服务端记，客户端声称的时间只作参考（§7.7.4 用到达序结算）
        atMs: Date.now(),
        replyTo: typeof payload['replyTo'] === 'string' ? payload['replyTo'] : undefined,
        audience: Array.isArray(payload['audience']) ? (payload['audience'] as string[]) : undefined,
      });

      send(
        socket,
        'turn.batch_ack',
        {
          clientTurnId: result.clientTurnId,
          accepted: result.accepted ? [result.clientTurnId] : [],
          reason: result.reason,
          waitMs: result.waitMs,
          backlog: result.backlog,
          busy: room.isBusy,
        },
        id,
      );
      return;
    }

    case 'seat.typing': {
      room.typing(str(payload['seatId']), str(payload['sceneId'], 'default'));
      return;
    }

    case 'player.input.retract': {
      const clientTurnId = str(payload['clientTurnId']);
      const ok = room.retract(clientTurnId);
      send(socket, 'turn.retract_ack', { clientTurnId, retracted: ok }, id);
      return;
    }

    case 'room.replay': {
      const seatId = str(payload['seatId']);
      const afterSeq = typeof payload['afterSeq'] === 'number' ? payload['afterSeq'] : 0;
      const backlog = room.replay(seatId, afterSeq);
      send(socket, 'room.replayed', { count: backlog.length }, id);
      for (const event of backlog) {
        send(socket, event.type, event.payload, `r${event.seq}`);
      }
      return;
    }

    default:
      send(socket, 'error', { code: 'UNKNOWN_TYPE', message: `不认识的上行类型：${type}` }, id);
  }
}
