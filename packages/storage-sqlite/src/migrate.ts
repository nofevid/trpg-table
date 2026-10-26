import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移（DESIGN.md §6.6 (4)）。
 *
 * 用 `PRAGMA user_version` 当版本号，文件名前缀的数字就是目标版本。
 * 全部在一个事务里推进：任何一条语句失败就整体回滚，进程拒绝启动。
 *
 * 为什么不用「迁移表」：多一张表就多一处可能与真实 schema 漂移的地方，
 * 而 `user_version` 是 SQLite 自己维护的，不会说谎。
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

const FILE_PATTERN = /^(\d+)_(.+)\.sql$/;

export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];

  for (const file of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;

    const version = Number.parseInt(match[1] as string, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`迁移文件名必须先导正版本号：${file}`);
    }

    migrations.push({
      version,
      name: match[2] as string,
      sql: readFileSync(join(dir, file), 'utf8'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1] as Migration;
    const curr = migrations[i] as Migration;
    if (prev.version === curr.version) {
      throw new Error(`迁移版本号重复：${prev.version}`);
    }
    if (curr.version !== prev.version + 1) {
      throw new Error(`迁移版本号必须连续，缺 ${prev.version + 1}`);
    }
  }

  return migrations;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * 把库推进到最新版本。返回实际做了什么，方便启动日志记录。
 *
 * 注意：调用方必须确保这是**唯一**的连接（见 `acquireWriterLock`）。
 */
export function migrate(db: DatabaseSync, dir: string): MigrationResult {
  const migrations = loadMigrations(dir);
  const from = currentVersion(db);

  if (migrations.length === 0) {
    return { from, to: from, applied: [] };
  }

  const latest = (migrations[migrations.length - 1] as Migration).version;
  if (from > latest) {
    throw new Error(
      `数据库版本 ${from} 高于程序支持的 ${latest}——这份数据来自更新的版本，请升级程序`,
    );
  }

  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) {
    return { from, to: from, applied: [] };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      // user_version 不能参数化；version 已经过 parse 校验，是纯数字
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略：原始错误更有信息量
    }
    throw new Error(
      `迁移失败（${from} → ${latest}），数据库未改动：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return { from, to: latest, applied: pending.map((m) => `${m.version}_${m.name}`) };
}
