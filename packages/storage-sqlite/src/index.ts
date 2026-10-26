import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { backup, type BackupOptions, type BackupResult } from './backup.ts';
import { checkpoint, integrityCheck, openDatabase } from './connection.ts';
import { appendEvents, countEvents, lastSeq, readEvents } from './events.ts';
import { migrate, type MigrationResult } from './migrate.ts';
import { createSession, getSession, listSessions, touchSession } from './sessions.ts';
import type { NewEvent, NewSession, ReadEventsOptions, StoredEvent, StoredSession } from './types.ts';
import { WriteQueue } from './writer.ts';

export * from './types.ts';
export { openDatabase, checkpoint, integrityCheck } from './connection.ts';
export { WriteQueue } from './writer.ts';
export { migrate, loadMigrations, currentVersion } from './migrate.ts';
export { backup, backupTo, pruneBackups, restoreFromBackup } from './backup.ts';
export { appendEvents, readEvents, countEvents, lastSeq } from './events.ts';
export { createSession, getSession, listSessions, touchSession } from './sessions.ts';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface StorageOptions {
  /** `:memory:` 用于测试；正式运行是 `<dataDir>/trpg.db`。 */
  readonly path: string;
  /** 迁移目录，默认包内的 `migrations/`。 */
  readonly migrationsDir?: string;
  readonly wal?: boolean;
}

/**
 * 存储层门面。
 *
 * 一个进程里**只能有一个** `Storage` 实例（DESIGN.md §6.6 (2)）。
 * 这里不强制，但所有写入都经过同一个 `WriteQueue`，从使用方式上把并发挡在外面。
 */
export class Storage {
  readonly db: DatabaseSync;
  readonly journalMode: string;
  readonly writer: WriteQueue;
  readonly migration: MigrationResult;
  private closed = false;

  private constructor(db: DatabaseSync, journalMode: string, migration: MigrationResult) {
    this.db = db;
    this.journalMode = journalMode;
    this.writer = new WriteQueue(db);
    this.migration = migration;
  }

  static open(options: StorageOptions): Storage {
    const { db, journalMode } = openDatabase(options.path, { wal: options.wal });
    const migration = migrate(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    return new Storage(db, journalMode, migration);
  }

  /** 在写事务里跑一段同步代码。异步逻辑（LLM、文件 IO）必须在事务外。 */
  tx<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    this.assertOpen();
    return this.writer.tx(fn);
  }

  async appendEvents(input: readonly NewEvent[]): Promise<StoredEvent[]> {
    if (input.length === 0) return [];
    return this.tx((db) => appendEvents(db, input));
  }

  readEvents(options: ReadEventsOptions): StoredEvent[] {
    this.assertOpen();
    return readEvents(this.db, options);
  }

  countEvents(sessionId: string): number {
    return countEvents(this.db, sessionId);
  }

  lastSeq(sessionId: string): number {
    return lastSeq(this.db, sessionId);
  }

  async createSession(input: NewSession): Promise<StoredSession> {
    return this.tx((db) => createSession(db, input));
  }

  getSession(id: string): StoredSession | null {
    return getSession(this.db, id);
  }

  listSessions(): StoredSession[] {
    return listSessions(this.db);
  }

  touchSession(id: string): Promise<void> {
    return this.tx((db) => touchSession(db, id));
  }

  /** 备份。**不能**在事务里调——`VACUUM INTO` 会报「不能在事务内」。 */
  async backup(options: BackupOptions): Promise<BackupResult> {
    this.assertOpen();
    await this.writer.drain();
    return backup(this.db, options);
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    return integrityCheck(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer.drain();
    checkpoint(this.db);
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Storage 已关闭');
  }
}
