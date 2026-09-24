/**
 * wm-delete-logic.test.mjs — 消息删除半边的纯逻辑离线测试。
 *
 * 不依赖 DSH：用合成的事件日志跑 surface 折叠、区间规划、台账重建与安全拒绝。
 * 跑法（DSH 自带 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe" parts\delete\tests\wm-delete-logic.test.mjs
 */
import assert from 'node:assert/strict';

import {
  PLUGIN_ID,
  PlanError,
  deletableReplyTurns,
  foldSurface,
  hiddenEntries,
  inferMode,
  isBusy,
  isOwnPlaceholder,
  planRange,
  sourceOwnsPlugin,
  turnIndex,
} from '../lib/logic.js';

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------- 测试数据

const userSource = (rpcId) => ({ kind: 'user', rpcId, clientTimeZone: 'Asia/Shanghai' });
const ctxSource = () => ({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] });
const assistantMsg = (id, turn, step) => ({ id, role: 'assistant', content: [{ type: 'text', text: id }] });
const toolMsg = (id, turn, step) => ({ id, role: 'tool', content: [{ type: 'tool-result', content: id }] });

/**
 * 造一份"两轮、各一轮提问 + 一条回复 + 一个工具结果"的日志。
 * surface 节点顺序：system(2) → A(3) → ctx(4) → B(6) → tool(8) → C(12) → D(14)
 */
function buildLog() {
  const events = [];
  const push = (type, data, surfaceOp) => {
    const event = { type, seq: events.length, time: 1000 + events.length, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
    return event;
  };
  push('permission/preset', { preset: 'workspace-write' });
  push('turn/start', { turn: 1 });
  push('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system' }] } }, 'append');
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'A' }], source: userSource('r1') }, 'append');
  push('user/message', { id: 'ctx1', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: ctxSource() }, 'append');
  push('step/start', { turn: 1, step: 1 });
  push('assistant/message', { turn: 1, step: 1, message: assistantMsg('a1', 1, 1) }, 'append');
  push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh' });
  push('tool/result', { turn: 1, step: 1, message: toolMsg('t1', 1, 1) }, 'append');
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1 });
  push('turn/start', { turn: 2 });
  push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'C' }], source: userSource('r2') }, 'append');
  push('step/start', { turn: 2, step: 1 });
  push('assistant/message', { turn: 2, step: 1, message: assistantMsg('a2', 2, 1) }, 'append');
  push('step/end', { turn: 2, step: 1 });
  push('turn/end', { turn: 2 });
  return events;
}

/** 在日志尾部追加一条"本插件删除"替换事件，返回新日志与遮蔽的 seq。 */
function withDeletion(events, startSeq, endSeq) {
  const folded = foldSurface(events);
  const startIdx = folded.nodes.indexOf(startSeq);
  const endIdx = folded.nodes.indexOf(endSeq);
  assert.ok(startIdx >= 0 && endIdx >= startIdx, '测试自身：区间锚点必须在 surface 上');
  const shadowed = folded.nodes.slice(startIdx, endIdx + 1);
  const next = events.map((event) => ({ ...event }));
  next.push({
    type: 'user/message',
    seq: next.length,
    time: 9999,
    data: {
      id: `del-${next.length}`,
      role: 'user',
      content: [{ type: 'text', text: '[deleted]' }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowed,
  });
  return { events: next, shadowed };
}

// ---------------------------------------------------------------- surface 折叠

test('foldSurface 只认带 surfaceOp 的事件，append 按序入表', () => {
  const folded = foldSurface(buildLog());
  assert.deepEqual(folded.nodes, [2, 3, 4, 6, 8, 12, 14]);
  assert.equal(folded.replacements.length, 0);
});

test('foldSurface 的 replace 换掉闭区间并记录遮蔽集合', () => {
  const log = buildLog();
  const { events, shadowed } = withDeletion(log, 6, 8);
  const folded = foldSurface(events);
  assert.deepEqual(shadowed, [6, 8]);
  // 被遮蔽的两个节点被替换事件本身（seq 17）取代
  assert.deepEqual(folded.nodes, [2, 3, 4, 17, 12, 14]);
  assert.deepEqual(folded.replacements.map((r) => r.shadowed), [[6, 8]]);
});

test('foldSurface 对锚点已消失的替换防御性跳过（不抛错）', () => {
  const log = buildLog();
  log.push({
    type: 'user/message',
    seq: log.length,
    time: 1,
    data: { id: 'x', role: 'user', content: [{ type: 'text', text: '[deleted]' }] },
    surfaceOp: { op: 'replace', startSeq: 999, endSeq: 1000 },
  });
  const folded = foldSurface(log);
  assert.deepEqual(folded.nodes, [2, 3, 4, 6, 8, 12, 14]);
  assert.equal(folded.replacements.length, 0);
});

// ---------------------------------------------------------------- 规划：单条指令

test('mode=message 精确删一条真人提问', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'message', seq: 3 });
  assert.equal(plan.startSeq, 3);
  assert.equal(plan.endSeq, 3);
  assert.deepEqual(plan.shadowed, [3]);
  assert.equal(plan.turn, 1);
});

test('mode=message 可以删注入上下文行', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'message', seq: 4 });
  assert.deepEqual(plan.shadowed, [4]);
});

test('mode=message 也能按 messageId 定位', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'message', messageId: 'u2' });
  assert.equal(plan.startSeq, 12);
  assert.equal(plan.turn, 2);
});

test('mode=message 拒绝助手消息（只能整条/按步骤删）', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  assert.throws(() => planRange(log, nodes, { mode: 'message', seq: 6 }), (error) => {
    assert.ok(error instanceof PlanError);
    assert.equal(error.code, 'not-deletable');
    return true;
  });
});

// ---------------------------------------------------------------- 规划：整条回复

test('mode=reply 删掉提问之后的一整条回复（提问保留）', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  // 第一轮：提问 u1 在 index 1，之后是 ctx(4)、a1(6)、tool(8) → 遮蔽 [4,6,8]
  const plan = planRange(log, nodes, { mode: 'reply', seq: 6 });
  assert.deepEqual(plan.shadowed, [4, 6, 8]);
  assert.equal(plan.startSeq, 4);
  assert.equal(plan.endSeq, 8);
  assert.equal(plan.turn, 1);
  // 第二轮：提问 u2 之后只有 a2 → 遮蔽 [14]
  const plan2 = planRange(log, nodes, { mode: 'reply', messageId: 'a2' });
  assert.deepEqual(plan2.shadowed, [14]);
});

test('mode=reply 也能只按 turn 号定位', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'reply', turn: 2 });
  assert.deepEqual(plan.shadowed, [14]);
});

test('mode=reply 绝不把系统提示词头卷进窗口', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'reply', turn: 1 });
  assert.ok(!plan.shadowed.includes(2), '系统提示词头不应出现在遮蔽集合里');
});

// ---------------------------------------------------------------- 规划：按步骤

test('mode=step 把该步骤的助手消息与工具结果一起删（配对不悬空）', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  const plan = planRange(log, nodes, { mode: 'step', seq: 6 });
  assert.deepEqual(plan.shadowed, [6, 8]);
  assert.equal(plan.turn, 1);
  assert.equal(plan.step, 1);
});

test('mode=step 拒绝用户消息', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  assert.throws(() => planRange(log, nodes, { mode: 'step', seq: 3 }), (error) => {
    assert.equal(error.code, 'not-deletable');
    return true;
  });
});

// ---------------------------------------------------------------- 安全边界

test('系统提示词头永远不可删', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  for (const mode of ['message', 'step', 'reply']) {
    assert.throws(() => planRange(log, nodes, { mode, seq: 2 }), (error) => {
      assert.ok(error instanceof PlanError);
      return true;
    });
  }
});

test('已被删掉的目标返回 already-deleted', () => {
  const log = buildLog();
  const { events } = withDeletion(log, 3, 3);
  const nodes = foldSurface(events).nodes;
  assert.throws(() => planRange(events, nodes, { mode: 'message', seq: 3 }), (error) => {
    assert.equal(error.code, 'already-deleted');
    return true;
  });
});

test('窗口里混进无关节点时返回 range-not-clean', () => {
  // 构造一个步骤的两个成员在 surface 上不相邻的日志：
  // surface 顺序 = 提问(1) → 助手(2) → 注入上下文(3) → 工具结果(4)
  const log = [];
  const push = (type, data, surfaceOp) => {
    const event = { type, seq: log.length, time: 1, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    log.push(event);
    return event;
  };
  push('turn/start', { turn: 1 });
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'A' }], source: userSource('r1') }, 'append');
  push('assistant/message', { turn: 1, step: 1, message: assistantMsg('a1', 1, 1) }, 'append');
  push('user/message', { id: 'ctx', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: ctxSource() }, 'append');
  push('tool/result', { turn: 1, step: 1, message: toolMsg('t1', 1, 1) }, 'append');
  push('turn/end', { turn: 1 });
  const nodes = foldSurface(log).nodes;
  assert.deepEqual(nodes, [1, 2, 3, 4]);
  assert.throws(() => planRange(log, nodes, { mode: 'step', seq: 2 }), (error) => {
    assert.ok(error instanceof PlanError);
    assert.equal(error.code, 'range-not-clean');
    return true;
  });
});

test('不在 surface 上的 seq 返回 already-deleted', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  assert.throws(() => planRange(log, nodes, { mode: 'message', seq: 12345 }), (error) => {
    assert.equal(error.code, 'already-deleted');
    return true;
  });
});

test('未知模式被拒绝', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  assert.throws(() => planRange(log, nodes, { mode: 'nope', seq: 3 }), (error) => {
    assert.equal(error.code, 'not-deletable');
    return true;
  });
});

// ---------------------------------------------------------------- 忙碌判定

test('isBusy：未闭合回合算忙', () => {
  const log = buildLog();
  assert.equal(isBusy(log), false);
  log.push({ type: 'turn/start', seq: log.length, time: 1, data: { turn: 3 } });
  assert.equal(isBusy(log), true);
});

test('isBusy：压缩进行中算忙', () => {
  const log = buildLog();
  log.push({ type: 'compaction/start', seq: log.length, time: 1, data: {} });
  assert.equal(isBusy(log), true);
  log.push({ type: 'compaction/end', seq: log.length, time: 1, data: {} });
  assert.equal(isBusy(log), false);
});

// ---------------------------------------------------------------- 台账重建

test('hiddenEntries 只认本插件（与上游删除插件）留下的替换', () => {
  const log = buildLog();
  const { events, shadowed } = withDeletion(log, 6, 8);
  const hidden = hiddenEntries(events);
  assert.deepEqual(hidden.map((entry) => entry.seq), shadowed);
  assert.deepEqual(hidden.map((entry) => entry.mode), ['step', 'step']);
  assert.ok(hidden.every((entry) => entry.replacement === 17));
});

test('hiddenEntries 忽略官方压缩等其它生产者的替换', () => {
  const log = buildLog();
  log.push({
    type: 'user/message',
    seq: log.length,
    time: 1,
    data: {
      id: 'compact',
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-compaction' },
    },
    surfaceOp: { op: 'replace', startSeq: 6, endSeq: 8 },
    sourceEventSeqs: [6, 8],
  });
  assert.deepEqual(hiddenEntries(log), []);
});

test('sourceOwnsPlugin 同时认 v3 与 v4 两种 source 形状，且认上游插件', () => {
  assert.equal(sourceOwnsPlugin({ kind: 'plugin', plugin: PLUGIN_ID }), true);
  assert.equal(sourceOwnsPlugin({ kind: `plugin:${PLUGIN_ID}` }), true);
  assert.equal(sourceOwnsPlugin({ kind: 'plugin', plugin: 'dsh-delete-turn' }), true);
  assert.equal(sourceOwnsPlugin({ kind: 'plugin:dsh-delete-turn' }), true);
  assert.equal(sourceOwnsPlugin({ kind: 'plugin', plugin: '@deepseek-ai/dsh-compaction' }), false);
  assert.equal(sourceOwnsPlugin({ kind: 'user' }), false);
  assert.equal(sourceOwnsPlugin(undefined), false);
});

test('isOwnPlaceholder 认本插件占位、不认真人提问', () => {
  const log = buildLog();
  const { events } = withDeletion(log, 3, 3);
  assert.equal(isOwnPlaceholder(events[17]), true);
  assert.equal(isOwnPlaceholder(events[3]), false);
});

test('inferMode 从窗口反推 message / step / reply', () => {
  const log = buildLog();
  const bySeq = new Map(log.map((event) => [event.seq, event]));
  assert.equal(inferMode(bySeq, [3]), 'message');
  assert.equal(inferMode(bySeq, [6, 8]), 'step');
  assert.equal(inferMode(bySeq, [4, 6, 8]), 'reply');
});

// ---------------------------------------------------------------- 可删回合

test('deletableReplyTurns 只报还有回复内容的回合', () => {
  const log = buildLog();
  const nodes = foldSurface(log).nodes;
  assert.deepEqual(deletableReplyTurns(log, nodes), [1, 2]);
  // 第一轮回复被删掉之后，只剩第二轮
  const { events } = withDeletion(log, 4, 8);
  const nodes2 = foldSurface(events).nodes;
  assert.deepEqual(deletableReplyTurns(events, nodes2), [2]);
});

// ---------------------------------------------------------------- turnIndex

test('turnIndex 用 turn 括号覆盖用户消息、用自带字段覆盖助手事件', () => {
  const log = buildLog();
  const turnOf = turnIndex(log);
  assert.equal(turnOf.get(3), 1); // 真人提问：靠括号
  assert.equal(turnOf.get(4), 1); // 注入上下文：靠括号
  assert.equal(turnOf.get(6), 1); // 助手消息：自带 turn
  assert.equal(turnOf.get(12), 2);
  assert.equal(turnOf.get(14), 2);
});

// ---------------------------------------------------------------- 跑

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}
console.log(`\nwm-delete 逻辑测试：${passed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
