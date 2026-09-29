/**
 * wm-delete-host.test.mjs — 消息删除半边的宿主集成测试（不需要 DSH 进程）。
 *
 * 把宿主半边挂到一个假的 cordis ctx 上，然后直接驱动它注册的两条路由：
 *   - /wm-delete/state  读日志 → 折叠 surface → 回报隐藏台账与可删回合
 *   - /wm-delete/delete 规划区间 → 追加替换事件 → 等持久化检查点
 *
 * 最关键的一条：追加出来的替换事件会再过一遍**官方** `foldSurface`
 * （从本机 DSH 安装里动态载入 `@deepseek-ai/dsh-session`）。官方折叠会校验
 * surfaceOp 形状、startSeq/endSeq 必须指向更早的事件、sourceEventSeqs 必须
 * 完整覆盖被遮蔽节点——所以这一步等于用真实的 0.1.5-rc.2 契约验收我们的事件。
 * 找不到 DSH 安装时这一步会明确跳过（其余断言照跑），不会假通过。
 *
 * 跑法：node parts/delete/tests/wm-delete-host.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply } from '../lib/index.js';
import { PLUGIN_ID, foldSurface as ourFoldSurface } from '../lib/logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = 'session-8c5d8123-cce9-4c85-9532-6a00c36a92fa';

// 日志隔离。这个半边把每次拒绝写进 $DSH_HOME\dsh-wm-delete.log，而测试以前是直接写进
// **真实的** DSH_HOME —— 生产和测试的记录混在同一个文件里。排查线上问题时会在里面看到
// 成批测试造的 session-not-active / busy / invalid，很容易被带偏（别问怎么知道的）。
const LOG_HOME = mkdtempSync(join(tmpdir(), 'wm-delete-test-'));
process.env.DSH_HOME = LOG_HOME;
const DELETE_LOG = join(LOG_HOME, 'dsh-wm-delete.log');

/** 读回日志的最后一条（没有则 null）。 */
function lastLogEntry() {
  if (!existsSync(DELETE_LOG)) return null;
  const lines = readFileSync(DELETE_LOG, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}

// ---------------------------------------------------------------- 合成日志

const userSource = (rpcId) => ({ kind: 'user', rpcId, clientTimeZone: 'Asia/Shanghai' });
const ctxSource = () => ({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] });

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
  push('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'B' }] } }, 'append');
  push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh' });
  push('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', content: [{ type: 'tool-result', content: 'ok' }] } }, 'append');
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1 });
  return events;
}

/**
 * 一个回合里中途插了一次话的日志（线上事故同形）：
 * 提问 u1 → a1 + 工具 t1 → 插话 u2 → a2。
 * surface 节点顺序：system(1) → u1(2) → a1(4) → t1(6) → u2(10) → a2(11)
 */
function buildSteeringLog() {
  const events = [];
  const push = (type, data, surfaceOp) => {
    const event = { type, seq: events.length, time: 1000 + events.length, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
    return event;
  };
  push('turn/start', { turn: 1 });
  push('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system' }] } }, 'append');
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'A' }], source: userSource('r1') }, 'append');
  push('step/start', { turn: 1, step: 1 });
  push('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'B' }] } }, 'append');
  push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh' });
  push('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', content: [{ type: 'tool-result', content: 'ok' }] } }, 'append');
  push('step/end', { turn: 1, step: 1 });
  push('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'u2', source: userSource('r2') }] });
  push('step/start', { turn: 1, step: 2 });
  push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'C' }], source: userSource('r2') }, 'append');
  push('assistant/message', { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'D' }] } }, 'append');
  push('step/end', { turn: 1, step: 2 });
  push('turn/end', { turn: 1 });
  return events;
}

// ---------------------------------------------------------------- 假宿主

function makeHarness(log, options = {}) {
  const routes = new Map();
  const appended = [];
  const state = { log: log.map((event) => ({ ...event })), flushed: 0 };

  const session = {
    snapshotEvents: () => state.log,
    append: (type, data, opts) => {
      const event = { type, seq: state.log.length, time: Date.now(), data, ...(opts || {}) };
      state.log.push(event);
      appended.push(event);
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
    get: (name) => {
      if (name === 'sessions') {
        if (options.noLiveSession) return null;
        // options.liveIds：把任意形状的会话 id（桥接会话）也认成"已打开"。
        const live = new Set([SESSION_ID, SESSION_ID.replace('session-', ''), ...(options.liveIds || [])]);
        return { get: (id) => (live.has(id) ? session : undefined) };
      }
      if (name === 'sessionQuery') return options.noQuery ? null : { readSession: async () => ({ events: state.log }) };
      if (name === 'sessionPersistence') return { flush: async () => { state.flushed += 1; } };
      if (name === 'sessionController') return undefined;
      return undefined;
    },
  };

  const dispose = apply(ctx);

  const request = async ({ method = 'GET', path, headers = {}, body = null, remote = '127.0.0.1' }) => {
    const route = routes.get(path.split('?')[0]);
    assert.ok(route, `路由未注册：${path}`);
    const listeners = {};
    const req = {
      method,
      url: path,
      headers: { host: '127.0.0.1:43120', ...headers },
      socket: { remoteAddress: remote },
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
      if (body !== null) {
        (listeners.data || []).forEach((cb) => cb(Buffer.from(body)));
      }
      (listeners.end || []).forEach((cb) => cb());
    });
    await Promise.all([done, Promise.resolve(fired)]);
    return res;
  };

  return { routes, request, state, appended, session, dispose };
}

// ---------------------------------------------------------------- 载入官方契约

let officialFoldSurface = null;
let officialPath = null;
const candidates = [
  process.env.DSH_SESSION_MODULE,
  'D:\\Program Files (x86)\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-session\\lib\\index.js',
].filter(Boolean);
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  try {
    const mod = await import(pathToFileURL(candidate).href);
    if (typeof mod.foldSurface === 'function') {
      officialFoldSurface = mod.foldSurface;
      officialPath = candidate;
      break;
    }
  } catch (error) {
    console.log(`  （载入官方 dsh-session 失败，将跳过契约验收：${String(error.message || error)}）`);
  }
}

// 会话格式 v4 的行接纳守卫：正是它在生产环境拒绝 v3 的 plugin 包装，
// 并让「写替换事件」的整个 turn 在 step 0 失败。
let officialV4RowAdmission = null;
const v4Candidates = [
  process.env.DSH_SESSION_FORMAT_V4_MODULE,
  'D:\\Program Files (x86)\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-session-format-v3-to-v4\\lib\\index.js',
].filter(Boolean);
for (const candidate of v4Candidates) {
  if (!existsSync(candidate)) continue;
  try {
    const mod = await import(pathToFileURL(candidate).href);
    if (typeof mod.assertV4RowAdmission === 'function') {
      officialV4RowAdmission = mod.assertV4RowAdmission;
      break;
    }
  } catch (error) {
    console.log(`  （载入官方 v4 格式守卫失败，将跳过该验收：${String(error.message || error)}）`);
  }
}

// ---------------------------------------------------------------- 测试

const log = buildLog();
const harness = makeHarness(log);

await check('apply 注册了两条路由，且路径与客户端一致', () => {
  assert.deepEqual([...harness.routes.keys()].sort(), ['/wm-delete/delete', '/wm-delete/state']);
});

await check('GET /wm-delete/state 回报当前 surface、空台账与可删回合', async () => {
  const res = await harness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.surface, [2, 3, 4, 6, 8]);
  assert.deepEqual(res.body.hidden, []);
  assert.deepEqual(res.body.replyTurns, [1]);
  assert.equal(res.body.busy, false);
  assert.equal(res.body.live, true);
});

await check('守卫：非回环 socket 一律 403', async () => {
  const res = await harness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}`, remote: '192.168.1.9' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden');
});

await check('守卫：跨源 Origin 一律 403', async () => {
  const res = await harness.request({
    path: `/wm-delete/state?sessionId=${SESSION_ID}`,
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(res.statusCode, 403);
});

await check('守卫：Host 头不是本机时 403（防 DNS rebinding）', async () => {
  const res = await harness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}`, headers: { host: 'evil.example' } });
  assert.equal(res.statusCode, 403);
});

await check('守卫：会话 id 不合法时 400', async () => {
  const res = await harness.request({ path: '/wm-delete/state?sessionId=../etc/passwd' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid');
});

await check('守卫：/wm-delete/delete 只接受 POST', async () => {
  const res = await harness.request({ path: '/wm-delete/delete' });
  assert.equal(res.statusCode, 405);
});

await check('POST /wm-delete/delete 删一条指令：追加的替换事件形状正确', async () => {
  const res = await harness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'message', seq: 3 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.hidden, [{ seq: 3, mode: 'message' }]);
  assert.equal(res.body.flushed, true, '应等到持久化检查点');
  assert.equal(harness.state.flushed, 1);

  assert.equal(harness.appended.length, 1);
  const event = harness.appended[0];
  assert.equal(event.type, 'user/message');
  assert.equal(event.data.role, 'user');
  // v4 会话格式要求「生产者自己的 kind」：{ kind: 'plugin:<插件名>' }。
  // 写成 v3 的 { kind: 'plugin', plugin: X } 会被 v4 写入守卫拒绝
  // （format v4 message requires a producer-owned source kind），整个 turn 都会失败。
  assert.deepEqual(event.data.source, { kind: `plugin:${PLUGIN_ID}` });
  assert.notEqual(event.data.source.kind, 'plugin', '不得再写出退役的 v3 plugin 包装');
  assert.match(event.data.content[0].text, /\[deleted\]/);
  assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 });
  assert.deepEqual(event.sourceEventSeqs, [3]);
  assert.equal(typeof event.data.id, 'string');
  assert.equal(event.seq, 11, '新事件应追加在日志尾部');
});

await check('追加的替换事件能通过官方 v4 行接纳守卫（回归：v3 plugin 包装曾让整个 turn 失败）', () => {
  if (officialV4RowAdmission === null) {
    skipped += 1;
    console.log('    （未找到官方 v4 守卫模块，跳过）');
    return;
  }
  const event = harness.appended[0];
  // 实际写出的那一行必须被接纳。
  officialV4RowAdmission(event);
  // 并且旧写法必须被拒绝——否则这条回归测试就失去意义。
  assert.throws(
    () => officialV4RowAdmission({ ...event, data: { ...event.data, source: { kind: 'plugin', plugin: PLUGIN_ID } } }),
    /producer-owned source kind/,
    'v3 的 plugin 包装应当被 v4 守卫拒绝',
  );
});

await check('删除后 /wm-delete/state 报出隐藏台账，且目标离开 surface', async () => {
  const res = await harness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.hidden, [{ seq: 3, mode: 'message', replacement: 11 }]);
  assert.ok(!res.body.surface.includes(3), '被删节点不应还在 surface 上');
  // 替换事件**就地**顶替被删节点在 surface 上的位置（不是追加到尾部）
  assert.deepEqual(res.body.surface, [2, 11, 4, 6, 8]);
});

await check('重复删同一条 → already-deleted（409）', async () => {
  const res = await harness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'message', seq: 3 }),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'already-deleted');
});

await check('删系统提示词头 → not-deletable（400）', async () => {
  const res = await harness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'reply', seq: 2 }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'not-deletable');
});

await check('mode 非法 → invalid（400）', async () => {
  const res = await harness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'everything', seq: 3 }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid');
});

await check('会话没有打开（无 live session）→ session-not-active（409）', async () => {
  const h = makeHarness(buildLog(), { noLiveSession: true });
  const res = await h.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'message', seq: 3 }),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'session-not-active');
});

// ---------------------------------------------------------------- 会话 id 形状（回归：桥接会话删不掉）

/**
 * 线上事故：DSH 的会话 id **不只有 uuid**。外部桥接进来的会话是别的形状，实测两种：
 *   lark-link:dm:oc_2a58…:mujqtyuo8ej7:0       （飞书桥接）
 *   aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A    （agents-anywhere）
 *
 * 旧白名单 `^(session-)?<uuid>$` 把它们全判成非法：浏览器半边连请求都不发，界面报
 * 「这个会话当前未激活」（而宿主日志一片空白）；宿主半边则会 400 invalid。
 * 两边合起来就是「会话明明开着，就是删不掉」。
 */
const BRIDGED_SESSION_IDS = [
  'lark-link:dm:oc_2a58532568e31412e69a47fc0cbb31f6:mujqtyuo8ej7:0',
  'aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A',
];

for (const bridgedId of BRIDGED_SESSION_IDS) {
  const label = `${bridgedId.slice(0, 24)}…`;

  await check(`桥接会话 id 能通过白名单并真的删掉（${label}）`, async () => {
    const h = makeHarness(buildLog(), { liveIds: [bridgedId] });
    const res = await h.request({
      method: 'POST',
      path: '/wm-delete/delete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: bridgedId, mode: 'message', seq: 3 }),
    });
    assert.equal(res.statusCode, 200, `实际 ${res.statusCode} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    assert.ok(h.appended.length >= 1, '应追加了替换事件');
  });

  await check(`桥接会话 id 未打开时回 session-not-active，而不是 invalid（${label}）`, async () => {
    const h = makeHarness(buildLog(), { noLiveSession: true });
    const res = await h.request({
      method: 'POST',
      path: '/wm-delete/delete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: bridgedId, mode: 'message', seq: 3 }),
    });
    assert.equal(res.statusCode, 409, `实际 ${res.statusCode} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'session-not-active');
  });

  await check(`/wm-delete/state 也接受桥接会话 id（${label}）`, async () => {
    const h = makeHarness(buildLog(), { liveIds: [bridgedId] });
    const res = await h.request({ path: `/wm-delete/state?sessionId=${encodeURIComponent(bridgedId)}` });
    assert.equal(res.statusCode, 200, `实际 ${res.statusCode} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.live, true);
  });
}

await check('放宽形状后，路径穿越/控制字符/空/超长 仍然一律 400', async () => {
  const bad = ['../../etc/passwd', '..\\..\\windows', 'a/b', 'a\\b', '..', '.', '', '   ', 'x'.repeat(201), 'bad\u0000id', 'bad\nid'];
  const h = makeHarness(buildLog());
  for (const id of bad) {
    const res = await h.request({
      method: 'POST',
      path: '/wm-delete/delete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id, mode: 'message', seq: 3 }),
    });
    assert.equal(res.statusCode, 400, `id=${JSON.stringify(id)} 应 400，实际 ${res.statusCode}`);
    assert.equal(res.body.code, 'invalid', `id=${JSON.stringify(id)} 的 code 应为 invalid`);
  }
});

await check('拒绝日志里带上 sessionId（否则线上排查看不出是哪个会话）', async () => {
  const id = BRIDGED_SESSION_IDS[0];
  const h = makeHarness(buildLog(), { noLiveSession: true });
  await h.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id, mode: 'message', seq: 3 }),
  });
  const entry = lastLogEntry();
  assert.ok(entry, '应当写出了日志');
  assert.equal(entry.message, '/wm-delete/delete 被拒绝');
  assert.equal(entry.data.sessionId, id, '日志里必须能看到是哪个会话');
  assert.equal(entry.data.code, 'session-not-active');
});

await check('回合未闭合（还在跑）→ busy（409）', async () => {
  const busyLog = buildLog();
  busyLog.push({ type: 'turn/start', seq: busyLog.length, time: 1, data: { turn: 2 } });
  const h = makeHarness(busyLog);
  const res = await h.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'message', seq: 3 }),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'busy');
});

await check('json 体损坏 → invalid（400）', async () => {
  const h = makeHarness(buildLog());
  const res = await h.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid');
});

await check('dispose 撤掉两条路由', () => {
  const h = makeHarness(buildLog());
  assert.equal(h.routes.size, 2);
  h.dispose();
  assert.equal(h.routes.size, 0);
});

// ---------------------------------------------------------------- 回合中途插话（回归：删多 / 删不干净）

// 默认行为：只删被点的那一段（方案二）。
const segmentHarness = makeHarness(buildSteeringLog());

await check('回合中途插话：默认只删被点的那一段，另一段与两条提问都保留', async () => {
  const res = await segmentHarness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    // 点插话之后那一段的段尾助手消息（seq 11）
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'reply', seq: 11, turn: 1 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.hidden, [{ seq: 11, mode: 'reply' }]);
  assert.equal(segmentHarness.appended.length, 1, '只该追加一条替换事件');
  assert.deepEqual(segmentHarness.appended[0].surfaceOp, { op: 'replace', startSeq: 11, endSeq: 11 });
  assert.deepEqual(segmentHarness.appended[0].sourceEventSeqs, [11]);
  // 插话之前那一段（4、6）必须还在 surface 上——这正是"删多了"的反面
  const state = await segmentHarness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}` });
  assert.equal(state.statusCode, 200);
  for (const seq of [4, 6, 2, 10]) assert.ok(state.body.surface.includes(seq), `seq ${seq} 不应被删`);
  assert.equal(state.body.segmentsByTurn['1'], 1, '删完一段后这一轮还剩 1 段');
  assert.deepEqual(state.body.segmentTails, [4], '剩下那一段的段尾是助手消息 4（不是工具结果 6）');
});

// 显式勾选整轮：一次把两段都删（方案一）。
const wholeTurnHarness = makeHarness(buildSteeringLog());

await check('回合中途插话：scope=turn 才一次追加两段替换，两条提问都保留', async () => {
  const res = await wholeTurnHarness.request({
    method: 'POST',
    path: '/wm-delete/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, mode: 'reply', turn: 1, scope: 'turn' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.notEqual(res.body.partial, true);
  assert.deepEqual(res.body.hidden, [
    { seq: 4, mode: 'reply' },
    { seq: 6, mode: 'reply' },
    { seq: 11, mode: 'reply' },
  ]);
  assert.equal(wholeTurnHarness.appended.length, 2, '两段窗口应各追加一条替换事件');
  assert.deepEqual(
    wholeTurnHarness.appended.map((event) => event.surfaceOp),
    [{ op: 'replace', startSeq: 4, endSeq: 6 }, { op: 'replace', startSeq: 11, endSeq: 11 }],
  );
  assert.deepEqual(wholeTurnHarness.appended.map((event) => event.sourceEventSeqs), [[4, 6], [11]]);
  assert.deepEqual(
    wholeTurnHarness.appended.map((event) => event.data.source),
    [{ kind: `plugin:${PLUGIN_ID}` }, { kind: `plugin:${PLUGIN_ID}` }],
  );
  // 删除响应当场回报"已经被删空的回合"，让浏览器半边把过程分组壳/重试行一并收起
  assert.deepEqual(res.body.clearedTurns, [1], '回合 1 已删空（只剩两条提问）');
});

await check('回合中途插话：整轮删除后两条提问仍在 surface 上，回复内容全部离场', async () => {
  const res = await wholeTurnHarness.request({ path: `/wm-delete/state?sessionId=${SESSION_ID}` });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.surface.includes(2) && res.body.surface.includes(10), '真人提问必须保留');
  for (const seq of [4, 6, 11]) assert.ok(!res.body.surface.includes(seq), `seq ${seq} 应离开 surface`);
  assert.deepEqual(res.body.replyTurns, [], '已经没有回复内容的回合不再报可删');
  assert.deepEqual(res.body.clearedTurns, [1], '/state 也要报被删空的回合（刷新后壳行照样收起）');
});

// ---------------------------------------------------------------- 官方契约验收

if (officialFoldSurface === null) {
  skipped += 1;
  console.log('  ⚠ 跳过官方 surface 契约验收：本机没找到 @deepseek-ai/dsh-session（可用 DSH_SESSION_MODULE 指路）');
} else {
  await check(`官方 foldSurface 接受我们的替换事件，且被删内容真的离开 surface（${officialPath}）`, () => {
    // 我们自己的折叠与官方折叠必须一致
    const ours = ourFoldSurface(harness.state.log).nodes;
    const official = officialFoldSurface(harness.state.log).nodes;
    assert.deepEqual(ours, official, '自研折叠与官方折叠结果必须逐位一致');
    assert.ok(!official.includes(3), '被删的用户消息不应还在官方 surface 上');
  });

  await check('官方契约会拒绝"漏报被遮蔽节点"的替换（证明我们的 sourceEventSeqs 不是摆设）', () => {
    const broken = buildLog();
    broken.push({
      type: 'user/message',
      seq: broken.length,
      time: 1,
      data: {
        id: 'bad',
        role: 'user',
        content: [{ type: 'text', text: '[deleted]' }],
        source: { kind: `plugin:${PLUGIN_ID}` },
      },
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 8 },
      sourceEventSeqs: [6], // 故意漏掉 8
    });
    assert.throws(() => officialFoldSurface(broken), /sourceEventSeqs must include every shadowed surface node/);
  });

  await check('官方契约会拒绝 assistant/message 携带 sourceEventSeqs（所以我们才用 user/message 当载体）', () => {
    const broken = buildLog();
    broken.push({
      type: 'assistant/message',
      seq: broken.length,
      time: 1,
      data: { turn: 1, step: 1, message: { id: 'bad', role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      sourceEventSeqs: [3],
    });
    assert.throws(() => officialFoldSurface(broken), /cannot carry sourceEventSeqs/);
  });

  await check('官方契约会拒绝遮蔽范围里的锚点不存在（stale 检测有真实依据）', () => {
    const broken = buildLog();
    broken.push({
      type: 'user/message',
      seq: broken.length,
      time: 1,
      data: {
        id: 'bad',
        role: 'user',
        content: [{ type: 'text', text: '[deleted]' }],
        source: { kind: `plugin:${PLUGIN_ID}` },
      },
      surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 },
      sourceEventSeqs: [999],
    });
    assert.throws(() => officialFoldSurface(broken));
  });

  await check('官方 foldSurface 接受多段替换事件：提问留下、两截回复都离场', () => {
    const ours = ourFoldSurface(wholeTurnHarness.state.log).nodes;
    const official = officialFoldSurface(wholeTurnHarness.state.log).nodes;
    assert.deepEqual(ours, official, '自研折叠与官方折叠结果必须逐位一致');
    assert.ok(official.includes(2) && official.includes(10), '真人提问必须还在官方 surface 上');
    for (const seq of [4, 6, 11]) assert.ok(!official.includes(seq), `seq ${seq} 应离开官方 surface`);
  });

  await check('官方 foldSurface 接受"只删一段"的单条替换：另一段仍在 surface 上', () => {
    const ours = ourFoldSurface(segmentHarness.state.log).nodes;
    const official = officialFoldSurface(segmentHarness.state.log).nodes;
    assert.deepEqual(ours, official, '自研折叠与官方折叠结果必须逐位一致');
    assert.ok(official.includes(4) && official.includes(6), '没被点的那一段必须原样留在模型上下文里');
    assert.ok(!official.includes(11), '被点的那一段离开 surface');
  });
}

console.log(`\nwm-delete 宿主集成测试：${passed}/${passed + failed} 通过${skipped ? '（1 项跳过）' : ''}`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
