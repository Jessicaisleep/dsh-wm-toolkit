/**
 * purge-queue-host.test.mjs — /bubble/purge-resurrected-queue 路由的宿主集成测试。
 *
 * 验证三件事：
 *   1. 路由确实按官方形状调用了 sessionController.updateQueue({ sessionId, itemId, action:{kind:'remove'} })；
 *   2. 只删"幽灵"，用户真实排队、还没跑的消息原样保留；
 *   3. 编辑后新入队的文本（fork 之后的事件）绝不在删除名单里 —— 即 seed 前缀切分是生效的。
 *
 * 跑法：node parts/recall/tests/purge-queue-host.test.mjs
 */
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const C30F = 'c30fd50f-85e8-4405-b38b-67ea22e485ea';
const EIGHT = '89852fe9-a737-41fd-98bf-abaf91b1c42a';
const ONE = '4aa7b046-e950-4bb0-999c-618194bf853b';
const FRESH = 'aaaaaaaa-1111-2222-3333-444444444444';

const SRC = 'session-a347bff8-79a6-4905-a746-8e76dcbf08cd';
const CHILD = 'session-6cc42136-6f0f-4c46-bd2c-2364d5c9fc71';

const msg = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `r-${id.slice(0, 6)}` } });
const splice = (seq, start, removedCount, inserted) => ({
  seq, type: 'agent/inbox/spliced', time: 1000 + seq,
  data: { target: 'next-turn', start, ...(removedCount > 0 ? { removedCount } : {}), inserted },
});
const turnEnd = (seq, turn) => ({ seq, type: 'turn/end', time: 1000 + seq, data: { turn } });
const turnStart = (seq, turn) => ({ seq, type: 'turn/start', time: 1000 + seq, data: { turn } });

const sourceEvents = (extra = []) => [
  turnEnd(4526, 63),
  splice(4528, 0, 0, [msg(C30F, '做一个演示介绍视频…')]),
  splice(4531, 1, 0, [msg(EIGHT, '…啊')]),
  turnStart(4532, 64),
  splice(4533, 0, 1, []),
  { seq: 4536, type: 'user/message', time: 5536, data: msg(C30F, '做一个演示介绍视频…') },
  splice(4542, 0, 1, []),
  turnEnd(4543, 64),
  ...extra,
];

const seedEvents = (extra = []) => [
  turnEnd(4526, 63),
  splice(4528, 0, 0, [msg(C30F, '做一个演示介绍视频…')]),
  splice(4531, 1, 0, [msg(EIGHT, '…啊')]),
  ...extra,
];

let passed = 0;
let failed = 0;
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

/** 挂上 recall 半边，取回目标路由。 */
function mount({ source, child, childInherited, noController = false }) {
  const routes = new Map();
  const updateQueueCalls = [];
  // cordis 会把 inject 里声明的服务同时挂成 ctx 属性（recall 半边 inject 含 'sessions'），
  // 所以假 ctx 也要有 ctx.sessions —— 只有 ctx.get() 不算真实环境。
  const sessionsService = { get: (id) => (id === SRC ? source : (id === CHILD ? child : undefined)) };
  const ctx = {
    settings: { register: () => {} },
    storageDomain: { open: () => Promise.resolve({ table: () => ({}) }) },
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
    sessions: sessionsService,
    get: (name) => {
      if (name === 'sessions') return sessionsService;
      if (name === 'sessionController') {
        if (noController) return undefined;
        return {
          updateQueue: async (request) => {
            updateQueueCalls.push(request);
            return { accepted: true };
          },
        };
      }
      return undefined;
    },
  };
  apply(ctx);
  const route = routes.get('/bubble/purge-resurrected-queue');
  assert.ok(route, '路由应已注册');

  const call = async (body) => {
    const listeners = {};
    const req = {
      method: 'POST',
      url: '/bubble/purge-resurrected-queue',
      headers: { host: '127.0.0.1:43120', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) { (listeners[event] ||= []).push(cb); return req; },
      destroy() {}, resume() {},
    };
    const res = { statusCode: 0, body: null };
    const done = new Promise((resolve) => {
      res.writeHead = (status) => { res.statusCode = status; };
      res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; resolve(); };
    });
    const fired = route.handler(req, res);
    queueMicrotask(() => {
      (listeners.data || []).forEach((cb) => cb(Buffer.from(JSON.stringify(body))));
      (listeners.end || []).forEach((cb) => cb());
    });
    await Promise.all([done, Promise.resolve(fired)]);
    return res;
  };
  return { call, updateQueueCalls };
}

const fakeSession = (events, inherited) => ({
  inheritedEventCount: inherited,
  snapshotEvents: () => events,
});

await check('路由按官方形状删除幽灵（只删 seed 里的、不在源队列里的）', async () => {
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession(seedEvents(), seedEvents().length),
  });
  const res = await harness.call({ childSessionId: CHILD, sourceSessionId: SRC });
  if (res.statusCode !== 200) console.error('    DEBUG body =', JSON.stringify(res.body));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.removed, [C30F, EIGHT]);
  assert.deepEqual(res.body.failed, []);
  assert.deepEqual(harness.updateQueueCalls, [
    { sessionId: CHILD, itemId: C30F, action: { kind: 'remove' } },
    { sessionId: CHILD, itemId: EIGHT, action: { kind: 'remove' } },
  ]);
});

await check('fork 之后新入队的编辑文本不在删除名单里', async () => {
  // 子会话全量日志 = seed + 「1」已入队；inheritedEventCount 仍指向 seed 边界
  const childFull = seedEvents([splice(4534, 2, 0, [msg(ONE, '1')])]);
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession(childFull, seedEvents().length),
  });
  const res = await harness.call({ childSessionId: CHILD, sourceSessionId: SRC });
  assert.deepEqual(res.body.removed, [C30F, EIGHT]);
  assert.ok(!harness.updateQueueCalls.some((c) => c.itemId === ONE), '编辑文本绝不能被删');
});

await check('源会话里仍排着的消息保留（用户真的还等着跑的）', async () => {
  const source = sourceEvents([splice(4544, 0, 0, [msg(FRESH, '还没跑的消息')])]);
  const child = seedEvents([splice(4532, 2, 0, [msg(FRESH, '还没跑的消息')])]);
  const harness = mount({ source: fakeSession(source, 0), child: fakeSession(child, child.length) });
  const res = await harness.call({ childSessionId: CHILD, sourceSessionId: SRC });
  assert.deepEqual(res.body.removed, [C30F, EIGHT], 'FRESH 必须保留');
  assert.ok(!harness.updateQueueCalls.some((c) => c.itemId === FRESH));
});

await check('队列干净时一个 updateQueue 都不调', async () => {
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession([turnEnd(4526, 63)], 1),
  });
  const res = await harness.call({ childSessionId: CHILD, sourceSessionId: SRC });
  assert.deepEqual(res.body.removed, []);
  assert.equal(harness.updateQueueCalls.length, 0);
});

await check('单个 item 删除失败不影响其余（降级为 failed 列表）', async () => {
  const routesCalls = [];
  const sessionsService = { get: (id) => (id === SRC ? fakeSession(sourceEvents(), 0) : fakeSession(seedEvents(), seedEvents().length)) };
  const ctx = {
    settings: { register: () => {} },
    storageDomain: { open: () => Promise.resolve({ table: () => ({}) }) },
    webServer: { register: (route) => { routesCalls.push(route); return () => {}; } },
    sessions: sessionsService,
    get: (name) => {
      if (name === 'sessions') return sessionsService;
      if (name === 'sessionController') {
        return {
          updateQueue: async (request) => {
            if (request.itemId === C30F) throw new Error('queue-item-not-found');
            return { accepted: true };
          },
        };
      }
      return undefined;
    },
  };
  apply(ctx);
  const route = routesCalls.find((r) => r.path === '/bubble/purge-resurrected-queue');
  const listeners = {};
  const req = {
    method: 'POST', url: '/bubble/purge-resurrected-queue',
    headers: { host: '127.0.0.1:43120', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) { (listeners[event] ||= []).push(cb); return req; }, destroy() {}, resume() {},
  };
  let payload = null;
  const done = new Promise((resolve) => {
    const res = { writeHead() {}, end: (p) => { payload = JSON.parse(p); resolve(); } };
    route.handler(req, res);
  });
  queueMicrotask(() => {
    (listeners.data || []).forEach((cb) => cb(Buffer.from(JSON.stringify({ childSessionId: CHILD, sourceSessionId: SRC }))));
    (listeners.end || []).forEach((cb) => cb());
  });
  await done;
  assert.deepEqual(payload.removed, [EIGHT]);
  assert.deepEqual(payload.failed, [C30F]);
});

await check('sessionController 不可用时降级为 failed，不抛 500', async () => {
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession(seedEvents(), seedEvents().length),
    noController: true,
  });
  const res = await harness.call({ childSessionId: CHILD, sourceSessionId: SRC });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.removed, []);
  assert.deepEqual(res.body.failed, [C30F, EIGHT]);
});

await check('会话 id 非法（空 / 超长）→ 400', async () => {
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession(seedEvents(), seedEvents().length),
  });
  assert.equal((await harness.call({ childSessionId: '', sourceSessionId: SRC })).statusCode, 400);
  assert.equal((await harness.call({ childSessionId: CHILD, sourceSessionId: 'x'.repeat(201) })).statusCode, 400);
});

await check('非 POST → 405', async () => {
  const harness = mount({
    source: fakeSession(sourceEvents(), 0),
    child: fakeSession(seedEvents(), seedEvents().length),
  });
  const routesCalls = [];
  const ctx = {
    settings: { register: () => {} },
    storageDomain: { open: () => Promise.resolve({ table: () => ({}) }) },
    webServer: { register: (route) => { routesCalls.push(route); return () => {}; } },
    get: () => undefined,
  };
  apply(ctx);
  const route = routesCalls.find((r) => r.path === '/bubble/purge-resurrected-queue');
  const req = {
    method: 'GET', url: '/bubble/purge-resurrected-queue',
    headers: { host: '127.0.0.1:43120', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return req; }, destroy() {}, resume() {},
  };
  let status = 0;
  await new Promise((resolve) => {
    route.handler(req, { writeHead: (s) => { status = s; }, end: () => resolve() });
  });
  assert.equal(status, 405);
  void harness;
});

console.log(`\n复活队列清理·宿主集成：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
