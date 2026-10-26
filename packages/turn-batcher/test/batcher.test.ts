import assert from 'node:assert/strict';
import test from 'node:test';

import { missingSeats, TurnBatcher, type TurnBatch, type TurnInput } from '../src/index.ts';

/** 把时间捏在手里，测试就不用 sleep。 */
function makeBatcher(overrides: { singleMs?: number } = {}) {
  let clock = 0;
  const frozen: TurnBatch[] = [];
  const batcher = new TurnBatcher({
    now: () => clock,
    onFreeze: (batch) => frozen.push(batch),
    singleMs: overrides.singleMs ?? 300,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { batcher, frozen, advance, clockNow: () => clock };
}

function input(clientTurnId: string, seatId = 'seat_p1', sceneId = 'sc_chapel', channel: TurnInput['channel'] = 'ic'): TurnInput {
  return {
    seatId,
    sceneId,
    clientTurnId,
    text: `我行动 ${clientTurnId}`,
    channel,
    atMs: 0,
  };
}

test('单条输入在 300ms 静默后冻结', () => {
  const { batcher, frozen, advance } = makeBatcher();

  const result = batcher.submit(input('ct_1'));
  assert.equal(result.accepted, true);
  assert.equal(result.waitMs, 300);

  advance(299);
  batcher.tick();
  assert.equal(frozen.length, 0);

  advance(1);
  batcher.tick();
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]?.inputs.length, 1);
  assert.equal(frozen[0]?.inputs[0]?.state, 'frozen');
});

test('两条输入合并成一批，静默期重置', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit(input('ct_1', 'seat_p1'));
  advance(400);
  batcher.submit(input('ct_2', 'seat_p2'));

  advance(699);
  batcher.tick();
  assert.equal(frozen.length, 0, '静默期未到不应冻结');

  advance(1);
  batcher.tick();
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]?.inputs.length, 2);
  assert.deepEqual(frozen[0]?.inputs.map((i) => i.seatId), ['seat_p1', 'seat_p2']);
});

test('硬上限 1.5 秒强制放行，哪怕有人一直在敲', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit(input('ct_1', 'seat_p1'));
  for (let i = 0; i < 14; i += 1) {
    advance(100);
    batcher.typing('seat_p2', 'sc_chapel');
    batcher.tick();
  }
  assert.equal(frozen.length, 0, '1.4 秒时还不该冻结');

  advance(100);
  batcher.tick();
  assert.equal(frozen.length, 1, '到 1.5 秒必须放行');
});

test('有人在输入时静默期延长到 1200ms', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit(input('ct_1', 'seat_p1'));
  batcher.typing('seat_p2', 'sc_chapel');

  advance(800);
  batcher.tick();
  assert.equal(frozen.length, 0, '有人正在输入就不该在 700ms 冻结');

  advance(400);
  batcher.tick();
  assert.equal(frozen.length, 1);
});

test('不同场景各自成批，互不拖累', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit(input('ct_1', 'seat_p1', 'sc_chapel'));
  batcher.submit(input('ct_2', 'seat_p2', 'sc_cellar'));

  advance(301);
  batcher.tick();

  assert.equal(frozen.length, 2);
  const scenes = frozen.map((b) => b.sceneId).sort();
  assert.deepEqual(scenes, ['sc_cellar', 'sc_chapel']);
  assert.equal(batcher.pendingCount(), 0);
});

test('ooc 与 rule 通道不走批次', () => {
  const { batcher, frozen, advance } = makeBatcher();

  const ooc = batcher.submit(input('ct_1', 'seat_p1', 'sc_chapel', 'ooc'));
  const rule = batcher.submit(input('ct_2', 'seat_p1', 'sc_chapel', 'rule'));
  assert.equal(ooc.accepted, false);
  assert.equal(ooc.reason, 'channel_bypass');
  assert.equal(rule.reason, 'channel_bypass');

  advance(2000);
  batcher.tick();
  assert.equal(frozen.length, 0);
});

test('同一 clientTurnId 重复提交被幂等挡下', () => {
  const { batcher } = makeBatcher();

  assert.equal(batcher.submit(input('ct_1')).accepted, true);
  const again = batcher.submit(input('ct_1'));
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(batcher.pendingCount(), 1);
});

test('冻结前可以撤回，冻结后不行', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit(input('ct_1'));
  batcher.submit(input('ct_2', 'seat_p2'));
  assert.equal(batcher.retract('ct_1'), true);
  assert.equal(batcher.pendingCount(), 1);

  advance(301);
  batcher.tick();
  assert.equal(frozen.length, 1);
  assert.equal(batcher.retract('ct_2'), false, '已冻结的收不回来');
});

test('批内按服务端收到顺序排列，不信客户端 atMs', () => {
  const { batcher, frozen, advance } = makeBatcher();

  batcher.submit({ ...input('ct_3', 'seat_p3'), atMs: 300 });
  advance(100);
  batcher.submit({ ...input('ct_1', 'seat_p1'), atMs: 100 });
  advance(100);
  batcher.submit({ ...input('ct_2', 'seat_p2'), atMs: 200 });

  advance(701);
  batcher.tick();

  assert.deepEqual(
    frozen[0]?.inputs.map((i) => i.clientTurnId),
    ['ct_3', 'ct_1', 'ct_2'],
    '结算顺序取服务端收到顺序；atMs 只是客户端声称，时钟不可信',
  );
});

test('覆盖性校验找出没被回应的席位', () => {
  const { batcher, frozen, advance } = makeBatcher();
  batcher.submit(input('ct_1', 'seat_p1'));
  batcher.submit(input('ct_2', 'seat_p2'));
  batcher.submit(input('ct_3', 'seat_p3'));
  advance(701);
  batcher.tick();

  const batch = frozen[0];
  assert.ok(batch !== undefined);
  assert.deepEqual(missingSeats(batch, ['seat_p1', 'seat_p2']), ['seat_p3']);
  assert.deepEqual(missingSeats(batch, ['seat_p1', 'seat_p2', 'seat_p3']), []);
});

test('同一席位两条输入只算一个待覆盖席位', () => {
  const { batcher, frozen, advance } = makeBatcher();
  batcher.submit(input('ct_1', 'seat_p1'));
  batcher.submit(input('ct_2', 'seat_p1'));
  advance(701);
  batcher.tick();

  const batch = frozen[0];
  assert.ok(batch !== undefined);
  assert.deepEqual(missingSeats(batch, []), ['seat_p1']);
});

test('关闭时把挂着的输入全部交出去，不丢话', () => {
  const { batcher } = makeBatcher();
  batcher.submit(input('ct_1'));
  batcher.submit(input('ct_2', 'seat_p2', 'sc_cellar'));

  const drained = batcher.close();
  assert.equal(drained.length, 2);
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(batcher.submit(input('ct_3')).reason, 'closed');
});
