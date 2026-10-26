import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { NewEvent, ReadEventsOptions, StoredEvent, Visibility } from './types.ts';

/**
 * 事件日志的读写（DESIGN.md §3.5 / §6.2）。
 *
 * `table_events` 是 append-only 的权威日志：状态不是存下来的，是从这里重放出来的。
 * 所以这里只提供两类操作——追加、按 seq 读。没有 update，没有 delete。
 */

interface EventRow {
  readonly id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly type: string;
  readonly version: number;
  readonly payload: string;
  readonly visibility: string;
  readonly actor_seat_id: string | null;
  readonly turn_id: string | null;
  readonly client_turn_id: string | null;
  readonly created_at: number;
}

const INSERT_SQL = `
INSERT INTO table_events
  (id, session_id, seq, type, version, payload, visibility,
   actor_seat_id, turn_id, client_turn_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** 内部辅助：把字符串列解析回对象。坏 JSON 直接抛，不静默吞。 */
function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`table_events.${what} 不是合法 JSON：${raw.slice(0, 120)}`);
  }
}

function toStored(row: EventRow): StoredEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    version: row.version,
    payload: parseJson<unknown>(row.payload, 'payload'),
    visibility: parseJson<Visibility>(row.visibility, 'visibility'),
    actorSeatId: row.actor_seat_id,
    turnId: row.turn_id,
    clientTurnId: row.client_turn_id,
    createdAt: row.created_at,
  };
}

/**
 * 追加一批事件。**必须在写事务内调用**（`WriteQueue.tx` 的回调里），
 * 否则 seq 的「读最大值再 +1」会有竞态。
 *
 * 同一批里的 `clientTurnId` 若已存在，返回已存在的那条、不重复插入——
 * 这是断线重连后客户端重复提交的兜底（§11.4 / §13.3）。
 */
export function appendEvents(
  db: DatabaseSync,
  input: readonly NewEvent[],
): StoredEvent[] {
  const first = input[0];
  if (first === undefined) return [];

  const sessionId = first.sessionId;
  for (const event of input) {
    if (event.sessionId !== sessionId) {
      throw new Error('一次 appendEvents 只能写同一会话的事件');
    }
  }

  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM table_events WHERE session_id = ?')
    .get(sessionId) as { max_seq: number } | undefined;
  let seq = row?.max_seq ?? 0;

  const stored: StoredEvent[] = [];

  for (const event of input) {
    if (event.clientTurnId !== undefined && event.clientTurnId !== null) {
      const existing = db
        .prepare(
          'SELECT * FROM table_events WHERE session_id = ? AND client_turn_id = ? LIMIT 1',
        )
        .get(sessionId, event.clientTurnId) as EventRow | undefined;
      if (existing !== undefined) {
        stored.push(toStored(existing));
        continue;
      }
    }

    seq += 1;
    const createdAt = Date.now();
    const id = randomUUID();
    const version = event.version ?? 1;
    const visibility = JSON.stringify(event.visibility ?? { kind: 'public' });
    const payload = JSON.stringify(event.payload ?? null);

    db.prepare(INSERT_SQL).run(
      id,
      sessionId,
      seq,
      event.type,
      version,
      payload,
      visibility,
      event.actorSeatId ?? null,
      event.turnId ?? null,
      event.clientTurnId ?? null,
      createdAt,
    );

    stored.push({
      id,
      sessionId,
      seq,
      type: event.type,
      version,
      payload: event.payload ?? null,
      visibility: event.visibility ?? { kind: 'public' },
      actorSeatId: event.actorSeatId ?? null,
      turnId: event.turnId ?? null,
      clientTurnId: event.clientTurnId ?? null,
      createdAt,
    });
  }

  return stored;
}

/** 按 seq 顺序读事件。玩家侧检索（§7.13）就是倒序调这个。 */
export function readEvents(db: DatabaseSync, options: ReadEventsOptions): StoredEvent[] {
  const conditions = ['session_id = ?'];
  const params: Array<string | number> = [options.sessionId];

  if (options.afterSeq !== undefined) {
    conditions.push('seq > ?');
    params.push(options.afterSeq);
  }

  if (options.types !== undefined && options.types.length > 0) {
    conditions.push(`type IN (${options.types.map(() => '?').join(',')})`);
    params.push(...options.types);
  }

  const order = options.descending === true ? 'DESC' : 'ASC';
  const limit = options.limit ?? 1000;

  const rows = db
    .prepare(
      `SELECT * FROM table_events WHERE ${conditions.join(' AND ')} ORDER BY seq ${order} LIMIT ?`,
    )
    .all(...params, limit) as unknown as EventRow[];

  return rows.map(toStored);
}

export function countEvents(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM table_events WHERE session_id = ?')
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function lastSeq(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM table_events WHERE session_id = ?')
    .get(sessionId) as { s: number } | undefined;
  return row?.s ?? 0;
}
