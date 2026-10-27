/**
 * wm-delete-stop-first.test.mjs — 「生成中删除 = 先停这一轮、再删」回归（宿主半边）。
 *
 * 起因：上游 dsh-delete-turn 0.1.13 把"回合进行中不能删（busy）"改成先走官方
 * `sessionController.cancel`（与 UI 停止键同一条路，保留排队输入），等这一轮真正
 * 收尾（`turn/end` 落地）之后再删。
 *
 * 这里要锁的是**顺序**，不是"能不能停"：
 *   1. busy 时先 cancel，不是直接回 409；
 *   2. cancel 之后**重新读日志**再规划 —— 窗口必须建立在收尾后的 surface 上，
 *      否则算出来的 seq 立刻过期；
 *   3. 等不到 turn/end 就回 stop-timeout，**不落地任何替换事件**；
 *   4. 正在压缩（没有停止语义）时仍回 busy。
 *
 * 跑法：node parts/delete/tests/wm-delete-stop-first.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 日志隔离（必做）。这个测试会反复 apply() 宿主半边，而 apply 会写
// `$DSH_HOME\dsh-wm-delete.log`；不隔离的话，每跑一次测试就往**真实**日志里塞一条
// 「已注册」，排查线上问题时会把成批假数据当成"插件被反复重载"的证据
// （2026-10-28 实际踩到：20 分钟里 23 条"已注册"，全是跑测试留下的）。
const LOG_HOME = mkdtempSync(join(tmpdir(), 'wm-delete-stopfirst-'));
process.env.DSH_HOME = LOG_HOME;
// 让写进日志的每条记录都带 test: true，即使有人不小心指回真实 DSH_HOME 也能一眼摘出去。
process.env.WM_DELETE_TEST = '1';

const hostPath = join(here, '..', 'lib', 'index.js');
const host = await import(pathToFileURL(hostPath).href);
const { apply, configureStopWait } = host;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}

const SESSION_ID = 'session-8c5d8123-cce9-4c85-9532-6a00c36a92fa';
const userSource = (rpcId) => ({ kind: 'user', rpcId });

/** 已闭合的一轮：提问 u1 + 回复 a1。 */
function closedLog() {
  const events = [];
  const push = (type, data, extra) => {
    const event = { type, seq: events.length, time: 1000 + events.length, data, ...(extra || {}) };
    events.push(event);
    return event;
  };
  push('turn/start', { turn: 1 });
  push('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system' }] } }, { surfaceOp: 'append' });
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'A' }], source: userSource('r1') }, { surfaceOp: 'append' });
  push('step/start', { turn: 1, step: 1 });
  push('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'B' }] } }, { surfaceOp: 'append' });
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1 });
  return events;
}

/** 未闭合的一轮：缺 turn/end（正在生成）。 */
function openLog() {
  const events = closedLog();
  events.pop(); // 去掉 turn/end
  return events;
}

/**
 * 假宿主。`onCancel` 决定"停止请求被受理之后日志变成什么"：
 *   - 'close'：立刻补上 turn/end（正常收尾）
 *   - 'never'：永远不闭合（模拟超时）
 */
function makeHarness({ onCancel = 'close' } = {}) {
  const routes = new Map();
  const appended = [];
  const calls = { cancel: 0, append: 0 };
  const state = { log: openLog() };

  const session = {
    snapshotEvents: () => state.log,
    append: (type, data, opts) => {
      const event = { type, seq: state.log.length, time: Date.now(), data, ...(opts || {}) };
      state.log.push(event);
      appended.push(event);
      calls.append += 1;
      return event;
    },
  };

  const ctx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn: () => {} },
    get: (name) => {
      if (name === 'sessions') {
        const live = new Set([SESSION_ID, SESSION_ID.replace('session-', '')]);
        return { get: (id) => (live.has(id) ? session : undefined) };
      }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: state.log }) };
      if (name === 'sessionPersistence') return { flush: async () => {} };
      if (name === 'sessionController') {
        return {
          cancel: async () => {
            calls.cancel += 1;
            if (onCancel === 'close') {
              // 收尾：补 turn/end（真实宿主还会补 interrupted 的 assistant，这里只需闭合）
              state.log.push({ type: 'turn/end', seq: state.log.length, time: Date.now(), data: { turn: 1 } });
            }
            return { ok: true };
          },
        };
      }
      return undefined;
    },
  };

  const dispose = apply(ctx);

  const request = async (path, body) => {
    const route = routes.get(path);
    assert.ok(route, `路由未注册：${path}`);
    const listeners = {};
    const req = {
      method: 'POST',
      url: path,
      headers: { host: '127.0.0.1:43120', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        (listeners[event] ||= []).push(cb);
        return req;
      },
      destroy() {},
      resume() {},
    };
    const res = { statusCode: 0, body: null };
    const done = new Promise((resolve) => {
      res.writeHead = (status) => {
        res.statusCode = status;
      };
      res.end = (payload) => {
        res.body = payload ? JSON.parse(payload) : null;
        resolve();
      };
    });
    const fired = route.handler(req, res);
    queueMicrotask(() => {
      (listeners.data || []).forEach((cb) => cb(Buffer.from(JSON.stringify(body))));
      (listeners.end || []).forEach((cb) => cb());
    });
    await Promise.all([done, Promise.resolve(fired)]);
    return res;
  };

  return { request, calls, appended, state, dispose };
}

// 超时分支要跑得便宜：把等待预算压到 300ms / 50ms。
configureStopWait({ timeoutMs: 300, pollMs: 50 });

await check('回合进行中：先 cancel，不是直接回 409 busy', async () => {
  const harness = makeHarness({ onCancel: 'close' });
  const res = await harness.request('/wm-delete/delete', {
    sessionId: SESSION_ID,
    mode: 'reply',
    turn: 1,
    scope: 'segment',
  });
  assert.equal(harness.calls.cancel, 1, '应恰好调用一次 sessionController.cancel');
  assert.notEqual(res.statusCode, 409, `不应回 409 busy，实际 ${res.statusCode} / ${JSON.stringify(res.body)}`);
});

await check('cancel 之后重新读日志再规划：替换事件落在收尾后的 surface 上', async () => {
  const harness = makeHarness({ onCancel: 'close' });
  const before = harness.state.log.length;
  const res = await harness.request('/wm-delete/delete', {
    sessionId: SESSION_ID,
    mode: 'reply',
    turn: 1,
    scope: 'segment',
  });
  assert.equal(res.statusCode, 200, `应成功，实际 ${res.statusCode} / ${JSON.stringify(res.body)}`);
  // 收尾补了 turn/end（+1），删除又追加了替换载体（+1）
  assert.ok(harness.state.log.length > before, '日志应增长');
  const last = harness.appended[harness.appended.length - 1];
  assert.equal(last.type, 'user/message', '载体应是 user/message');
  assert.ok(last.surfaceOp, '载体应带 surfaceOp');
  assert.ok(Array.isArray(last.sourceEventSeqs), '载体应带 sourceEventSeqs');
});

await check('等不到 turn/end：回 stop-timeout，且**不落地**任何替换事件', async () => {
  const harness = makeHarness({ onCancel: 'never' });
  const res = await harness.request('/wm-delete/delete', {
    sessionId: SESSION_ID,
    mode: 'reply',
    turn: 1,
    scope: 'segment',
  });
  assert.equal(res.statusCode, 409, `应回 409，实际 ${res.statusCode}`);
  assert.equal(res.body.code, 'stop-timeout', `应为 stop-timeout，实际 ${res.body.code}`);
  assert.equal(harness.calls.cancel, 1, '仍应尝试过一次 cancel');
  assert.equal(harness.calls.append, 0, '超时时绝不能落地替换事件');
});

await check('正在压缩（没有停止语义）：仍回 busy，且不调用 cancel', async () => {
  const harness = makeHarness({ onCancel: 'close' });
  // 真实形状：回合已闭合，但压缩括号还没收 —— 压缩没有"停止"语义。
  harness.state.log = closedLog();
  harness.state.log.push({ type: 'compaction/start', seq: harness.state.log.length, time: Date.now(), data: {} });
  const res = await harness.request('/wm-delete/delete', {
    sessionId: SESSION_ID,
    mode: 'reply',
    turn: 1,
    scope: 'segment',
  });
  assert.equal(res.statusCode, 409, `应回 409，实际 ${res.statusCode}`);
  assert.equal(res.body.code, 'busy', `应为 busy，实际 ${res.body.code}`);
  assert.equal(harness.calls.cancel, 0, '压缩中不应调用 cancel');
});

await check('已闭合回合：不该无谓地取消（cancel 计数为 0）', async () => {
  const harness = makeHarness({ onCancel: 'close' });
  harness.state.log = closedLog();
  const res = await harness.request('/wm-delete/delete', {
    sessionId: SESSION_ID,
    mode: 'reply',
    turn: 1,
    scope: 'segment',
  });
  assert.equal(res.statusCode, 200, `应直接成功，实际 ${res.statusCode} / ${JSON.stringify(res.body)}`);
  assert.equal(harness.calls.cancel, 0, '未在生成中不应调用 cancel');
});

configureStopWait({});

console.log(`\nwm-delete 先停后删：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
