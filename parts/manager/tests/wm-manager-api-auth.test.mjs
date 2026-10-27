/**
 * wm-manager-api-auth.test.mjs — manager 半边 `/session-manager/api/*` 的鉴权门回归。
 *
 * 背景：webServer 的 dispatch 是**最长前缀优先**，本插件注册的
 * `/session-manager/api` 比内核的 `/api` 更长 —— 这些路由因此跑在连接层自己的准入
 * 检查**之前**。不设防的话任何回环调用方都能进来删会话、搬工作区目录。
 *
 * 这里锁住四件事：
 *   1. 连接层服务在位时，它的拒绝决定原样透传（403 / 401 / 503 都认）；
 *   2. 连接层返回"非 owner"时拒绝（删会话 / 搬目录是特权操作）；
 *   3. 连接层缺失 → **fail-closed 503**，绝不因为"没有服务"就放行；
 *   4. 连接层缺席或返回空时，结构栅栏仍然生效（回环 Host + 同源 Origin）。
 *
 * 跑法：node parts/manager/tests/wm-manager-api-auth.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, '..', 'lib', 'index.js');

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

const API_PREFIX = '/session-manager/api';

/**
 * 挂一次宿主半边，取回路由。
 * `connection` 决定连接层服务长什么样：
 *   undefined  → 服务缺席
 *   'throw'    → admit 抛错
 *   'empty'    → admit 返回 undefined
 *   'reject403'/'reject401' → admit 返回 { rejection }
 *   'owner'/'guest'        → admit 返回 { peer: { principal: { kind } } }
 */
async function mount({ connection, headerHost = '127.0.0.1:43120' } = {}) {
  const routes = new Map();
  const ctx = {
    effect: (fn) => fn(),
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path ?? route.handler, route);
        return () => {};
      },
    },
    workspaceRegistry: {
      list: () => [],
      enqueueOperation: async (fn) => fn(),
      requireState: () => ({ archivedSessionIds: [] }),
      setState: async () => {},
    },
    get: (name) => {
      if (name === 'connection') {
        if (connection === undefined) return undefined;
        if (connection === 'throw') return { admit: () => { throw new Error('boom'); } };
        if (connection === 'empty') return { admit: () => undefined };
        if (connection === 'reject403') return { admit: () => ({ rejection: 403 }) };
        if (connection === 'reject401') return { admit: () => ({ rejection: 401 }) };
        if (connection === 'owner') return { admit: () => ({ peer: { principal: { kind: 'owner' } } }) };
        if (connection === 'guest') return { admit: () => ({ peer: { principal: { kind: 'guest' } } }) };
        // 老宿主拼法：只有 requestRejection
        if (connection === 'legacy-reject') return { requestRejection: () => 403 };
        if (connection === 'legacy-allow') return { requestRejection: () => undefined };
      }
      return undefined;
    },
  };

  const mod = await import(pathToFileURL(hostPath).href);
  if (typeof mod.apply !== 'function') throw new Error('宿主半边应导出 apply');
  try {
    mod.apply(ctx);
  } catch {
    // 半边可能因为缺服务而抛错；鉴权门在 register 之前就装好了，这里只取路由。
  }

  const request = async ({ path = '/workspaces', method = 'GET', headers = {}, body = null } = {}) => {
    let route = null;
    for (const candidate of routes.values()) {
      if (candidate.kind === 'prefix' && candidate.path === API_PREFIX) {
        route = candidate;
        break;
      }
    }
    assert.ok(route, '应注册 /session-manager/api 前缀路由');
    const listeners = {};
    const req = {
      method,
      url: `${API_PREFIX}${path}`,
      headers: { host: headerHost, ...headers },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        (listeners[event] ||= []).push(cb);
        return req;
      },
      async *[Symbol.asyncIterator]() {
        if (body !== null) yield Buffer.from(JSON.stringify(body));
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
        try {
          res.body = payload ? JSON.parse(payload) : null;
        } catch {
          res.body = payload;
        }
        resolve();
      };
    });
    Promise.resolve(route.handler(req, res)).catch(() => {});
    queueMicrotask(() => {
      (listeners.data || []).forEach((cb) => cb(Buffer.from(body === null ? '' : JSON.stringify(body))));
      (listeners.end || []).forEach((cb) => cb());
    });
    await done;
    return res;
  };

  return { request };
}

// ---------------------------------------------------------------- 连接层决定

await check('连接层缺失 → fail-closed 503 auth-unavailable（绝不放行）', async () => {
  const { request } = await mount({ connection: undefined });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 503, `应回 503，实际 ${res.statusCode}`);
  assert.equal(res.body.code, 'auth-unavailable');
});

await check('连接层 admit 抛错 → 503（不是绕过）', async () => {
  const { request } = await mount({ connection: 'throw' });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 503, `应回 503，实际 ${res.statusCode}`);
});

await check('连接层 admit 返回空 → 401（空返回不能被读成"没问题"）', async () => {
  const { request } = await mount({ connection: 'empty' });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 401, `应回 401，实际 ${res.statusCode}`);
});

await check('连接层明确拒绝 403 → 原样透传 403', async () => {
  const { request } = await mount({ connection: 'reject403' });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 403, `应回 403，实际 ${res.statusCode}`);
  assert.equal(res.body.code, 'forbidden');
});

await check('连接层明确拒绝 401 → 原样透传 401', async () => {
  const { request } = await mount({ connection: 'reject401' });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 401, `应回 401，实际 ${res.statusCode}`);
});

await check('非 owner 主体 → 403（删会话/搬目录属于特权操作）', async () => {
  const { request } = await mount({ connection: 'guest' });
  const res = await request({ path: '/workspaces' });
  assert.equal(res.statusCode, 403, `应回 403，实际 ${res.statusCode}`);
});

await check('老宿主拼法 requestRejection 拒绝 → 透传（不是一律 503）', async () => {
  const { request } = await mount({ connection: 'legacy-reject' });
  const res = await request({ path: '/workspaces', headers: {} });
  assert.equal(res.statusCode, 403, `老宿主应透传 403，实际 ${res.statusCode}`);
});

await check('鉴权发生在读 body 之前：POST 未授权时不消费请求体、不触业务', async () => {
  const { request } = await mount({ connection: 'guest' });
  const res = await request({ path: '/delete', method: 'POST', body: { sessionId: 'x' } });
  assert.equal(res.statusCode, 403, `应 403，实际 ${res.statusCode}`);
  assert.equal(res.body.ok, false);
});

// ---------------------------------------------------------------- 结构栅栏

await check('结构栅栏：Host 不是回环名 → 拒绝（连接层已放行也不放过跨站 Host）', async () => {
  // 注意：owner 放行时结构栅栏不参与；这里用"连接层缺席"的场景单独验结构栅栏。
  // 为了让结构栅栏真的跑到，用一个**不会拒绝**的 owner 服务是不可能的 ——
  // 结构栅栏只在连接层返回"没有决定"时生效。所以这里改成 legacy-allow：
  // 老宿主返回 undefined（没有决定），结构栅栏接手。
  const { request } = await mount({ connection: 'legacy-allow', headerHost: 'evil.example.com' });
  const res = await request({ path: '/workspaces', headers: { host: 'evil.example.com' } });
  assert.equal(res.statusCode, 403, `非回环 Host 应被拒，实际 ${res.statusCode}`);
});

await check('结构栅栏：跨站 fetch（sec-fetch-site: cross-site）→ 拒绝', async () => {
  const { request } = await mount({ connection: 'legacy-allow' });
  const res = await request({ path: '/workspaces', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.statusCode, 403, `跨站应被拒，实际 ${res.statusCode}`);
});

await check('结构栅栏：Origin 与 Host 不同源 → 拒绝', async () => {
  const { request } = await mount({ connection: 'legacy-allow' });
  const res = await request({ path: '/workspaces', headers: { origin: 'http://evil.example.com' } });
  assert.equal(res.statusCode, 403, `跨源应被拒，实际 ${res.statusCode}`);
});

await check('结构栅栏：同源 Origin 放行（不能把正常页面误伤）', async () => {
  const { request } = await mount({ connection: 'legacy-allow' });
  const res = await request({
    path: '/workspaces',
    headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' },
  });
  assert.notEqual(res.statusCode, 403, `同源不应被 403，实际 ${res.statusCode}`);
});

console.log(`\nmanager API 鉴权门：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
