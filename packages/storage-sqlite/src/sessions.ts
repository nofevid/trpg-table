import type { DatabaseSync } from 'node:sqlite';

import type { NewSession, StoredSession } from './types.ts';

interface SessionRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly ruleset_id: string;
  readonly module_id: string | null;
  readonly title: string;
  readonly settings: string;
}

function toSession(row: SessionRow): StoredSession {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row.settings) as Record<string, unknown>;
  } catch {
    // 存进去的时候校验过 json_valid，走到这里说明有人手改过库
    settings = {};
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rulesetId: row.ruleset_id,
    moduleId: row.module_id,
    title: row.title,
    settings,
  };
}

export function createSession(db: DatabaseSync, input: NewSession): StoredSession {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, created_at, updated_at, ruleset_id, module_id, title, settings)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    now,
    now,
    input.rulesetId,
    input.moduleId ?? null,
    input.title ?? '',
    JSON.stringify(input.settings ?? {}),
  );

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(input.id) as
    | SessionRow
    | undefined;
  if (row === undefined) throw new Error('会话写入后读不回来，数据库可能不健康');
  return toSession(row);
}

export function getSession(db: DatabaseSync, id: string): StoredSession | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row === undefined ? null : toSession(row);
}

export function listSessions(db: DatabaseSync): StoredSession[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as
    SessionRow[];
  return rows.map(toSession);
}

export function touchSession(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}
