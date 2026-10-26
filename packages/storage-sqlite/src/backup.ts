import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 备份（DESIGN.md §6.6 (5)）。
 *
 * 用 `VACUUM INTO` 而不是复制文件：它会在一个一致性快照上重写整库，
 * 复制 `.db` 在 WAL 模式下得到的可能是一个缺了最新事务的半成品。
 * 代价是要跑一遍写盘，所以只在「开局前 / 每 60 分钟 / 退出前」做，
 * 不做在每条事件上。
 */

/** SQL 字符串字面量转义：单引号翻倍。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function backupTo(db: DatabaseSync, destPath: string): string {
  if (existsSync(destPath)) {
    throw new Error(`备份目标已存在，拒绝覆盖：${destPath}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  db.exec(`VACUUM INTO ${sqlString(destPath)}`);
  return destPath;
}

export interface BackupOptions {
  /** 目录，通常是 `<dataDir>/backups`。 */
  readonly dir: string;
  /** 文件名前缀，默认 `auto`。 */
  readonly prefix?: string;
  /** 保留几份，默认 10。 */
  readonly keep?: number;
  /** 注入时钟，测试用。 */
  readonly now?: Date;
}

function stamp(date: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export interface BackupResult {
  readonly path: string;
  readonly removed: readonly string[];
}

export function backup(db: DatabaseSync, options: BackupOptions): BackupResult {
  const prefix = options.prefix ?? 'auto';
  mkdirSync(options.dir, { recursive: true });

  const name = `${prefix}-${stamp(options.now ?? new Date())}.db`;
  const path = backupTo(db, join(options.dir, name));

  const removed = pruneBackups(options.dir, options.keep ?? 10, prefix);
  return { path, removed };
}

/** 按修改时间从新到旧保留 `keep` 份，其余删掉。返回被删的文件名。 */
export function pruneBackups(dir: string, keep: number, prefix = 'auto'): string[] {
  if (keep < 1) throw new Error('至少要保留 1 份备份');

  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.db'))
    .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const doomed = files.slice(keep);
  for (const file of doomed) {
    rmSync(file.path, { force: true });
  }
  return doomed.map((f) => f.name);
}

/** 从备份恢复：直接覆盖目标路径。调用方必须先关掉所有连接。 */
export function restoreFromBackup(backupPath: string, dbPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`备份不存在：${backupPath}`);
  }
  // 复制前先清掉可能残留的 -wal / -shm，否则 SQLite 会拿旧日志去「恢复」新文件
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  copyFileSync(backupPath, dbPath);
}
