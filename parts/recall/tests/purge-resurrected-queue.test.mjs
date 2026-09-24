/**
 * purge-resurrected-queue.test.mjs — 「编辑指令后原指令被重跑」这个 bug 的回归测试。
 *
 * 事件序列取自真实故障会话（session-a347bff8 → fork → session-6cc42136）的日志，
 * 逐条照抄，只把长文本截短。
 *
 * 故障链条：
 *   官方 fork 门面 ① 从 atSeq 往后找第一个 turn/end 作边界，
 *                  ② 再从边界 +1 一路吞到下一个 turn/start 之前。
 *   于是 (边界, turn/start) 之间的 inbox **入队记录**进了子会话 seed，
 *   而**出队记录**在那一轮 turn 里、留在源会话 → 子会话队列被整段复活。
 *
 * 跑法：node parts/recall/tests/purge-resurrected-queue.test.mjs
 */
import assert from 'node:assert/strict';

import { __test } from '../lib/index.js';

const { resurrectedQueueIds, foldPendingTurnInbox, pendingInboxMessageId, resolveBoundary } = __test;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}

// ---------------------------------------------------------------- 真实事件重建

const C30F = 'c30fd50f-85e8-4405-b38b-67ea22e485ea'; // 原指令（无「啊」）——需要被编辑掉的那条
const EIGHT = '89852fe9-a737-41fd-98bf-abaf91b1c42a'; // 第二条（带「啊」）——入队后又被出队，从未执行
const ONE = '4aa7b046-e950-4bb0-999c-618194bf853b'; // 编辑后的「1」
const FRESH = 'aaaaaaaa-1111-2222-3333-444444444444'; // 用户真实排队、还没跑的消息

const msg = (id, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: `rpc-${id.slice(0, 8)}`, clientTimeZone: 'Asia/Shanghai' },
});

const splice = (seq, start, removedCount, inserted) => ({
  seq,
  type: 'agent/inbox/spliced',
  time: 1000 + seq,
  data: { target: 'next-turn', start, ...(removedCount > 0 ? { removedCount } : {}), inserted },
});

const turnEnd = (seq, turn) => ({ seq, type: 'turn/end', time: 1000 + seq, data: { turn } });
const turnStart = (seq, turn) => ({ seq, type: 'turn/start', time: 1000 + seq, data: { turn } });

/**
 * 源会话在「用户点下编辑」那一刻的真实日志（逐条对应线上 dump）：
 *   4526 turn/end(63)                 ← 插件选的分叉边界
 *   4528 inbox 入队 c30f
 *   4531 inbox 入队 8985
 *   4532 turn/start(64)
 *   4533 inbox 出队 1（c30f 被认领）
 *   4536 user/message c30f
 *   4542 inbox 出队 1（8985 被丢弃）
 *   4543 turn/end(64)
 */
function sourceLog(extra = []) {
  return [
    turnEnd(4526, 63),
    splice(4528, 0, 0, [msg(C30F, '做一个演示介绍视频。1080p…')]),
    splice(4531, 1, 0, [msg(EIGHT, '做一个演示介绍视频。1080p…啊')]),
    turnStart(4532, 64),
    splice(4533, 0, 1, []),
    { seq: 4536, type: 'user/message', time: 1000 + 4536, data: msg(C30F, '做一个演示介绍视频。1080p…') },
    splice(4542, 0, 1, []),
    turnEnd(4543, 64),
    ...extra,
  ];
}

/** 子会话 seed：fork 门面吞进来的 0..4531（两个入队，没有出队）。 */
function childSeed(extra = []) {
  return [
    turnEnd(4526, 63),
    splice(4528, 0, 0, [msg(C30F, '做一个演示介绍视频。1080p…')]),
    splice(4531, 1, 0, [msg(EIGHT, '做一个演示介绍视频。1080p…啊')]),
    ...extra,
  ];
}

// ---------------------------------------------------------------- 前提：先确认 bug 真的存在

check('前提：源会话队列是空的（两条都被消费掉了）', () => {
  assert.deepEqual(foldPendingTurnInbox(sourceLog()), []);
});

check('前提：子会话 seed 的队列被复活成 [c30f, 8985]', () => {
  const queue = foldPendingTurnInbox(childSeed());
  assert.deepEqual(queue.map((m) => m.id), [C30F, EIGHT]);
});

check('前提：真实故障里 /bubble/recall 之所以没拦住，是因为客户端没带 messageId', () => {
  // 守卫本身判断是对的：源会话队列为空 → 不算 pending
  assert.equal(pendingInboxMessageId(sourceLog(), C30F), null);
});

// ---------------------------------------------------------------- 核心判据

check('复活的幽灵全部被识别（源会话队列里已经没有的）', () => {
  assert.deepEqual(resurrectedQueueIds(sourceLog(), childSeed()), [C30F, EIGHT]);
});

check('用户真实排队、还没跑的消息不会被误删', () => {
  const source = sourceLog([splice(4544, 0, 0, [msg(FRESH, '还没跑的消息')])]);
  const seed = childSeed([splice(4532, 2, 0, [msg(FRESH, '还没跑的消息')])]);
  assert.deepEqual(foldPendingTurnInbox(seed).map((m) => m.id), [C30F, EIGHT, FRESH]);
  assert.deepEqual(resurrectedQueueIds(source, seed), [C30F, EIGHT], 'FRESH 必须保留');
});

check('编辑后的文本绝不能被当成幽灵（只折叠 seed 前缀）', () => {
  const childFull = childSeed([splice(4534, 2, 0, [msg(ONE, '1')])]);
  const inherited = childSeed().length;
  // 正确做法：只取 seed 前缀
  assert.deepEqual(resurrectedQueueIds(sourceLog(), childFull.slice(0, inherited)), [C30F, EIGHT]);
  // 反例：如果把 fork 之后新入队的也算进来，「1」会被误删——这就是必须切 seed 的原因
  assert.ok(
    resurrectedQueueIds(sourceLog(), childFull).includes(ONE),
    '（反例）传全量日志时编辑文本会被误判 —— 证明调用方必须传 seed 前缀',
  );
});

check('队列本来就干净时返回空数组', () => {
  assert.deepEqual(resurrectedQueueIds(sourceLog(), [turnEnd(4526, 63)]), []);
});

check('双方队列都为空时返回空数组', () => {
  assert.deepEqual(resurrectedQueueIds([turnEnd(4526, 63)], [turnEnd(4526, 63)]), []);
});

check('源会话没有队列记录、seed 却有 → 全部算幽灵（fork 截断的必然结果）', () => {
  assert.deepEqual(resurrectedQueueIds([turnEnd(4526, 63)], childSeed()), [C30F, EIGHT]);
});

check('非 next-turn 目标的 splice 不参与折叠', () => {
  const seed = [
    ...childSeed(),
    {
      seq: 4600,
      type: 'agent/inbox/spliced',
      time: 1,
      data: { target: 'next-step', start: 0, inserted: [msg('step-msg', '步内插话')] },
    },
  ];
  assert.deepEqual(resurrectedQueueIds(sourceLog(), seed), [C30F, EIGHT], 'next-step 不该混进来');
});

check('折叠对 insert / remove 混合序列与 toSpliced 语义一致', () => {
  const events = [
    splice(0, 0, 0, [msg('a', 'A')]), //            → [a]
    splice(1, 1, 0, [msg('b', 'B'), msg('c', 'C')]), // → [a, b, c]
    splice(2, 1, 1, []), //                          → 移除 idx1 一个 = b → [a, c]
    splice(3, 0, 0, [msg('d', 'D')]), //             → 在 idx0 插入 d → [d, a, c]
  ];
  assert.deepEqual(foldPendingTurnInbox(events).map((m) => m.id), ['d', 'a', 'c']);
});

// ---------------------------------------------------------------- 守卫（message-pending）

const ctxWith = (events) => ({ sessions: { get: () => ({ snapshotEvents: () => events }) } });

check('守卫：目标仍排在队列里、且没进日志 → message-pending（客户端不传 messageId 也要能拦）', () => {
  // 消息 X 只在队列里（没有对应的 user/message），targetSeq 指向那条入队事件的 seq。
  const pendingX = 'bbbbbbbb-1111-2222-3333-444444444444';
  const events = [
    turnEnd(4526, 63),
    splice(4528, 0, 0, [msg(pendingX, '还排着的消息')]),
  ];
  const result = resolveBoundary(ctxWith(events), 'session-x', 4528, pendingX);
  assert.equal(result.code, 'message-pending');
  assert.equal(result.status, 409);
});

check('守卫：目标已认领（日志里有 user/message）→ 放行', () => {
  const result = resolveBoundary(ctxWith(sourceLog()), 'session-x', 4536, C30F);
  assert.equal(result.code, undefined, '不该被拦');
  assert.equal(typeof result.boundary, 'number');
});

check('守卫：不传 messageId 也能用 targetSeq 补出 id（补丁不破坏放行路径）', () => {
  const result = resolveBoundary(ctxWith(sourceLog()), 'session-x', 4536, null);
  assert.equal(result.code, undefined);
  assert.equal(typeof result.boundary, 'number');
});

check('守卫：targetSeq 指向非 user/message 事件时退回原行为，不抛错', () => {
  const result = resolveBoundary(ctxWith(sourceLog()), 'session-x', 4526, null);
  // 4526 是 turn/end，补不出 id；队列为空 → 守卫放行，继续走到边界解析：
  // 4526 之前没有 turn/end → no-boundary（错误码正常返回，而不是异常/500）
  assert.equal(result.code, 'no-boundary');
  assert.equal(result.status, 409);
});

// ---------------------------------------------------------------- 汇总

console.log(`\n复活队列清理测试：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
