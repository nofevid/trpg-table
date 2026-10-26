import { DatabaseSync } from 'node:sqlite';

/**
 * 打开数据库并设定 PRAGMA（DESIGN.md §6.6 (1)）。
 *
 * 顺序有讲究：`journal_mode = WAL` 必须在任何写之前设，
 * 而且它会重建数据库文件头，所以不能放在事务里。
 */
export interface OpenDatabaseOptions {
  /**
   * 是否开 WAL。`:memory:` 下 WAL 无意义（SQLite 会静默退回 memory），
   * 默认由调用方传入的路径推断。
   */
  readonly wal?: boolean;
  /** 应用层是否自己负责加锁（默认 true，见 `acquireWriterLock`）。 */
  readonly readOnly?: boolean;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** 实际生效的 journal_mode，测试要断言它是 `wal`。 */
  readonly journalMode: string;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): OpenedDatabase {
  const db = new DatabaseSync(path);

  const inMemory = path === ':memory:' || path === '';
  const wantWal = options.wal ?? !inMemory;

  // PRAGMA 不支持参数绑定，这里的值全是常量，没有注入面。
  const journal = db.prepare(`PRAGMA journal_mode = ${wantWal ? 'WAL' : 'DELETE'}`).get() as
    | { journal_mode?: string }
    | undefined;

  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  return { db, journalMode: journal?.journal_mode ?? 'unknown' };
}

/** 退出前调用：把 WAL 落回主文件，避免留下很大的 `-wal`。 */
export function checkpoint(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** 启动时快速自检（§16 R13 的缓解措施之一）。 */
export function integrityCheck(db: DatabaseSync): { ok: boolean; messages: string[] } {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
  const messages = rows.map((r) => r.integrity_check ?? '').filter((s) => s.length > 0);
  return { ok: messages.length === 1 && messages[0] === 'ok', messages };
}
