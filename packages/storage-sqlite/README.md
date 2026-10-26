# storage-sqlite

SQLite 存储层：连接与 PRAGMA、单写者事务队列、迁移、备份、事件日志读写。

用 Node 24 内置的 `node:sqlite`（SQLite 3.53.4），**不需要编译原生模块**——
这一点在 Electron 里会变（Electron 的 Node 版本还没跟上），所以接口是刻意做薄的，
换成 better-sqlite3 时只需要改 `connection.ts` 与 `writer.ts` 两处。

## 三条纪律

这三条不是风格问题，破了任何一条都会在某个用户机器上变成难查的故障。

**一、一个进程只有一个 `Storage` 实例。**

SQLite 的 WAL 允许多进程读写，但跨进程写锁的等待会让一次 5ms 的写变成 5s
（`busy_timeout` 打满）。与其靠重试，不如从设计上保证只有一个写者。
`Storage.open()` 不会阻止你开第二个，但**调用方必须自己加锁文件**（见 `DESIGN.md` §6.6 (2)）。

**二、所有写操作都走 `BEGIN IMMEDIATE`。**

`db.transaction(fn)()` 那一套默认开的是 **deferred** 事务：先读、要写时才尝试升级锁，
而升级可能失败。我们既然已经串行化了，就没有理由不用「一开始就拿写锁」。

**三、同步回调里不许有异步逻辑。**

`tx()` 的回调是同步的。一旦在里面 `await` 一个 LLM 调用，写锁会被持有一整次网络往返
（几秒到几十秒），所有其他写入排在后面。所以一个回合拆成两个事务：

```
T1  收到输入 → 插入 turn.started + 玩家输入      （毫秒级）
     …… LLM 调用，不持锁，几秒 ……
T2  模型返回 → 一次写完全部事件与状态变更        （毫秒级）
```

T2 失败则整回合回滚：叙事与状态不会分裂成「话说了一半，血没掉」。

## 用法

```ts
import { Storage } from '@trpg/storage-sqlite';

const storage = Storage.open({ path: 'D:/data/trpg.db' });
// 自动跑 migrations/00N_*.sql，user_version 从 0 推到最新

await storage.createSession({ id: 's1', rulesetId: 'coc7e', title: '八月二十二日' });

// 一个事务写一批事件——seq 自动连续分配
await storage.appendEvents([
  { sessionId: 's1', type: 'dice.result', payload: { roll: 31 }, turnId: 't_78' },
  { sessionId: 's1', type: 'narration.delta', payload: { text: '门开了' }, turnId: 't_78' },
]);

// 断线重连补发（§13.3）
const missed = storage.readEvents({ sessionId: 's1', afterSeq: 1450 });

// 玩家侧检索从后往前翻（§7.13）
const recent = storage.readEvents({ sessionId: 's1', descending: true, limit: 50 });

// 退出前
await storage.backup({ dir: 'D:/data/backups' });  // VACUUM INTO，留 10 份
await storage.close();                             // checkpoint + close
```

## 压测（Windows / NVMe / Node 24）

```
单条事务      n=2000  p50=0.040ms  p95=0.074ms  p99=0.410ms
批内十条/条    n= 200  p50=0.016ms  p95=0.024ms  p99=0.347ms
读 500 条                        2.83ms
VACUUM INTO 备份                  7.09ms
```

`DESIGN.md` §14.1 定的目标是「单条事件写入 P95 < 2ms」，实测 **0.074ms**，余量 27 倍。
真跑一局是每 10–20 秒一次交互，写入压力比这低四个数量级——
`npm run bench:storage` 可以复现。

## 已知边界

- **迁移不可回退**。`PRAGMA user_version` 只往前推；要回退只能从备份恢复。
- **`ALTER TABLE` 受限**：SQLite 只支持 ADD COLUMN / RENAME COLUMN，改列类型得建新表搬数据。
- **全部表用 STRICT**：写错类型会直接报错，而不是像默认行为那样存成字符串。
- `VACUUM INTO` 不能在事务内调用——`Storage.backup()` 会先 `drain()` 队列。
