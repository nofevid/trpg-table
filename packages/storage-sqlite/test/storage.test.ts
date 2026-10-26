import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/index.ts';

const LOCAL = join(process.cwd(), '.local');

function scratch(): string {
  mkdirSync(LOCAL, { recursive: true });
  return mkdtempSync(join(LOCAL, 'storage-'));
}

function dbPath(dir: string): string {
  return join(dir, 'trpg.db');
}

async function withStorage(fn: (storage: Storage, dir: string) => Promise<void>): Promise<void> {
  const dir = scratch();
  const storage = Storage.open({ path: dbPath(dir) });
  try {
    await fn(storage, dir);
  } finally {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('迁移建出表，user_version 推进到 1', async () => {
  await withStorage(async (storage) => {
    assert.equal(storage.migration.from, 0);
    assert.equal(storage.migration.to, 1);
    assert.deepEqual(storage.migration.applied, ['1_init']);

    const tables = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('table_events'));
  });
});

test('WAL 生效', async () => {
  await withStorage(async (storage) => {
    assert.equal(storage.journalMode, 'wal');
  });
});

test('事件按 seq 连续分配，读回来顺序对', async () => {
  await withStorage(async (storage) => {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e', title: '测试局' });

    const written = await storage.appendEvents([
      { sessionId: 's1', type: 'turn.started', payload: { turnId: 't1' } },
      { sessionId: 's1', type: 'dice.result', payload: { roll: 31 } },
      { sessionId: 's1', type: 'narration.delta', payload: { text: '门开了' } },
    ]);

    assert.deepEqual(
      written.map((e) => e.seq),
      [1, 2, 3],
    );

    const read = storage.readEvents({ sessionId: 's1' });
    assert.deepEqual(
      read.map((e) => e.type),
      ['turn.started', 'dice.result', 'narration.delta'],
    );
    // payload 往返后仍是对象，不是字符串
    assert.equal((read[1]?.payload as { roll: number }).roll, 31);
  });
});

test('同一 clientTurnId 重复提交只落一条（幂等）', async () => {
  await withStorage(async (storage) => {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e' });

    const first = await storage.appendEvents([
      { sessionId: 's1', type: 'player.input', payload: { text: '我推门' }, clientTurnId: 'ct_1' },
    ]);
    const again = await storage.appendEvents([
      { sessionId: 's1', type: 'player.input', payload: { text: '我推门' }, clientTurnId: 'ct_1' },
    ]);

    assert.equal(storage.countEvents('s1'), 1);
    assert.equal(again[0]?.id, first[0]?.id);
    assert.equal(again[0]?.seq, first[0]?.seq);
  });
});

test('afterSeq / descending / types 过滤', async () => {
  await withStorage(async (storage) => {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e' });
    await storage.appendEvents([
      { sessionId: 's1', type: 'a', payload: 1 },
      { sessionId: 's1', type: 'b', payload: 2 },
      { sessionId: 's1', type: 'a', payload: 3 },
      { sessionId: 's1', type: 'c', payload: 4 },
    ]);

    assert.deepEqual(
      storage.readEvents({ sessionId: 's1', afterSeq: 2 }).map((e) => e.seq),
      [3, 4],
    );

    assert.deepEqual(
      storage.readEvents({ sessionId: 's1', descending: true, limit: 2 }).map((e) => e.seq),
      [4, 3],
    );

    assert.deepEqual(
      storage.readEvents({ sessionId: 's1', types: ['a'] }).map((e) => e.seq),
      [1, 3],
    );
  });
});

test('事务回滚后一条都没落', async () => {
  await withStorage(async (storage) => {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e' });

    await assert.rejects(
      storage.tx((db) => {
        db.prepare(
          `INSERT INTO table_events (id, session_id, seq, type, payload, created_at)
           VALUES ('e1', 's1', 1, 'x', '{}', ?)`,
        ).run(Date.now());
        throw new Error('模型返回了非法 JSON');
      }),
      /模型返回了非法 JSON/,
    );

    assert.equal(storage.countEvents('s1'), 0);
    // 事务确实结束了，下一个事务能正常开
    await storage.appendEvents([{ sessionId: 's1', type: 'ok', payload: null }]);
    assert.equal(storage.countEvents('s1'), 1);
  });
});

test('并发提交被串行化，seq 不重复也不跳号', async () => {
  await withStorage(async (storage) => {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e' });

    const batches = Array.from({ length: 12 }, (_, i) =>
      storage.appendEvents([
        { sessionId: 's1', type: 'player.input', payload: { i }, clientTurnId: `ct_${i}` },
      ]),
    );

    const results = await Promise.all(batches);
    const seqs = results.map((r) => r[0]?.seq).sort((a, b) => (a ?? 0) - (b ?? 0));

    assert.deepEqual(
      seqs,
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    assert.equal(storage.countEvents('s1'), 12);
  });
});

test('备份产出可用文件，恢复后数据还在', async () => {
  const dir = scratch();
  const storage = Storage.open({ path: dbPath(dir) });
  try {
    await storage.createSession({ id: 's1', rulesetId: 'coc7e', title: '备份测试' });
    await storage.appendEvents([
      { sessionId: 's1', type: 'narration.delta', payload: { text: '钟楼的影子落下来。' } },
    ]);

    const result = await storage.backup({ dir: join(dir, 'backups') });
    assert.ok(existsSync(result.path), '备份文件没生成');

    // 备份是完整的 SQLite 文件，能独立打开
    const restored = Storage.open({ path: result.path });
    try {
      assert.equal(restored.countEvents('s1'), 1);
      assert.equal(restored.getSession('s1')?.title, '备份测试');
    } finally {
      await restored.close();
    }
  } finally {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完整性自检通过', async () => {
  await withStorage(async (storage) => {
    const result = storage.integrityCheck();
    assert.equal(result.ok, true, result.messages.join('; '));
  });
});

test('新库不需要重复迁移，重复 open 是幂等的', async () => {
  const dir = scratch();
  const first = Storage.open({ path: dbPath(dir) });
  await first.close();

  const second = Storage.open({ path: dbPath(dir) });
  try {
    assert.equal(second.migration.from, 1);
    assert.equal(second.migration.to, 1);
    assert.deepEqual(second.migration.applied, []);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
