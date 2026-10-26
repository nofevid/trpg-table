import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actorOwner,
  after,
  canSee,
  faction,
  GM_ONLY,
  NEVER,
  PUBLIC,
  redact,
  seats,
  splitBySeat,
  visibleTo,
} from '../src/index.ts';

const gm = { seatId: 'seat_gm', role: 'gm' as const, actorIds: [], factions: [], seq: 0 };
const p1 = { seatId: 'seat_p1', role: 'player' as const, actorIds: ['ch_lin'], factions: ['investigator'], seq: 10 };
const p2 = { seatId: 'seat_p2', role: 'player' as const, actorIds: ['ch_zhou'], factions: ['investigator'], seq: 10 };
const cultist = { seatId: 'seat_p3', role: 'player' as const, actorIds: ['npc_cult'], factions: ['cult'], seq: 10 };
const spectator = { seatId: 'seat_s1', role: 'spectator' as const, actorIds: [], factions: [], seq: 10 };

test('public 谁都能看，never 谁都不能看', () => {
  for (const viewer of [gm, p1, p2, cultist, spectator]) {
    assert.equal(canSee(viewer, PUBLIC), true);
    assert.equal(canSee(viewer, NEVER), false);
  }
});

test('gm_only 只有主持人能看', () => {
  assert.equal(canSee(gm, GM_ONLY), true);
  assert.equal(canSee(p1, GM_ONLY), false);
  assert.equal(canSee(spectator, GM_ONLY), false);
});

test('seats 只给列出的席位', () => {
  const v = seats('seat_p2', 'seat_gm');
  assert.equal(canSee(p2, v), true);
  assert.equal(canSee(p1, v), false);
});

test('actor_owner 按角色归属判定', () => {
  const v = actorOwner('ch_lin');
  assert.equal(canSee(p1, v), true);
  assert.equal(canSee(p2, v), false);
  // canSee 只管可见性本身，不看角色特权；特权在 visibleTo 里加
  assert.equal(canSee(gm, v), false);
  assert.equal(visibleTo(gm, v), true, 'GM 能看到所有人');
});

test('faction 按阵营判定', () => {
  const v = faction('cult');
  assert.equal(canSee(cultist, v), true);
  assert.equal(canSee(p1, v), false);
});

test('after 需要查看者已推进到该序号之后', () => {
  const v = after(20);
  assert.equal(canSee({ ...p1, seq: 20 }, v), false, '恰好等于时还看不见');
  assert.equal(canSee({ ...p1, seq: 21 }, v), true);
  assert.equal(canSee({ ...p1, seq: 5 }, v), false);
});

test('visibleTo 让主持人越过除 never 之外的一切', () => {
  assert.equal(visibleTo(gm, seats('seat_p1')), true);
  assert.equal(visibleTo(gm, actorOwner('ch_zhou')), true);
  assert.equal(visibleTo(gm, NEVER), false);
  assert.equal(visibleTo(p1, seats('seat_p2')), false);
});

test('redact 过滤掉看不见的事件且保持顺序', () => {
  const items = [
    { id: 'e1', seq: 1, visibility: PUBLIC },
    { id: 'e2', seq: 2, visibility: GM_ONLY },
    { id: 'e3', seq: 3, visibility: seats('seat_p1') },
    { id: 'e4', seq: 4, visibility: NEVER },
  ];

  assert.deepEqual(redact(items, p1).map((i) => i.id), ['e1', 'e3']);
  assert.deepEqual(redact(items, p2).map((i) => i.id), ['e1']);
  assert.deepEqual(redact(items, gm).map((i) => i.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(redact(items, spectator).map((i) => i.id), ['e1']);
});

test('splitBySeat 把私有内容按席位分桶', () => {
  const privates = [
    { audience: ['seat_p1'], text: '你注意到神父的袖口有血' },
    { audience: ['seat_p2'], text: '你闻到地窖飘上来的霉味' },
    { audience: ['seat_p1', 'seat_p2'], text: '你们两个都听到了门后的动静' },
  ];

  const split = splitBySeat(privates);
  assert.equal(split.get('seat_p1')?.length, 2);
  assert.equal(split.get('seat_p2')?.length, 2);
  assert.equal(split.get('seat_p3'), undefined);
});

test('空席位的 seats 不会意外放行', () => {
  const anonymous = { seatId: '', role: 'spectator' as const, actorIds: [], factions: [], seq: 0 };
  assert.equal(canSee(anonymous, seats('')), false);
});
