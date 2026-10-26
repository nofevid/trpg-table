import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createMockProvider } from '../../../packages/llm-gateway/src/index.ts';
import { ToolRegistry, createCoc7eTools } from '../../../packages/tools/src/index.ts';
import { createServer } from '../src/index.ts';

interface Envelope {
  id: string;
  type: string;
  payload: unknown;
  seq?: number;
}

function makeTools(): ToolRegistry {
  const registry = new ToolRegistry({ maxLevel: 'L3' });
  registry.registerAll(createCoc7eTools());
  return registry;
}

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'trpg-')), 'test.db');
}

/**
 * 把 ws 消息先收进队列再按需取。
 * 不能对每类消息各挂一个临时监听器——服务端一次广播会连发多条，
 * 串行 await 之间注册的监听器会漏掉紧邻的那条。
 */
function collector(socket: WebSocket) {
  const queue: Envelope[] = [];
  const waiters: Array<{ type: string; resolve: (envelope: Envelope) => void }> = [];

  socket.on('message', (data) => {
    const envelope = JSON.parse(String(data)) as Envelope;
    if (process.env['TRPG_TRACE'] === '1') console.error('[MSG]', envelope.type);
    const index = waiters.findIndex((waiter) => waiter.type === envelope.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(envelope);
      return;
    }
    queue.push(envelope);
  });

  return {
    wait(type: string, timeoutMs = 6000): Promise<Envelope> {
      const index = queue.findIndex((envelope) => envelope.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
        waiters.push({
          type,
          resolve: (envelope) => {
            clearTimeout(timer);
            resolve(envelope);
          },
        });
      });
    },
    /** 断言在 timeoutMs 内**没有**收到这类消息。 */
    async expectNone(type: string, timeoutMs = 1200): Promise<void> {
      const index = queue.findIndex((envelope) => envelope.type === type);
      if (index >= 0) throw new Error(`不该收到 ${type}，但收到了`);
      const appeared = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        waiters.push({
          type,
          resolve: () => {
            clearTimeout(timer);
            resolve(true);
          },
        });
      });
      if (appeared) throw new Error(`不该收到 ${type}，但收到了`);
    },
  };
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function createSession(port: number, title: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, rulesetId: 'coc7e' }),
  });
  assert.equal(response.status, 201);
  const session = (await response.json()) as { id: string };
  assert.ok(session.id.length > 0, '创建会话应返回 id');
  return session.id;
}

function submit(socket: WebSocket, sessionId: string, seatId: string, text: string, clientTurnId: string): void {
  socket.send(
    JSON.stringify({
      id: `t_${clientTurnId}`,
      type: 'turn.submit',
      payload: { sessionId, seatId, text, clientTurnId, channel: 'ic' },
    }),
  );
}

test('端到端：建会话 → 入座 → 提交 → 收到叙述与回合完成', async () => {
  const provider = createMockProvider([
    {
      kind: 'text',
      content: JSON.stringify({
        public: '林晚推开礼拜堂的门，正午的光从彩窗斜射进来。',
        privates: [],
        mentions: [{ surface: '礼拜堂', refId: 'sc_chapel', kind: 'scene' }],
        acknowledged: ['seat_p1'],
        gmNotes: '神父此刻不在。',
        effects: [],
        stateMutations: [],
      }),
    },
  ]);

  const running = await createServer({
    dbPath: tempDb(),
    provider,
    tools: makeTools(),
    charactersOf: () => ({ ch_lin: { name: '林晚', skills: { 侦查: 55, 闪避: 45 } } }),
  });

  try {
    const sessionId = await createSession(running.port, '测试局');
    const socket = await openSocket(running.port);
    const box = collector(socket);

    socket.send(
      JSON.stringify({
        id: 'j1',
        type: 'room.join',
        payload: { sessionId, seatId: 'seat_p1', role: 'player', actorIds: ['ch_lin'] },
      }),
    );
    const joined = await box.wait('room.joined');
    assert.equal((joined.payload as { seatId: string }).seatId, 'seat_p1');

    submit(socket, sessionId, 'seat_p1', '我推开礼拜堂的门。', 'ct_1');

    const ack = await box.wait('turn.batch_ack');
    assert.deepEqual((ack.payload as { accepted: string[] }).accepted, ['ct_1']);

    const frozen = await box.wait('turn.batch_frozen');
    assert.equal((frozen.payload as { sceneId: string }).sceneId, 'default');

    const narration = await box.wait('narration.final');
    assert.match((narration.payload as { text: string }).text, /礼拜堂的门/);

    const completed = await box.wait('turn.completed');
    assert.equal(typeof completed.seq, 'number');
    assert.ok((completed.seq ?? 0) > 0);

    socket.close();
  } finally {
    await running.close();
  }
});

test('私密叙述只发给受众席位', async () => {
  const provider = createMockProvider([
    {
      kind: 'text',
      content: JSON.stringify({
        public: '两个人在门口撞了个满怀。',
        privates: [{ audience: ['seat_p2'], text: '你注意到她袖口有暗红色的污渍。' }],
        mentions: [],
        acknowledged: ['seat_p1'],
        gmNotes: '',
        effects: [],
        stateMutations: [],
      }),
    },
  ]);

  const running = await createServer({
    dbPath: tempDb(),
    provider,
    tools: makeTools(),
    charactersOf: () => ({ ch_lin: { name: '林晚', skills: { 侦查: 55 } } }),
  });

  try {
    const sessionId = await createSession(running.port, '私密测试');
    const p1 = await openSocket(running.port);
    const p2 = await openSocket(running.port);
    const box1 = collector(p1);
    const box2 = collector(p2);

    for (const [socket, seatId, box] of [
      [p1, 'seat_p1', box1],
      [p2, 'seat_p2', box2],
    ] as const) {
      socket.send(
        JSON.stringify({ id: `j_${seatId}`, type: 'room.join', payload: { sessionId, seatId, role: 'player', actorIds: [] } }),
      );
      await box.wait('room.joined');
    }

    submit(p1, sessionId, 'seat_p1', '我冲过去。', 'ct_p1');

    const priv = await box2.wait('narration.private');
    assert.match((priv.payload as { text: string }).text, /袖口/);

    await box1.expectNone('narration.private');

    p1.close();
    p2.close();
  } finally {
    await running.close();
  }
});

test('GM 能看到 gm.note，玩家看不到', async () => {
  const provider = createMockProvider([
    {
      kind: 'text',
      content: JSON.stringify({
        public: '门开了。',
        privates: [],
        mentions: [],
        acknowledged: ['seat_p1'],
        gmNotes: '锁是昨天换的。',
        effects: [],
        stateMutations: [],
      }),
    },
  ]);

  const running = await createServer({
    dbPath: tempDb(),
    provider,
    tools: makeTools(),
    charactersOf: () => ({ ch_lin: { name: '林晚', skills: { 侦查: 55 } } }),
  });

  try {
    const sessionId = await createSession(running.port, 'GM 测试');
    const gm = await openSocket(running.port);
    const player = await openSocket(running.port);
    const gmBox = collector(gm);
    const playerBox = collector(player);

    gm.send(JSON.stringify({ id: 'j_gm', type: 'room.join', payload: { sessionId, seatId: 'seat_gm', role: 'gm', actorIds: [] } }));
    await gmBox.wait('room.joined');
    player.send(
      JSON.stringify({ id: 'j_p1', type: 'room.join', payload: { sessionId, seatId: 'seat_p1', role: 'player', actorIds: [] } }),
    );
    await playerBox.wait('room.joined');

    submit(player, sessionId, 'seat_p1', '我推门。', 'ct_g1');

    const note = await gmBox.wait('gm.note');
    assert.match((note.payload as { text: string }).text, /锁是昨天换的/);

    await playerBox.expectNone('gm.note');

    gm.close();
    player.close();
  } finally {
    await running.close();
  }
});
