import type { DatabaseSync } from 'node:sqlite';

/**
 * 单写者队列（DESIGN.md §6.6 (2)）。
 *
 * 两个约束合起来才有意义：
 *   1. 同一时刻只有**一个**事务在跑（队列 concurrency = 1）；
 *   2. 事务一开始就 `BEGIN IMMEDIATE` 取写锁，而不是等第一条写语句时才升级。
 *
 * 第 2 点是 `db.transaction(fn)()` 不能替代的：那边默认开的是 deferred，
 * 先读后写会在升级时拿到 SQLITE_BUSY，而我们已经承诺「不会有人跟我抢」。
 *
 * 代价：一次写事务的耗时 = 真实 IO。所以 **LLM 调用绝不能放进 tx()**。
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 排队执行一个写事务。回调必须是同步的——异步代码会把写锁拖到网络往返结束。 */
  tx<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const run = (): T => {
      if (this.depth > 0) {
        throw new Error('tx() 不可重入：一个事务里不能再开事务');
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.depth += 1;
      try {
        const result = fn(this.db);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // 回滚失败通常意味着事务已经被 SQLite 自己结束了，原始错误更重要
        }
        throw error;
      } finally {
        this.depth -= 1;
      }
    };

    // 前一个任务无论成败，下一个都要能跑
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 等待队列排空（退出前调用，确保没有半个事务）。 */
  async drain(): Promise<void> {
    await this.tail;
  }

  /** 是否正处在事务中——测试与断言用。 */
  get inTransaction(): boolean {
    return this.depth > 0;
  }
}
