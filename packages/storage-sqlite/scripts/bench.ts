/**
 * 写入压测：验证 DESIGN.md §15 M0 出口准则
 * 「1 万条事件写入 P95 < 2ms」是否成立。
 *
 * 测两种模式：
 *   单条事务 —— 每次 append 一个事件（最坏情况，玩家逐条提交）
 *   批内十条 —— 一次事务写十条（一个回合的典型形状）
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Storage } from '../src/index.ts';

const LOCAL = join(process.cwd(), '.local');

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

function summarize(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  console.log(
    `${label.padEnd(16)} n=${String(sorted.length).padStart(5)}  ` +
      `p50=${percentile(sorted, 50).toFixed(3)}ms  ` +
      `p95=${percentile(sorted, 95).toFixed(3)}ms  ` +
      `p99=${percentile(sorted, 99).toFixed(3)}ms  ` +
      `max=${(sorted[sorted.length - 1] ?? 0).toFixed(3)}ms  ` +
      `avg=${(total / sorted.length).toFixed(3)}ms`,
  );
}

async function main(): Promise<void> {
  mkdirSync(LOCAL, { recursive: true });
  const dir = mkdtempSync(join(LOCAL, 'bench-'));
  const storage = Storage.open({ path: join(dir, 'trpg.db') });

  try {
    await storage.createSession({ id: 'bench', rulesetId: 'coc7e', title: '压测' });

    const payload = {
      text: '你借着整理衣领的动作，瞥见钟楼顶上有个人影。'.repeat(4),
      seatId: 'seat_p1',
      turnId: 't_78',
    };

    // 热身：让 page cache 与 WAL 进入稳定状态
    for (let i = 0; i < 200; i++) {
      await storage.appendEvents([{ sessionId: 'bench', type: 'warmup', payload }]);
    }

    const single: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t0 = performance.now();
      await storage.appendEvents([
        { sessionId: 'bench', type: 'player.input', payload, clientTurnId: `s_${i}` },
      ]);
      single.push(performance.now() - t0);
    }
    summarize('单条事务', single);

    const batched: number[] = [];
    for (let i = 0; i < 200; i++) {
      const batch = Array.from({ length: 10 }, (_, k) => ({
        sessionId: 'bench',
        type: 'narration.delta',
        payload: { ...payload, part: k },
      }));
      const t0 = performance.now();
      await storage.appendEvents(batch);
      batched.push((performance.now() - t0) / 10);
    }
    summarize('批内十条/条', batched);

    // 读回来的成本（补发 500 条）
    const t1 = performance.now();
    const events = storage.readEvents({ sessionId: 'bench', afterSeq: 0, limit: 500 });
    const readMs = performance.now() - t1;
    console.log(`读 500 条           ${readMs.toFixed(2)}ms（${events.length} 条）`);

    const t2 = performance.now();
    await storage.backup({ dir: join(dir, 'backups') });
    console.log(`VACUUM INTO 备份     ${(performance.now() - t2).toFixed(2)}ms`);

    console.log(`总事件数 ${storage.countEvents('bench')}`);
  } finally {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
