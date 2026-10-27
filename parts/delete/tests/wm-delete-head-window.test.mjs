/**
 * wm-delete-head-window.test.mjs — 「窗口不得覆盖 surface 节点 0」回归（纯逻辑）。
 *
 * 背景：宿主**每轮都重写系统提示词头**，重写后的头带的是当前轮号；而官方 append 契约
 * 只允许用 `system/message` 精确改写节点 0。本插件删除用的载体是 turn-less
 * `user/message`，所以**任何起点落在节点 0 的窗口都必须拒绝**，不能悄悄落地。
 *
 * 两条规划路径都要拦（旧实现只拦了"被点的那个目标是不是节点 0"）：
 *   - `step`：成员按 turn/step 找，窗口起点由成员最小索引决定；
 *   - `reply`：整轮删除（scope='turn'）**不依赖目标还在场**，窗口完全由 replySegments
 *     算出来 —— 目标可以是节点 1，而窗口起点是节点 0。
 *
 * 上游 dsh-delete-turn 0.1.12 的修法就是把判据从"头所在轮"改成"窗口起点"。
 *
 * 跑法：node parts/delete/tests/wm-delete-head-window.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const logicPath = join(here, '..', 'lib', 'logic.js');
const { foldSurface, planRange, PlanError } = await import(pathToFileURL(logicPath).href);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}

const userSource = (rpcId) => ({ kind: 'user', rpcId });

/** 最小日志构造器。 */
function makeLog(build) {
  const events = [];
  const push = (type, data, extra) => {
    const event = { type, seq: events.length, time: 1000 + events.length, data, ...(extra || {}) };
    events.push(event);
    return event;
  };
  build(push);
  return events;
}

const assistant = (turn, step, id, text) => ({
  turn,
  step,
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
});
const userMsg = (id, text, rpcId) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: userSource(rpcId),
});

// ---------------------------------------------------------------- 场景

/**
 * 事故形状：**一回合里没有真人提问在 surface 上，且两条 assistant 都在**。
 * 此时 surface 节点 0 就是第一条 assistant —— 删"这一轮"会把窗口一路推到节点 0。
 * （真实会话里对应：头被重写 / 提问已被删 / 只有 agent 自己开的多步回合。）
 */
function logAssistantOnlyTurn() {
  return makeLog((push) => {
    push('turn/start', { turn: 1 });
    push('step/start', { turn: 1, step: 1 });
    push('assistant/message', assistant(1, 1, 'a1', 'B'), { surfaceOp: 'append' });
    push('step/end', { turn: 1, step: 1 });
    push('step/start', { turn: 1, step: 2 });
    push('assistant/message', assistant(1, 2, 'a2', 'D'), { surfaceOp: 'append' });
    push('step/end', { turn: 1, step: 2 });
    push('turn/end', { turn: 1 });
  });
}

/** 常规日志：头 + 提问 + 回复。 */
function logNormalTurn() {
  return makeLog((push) => {
    push('turn/start', { turn: 1 });
    push(
      'system/message',
      { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system' }] } },
      { surfaceOp: 'append' },
    );
    push('user/message', userMsg('u1', 'A', 'r1'), { surfaceOp: 'append' });
    push('step/start', { turn: 1, step: 1 });
    push('assistant/message', assistant(1, 1, 'a1', 'B'), { surfaceOp: 'append' });
    push('step/end', { turn: 1, step: 1 });
    push('turn/end', { turn: 1 });
  });
}

// ---------------------------------------------------------------- 测试

check('事故场景确认：该日志的 surface 节点 0 是 assistant（不是 system）', () => {
  const events = logAssistantOnlyTurn();
  const nodes = foldSurface(events).nodes;
  assert.equal(nodes.length, 2, `应有 2 个 surface 节点，实际 ${nodes.length}`);
  assert.equal(events[nodes[0]].type, 'assistant/message', '节点 0 应是 assistant/message');
});

check('整轮删除：目标在节点 1，但窗口起点会落到节点 0 → 必须拒绝 not-deletable', () => {
  const events = logAssistantOnlyTurn();
  const nodes = foldSurface(events).nodes;
  const second = nodes[1];
  let thrown = null;
  try {
    planRange(events, nodes, { mode: 'reply', seq: second, scope: 'turn' });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, '窗口覆盖节点 0 时必须抛错，而不是悄悄落地');
  assert.ok(thrown instanceof PlanError, `应抛 PlanError，实际 ${thrown && thrown.name}`);
  assert.equal(thrown.code, 'not-deletable');
  assert.match(String(thrown.message), /system prompt head/, '错误信息应指明系统提示词头');
});

check('同一条日志：只删**被点的那一段**（不勾整轮）也不得覆盖节点 0', () => {
  const events = logAssistantOnlyTurn();
  const nodes = foldSurface(events).nodes;
  let thrown = null;
  try {
    // 默认 scope='segment'：只删它自己所在的段；但段若从节点 0 开始同样要拒。
    planRange(events, nodes, { mode: 'reply', seq: nodes[0], scope: 'segment' });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, '起点为节点 0 的段窗口必须拒绝');
  assert.equal(thrown.code, 'not-deletable');
});

check('正常日志不受影响：删回复段成功，窗口起点不是节点 0', () => {
  const events = logNormalTurn();
  const nodes = foldSurface(events).nodes;
  const a1 = events.find((event) => event.type === 'assistant/message');
  const plan = planRange(events, nodes, { mode: 'reply', seq: a1.seq, scope: 'segment' });
  assert.notEqual(plan.startSeq, nodes[0], '窗口起点不应是节点 0');
  assert.deepEqual(plan.shadowed, [a1.seq]);
});

check('正常日志：删那条提问（message 模式）成功，且不动头', () => {
  const events = logNormalTurn();
  const nodes = foldSurface(events).nodes;
  const u1 = events.find((event) => event.data?.id === 'u1');
  const plan = planRange(events, nodes, { mode: 'message', seq: u1.seq });
  assert.deepEqual(plan.shadowed, [u1.seq]);
  assert.notEqual(plan.startSeq, nodes[0]);
});

check('删系统提示词头本身仍被拒（原有守卫不能被新守卫替代）', () => {
  const events = logNormalTurn();
  const nodes = foldSurface(events).nodes;
  const head = events.find((event) => event.type === 'system/message');
  let thrown = null;
  try {
    planRange(events, nodes, { mode: 'message', seq: head.seq });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof PlanError, '删头必须抛错');
  assert.equal(thrown.code, 'not-deletable');
});

console.log(`\nwm-delete 头窗口守卫：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
