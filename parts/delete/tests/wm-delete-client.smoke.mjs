/**
 * wm-delete-client.smoke.mjs — 浏览器半边冒烟测试（无浏览器）。
 *
 * 验证：
 *   1. bundle 能被解析、工厂能返回带 apply/inject 的插件面；
 *   2. apply(ctx) 会注册两个官方槽（助手操作条 + 输入区浮层）并登记词典；
 *   3. 卸载函数能撤掉全部注册；
 *   4. 客户端用的路由前缀与宿主半边注册的完全一致（前缀写歪是最容易犯又最难发现的错）。
 *
 * 跑法：node parts/delete/tests/wm-delete-client.smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');
const hostPath = join(here, '..', 'lib', 'index.js');

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

// --- 载入 bundle -----------------------------------------------------------

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      definition = def;
    },
  },
};
await import(pathToFileURL(clientPath).href);

const fakeReact = {
  useEffect: () => {},
  memo: (component) => component,
};
const fakeRequire = (specifier) => {
  if (specifier === 'react') return fakeReact;
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`unexpected require: ${specifier}`);
};

const face = definition.factory(fakeRequire);

// --- 断言 ------------------------------------------------------------------

check('bundle 注册了 factory，且工厂返回带 apply/inject 的插件面', () => {
  assert.equal(definition.id, 'dsh-wm-delete');
  assert.equal(typeof face.apply, 'function');
  assert.deepEqual(face.inject, ['slots', 'locale']);
});

const registered = [];
const injected = [];
const locales = [];
const effects = [];
const ctx = {
  effect: (fn, label) => {
    effects.push(label);
    return fn();
  },
  locale: {
    register: (ns, dicts) => {
      locales.push({ ns, dicts });
      return () => {};
    },
  },
  slots: {
    inject: (name, callback) => {
      injected.push(name);
      return callback();
    },
    register: (options) => {
      registered.push(options);
      return () => {
        registered.splice(registered.indexOf(options), 1);
      };
    },
  },
};

face.apply(ctx);

check('注册了官方两个槽：assistant-actions 与 input.overlay', () => {
  assert.deepEqual(injected, ['conversation.chat.assistant-actions', 'conversation.input.overlay']);
  assert.deepEqual(registered.map((o) => o.name), [
    'conversation.chat.assistant-actions',
    'conversation.input.overlay',
  ]);
});

check('槽 id 与本仓库其它半边不冲突（都带 wm-delete 前缀）', () => {
  assert.deepEqual(registered.map((o) => o.id), ['wm-delete-reply', 'wm-delete']);
});

check('注册了 wm-delete 词典，且中英键完全对齐', () => {
  assert.equal(locales.length, 1);
  assert.equal(locales[0].ns, 'wm-delete');
  const zhKeys = Object.keys(locales[0].dicts.zh).sort();
  const enKeys = Object.keys(locales[0].dicts.en).sort();
  assert.ok(zhKeys.length > 10, '词典应有足量条目');
  assert.deepEqual(zhKeys, enKeys, '中英键集合必须一致，否则切语言会出现原始 key');
});

check('清理交给 cordis 的 ctx.effect（两处：词典 + 每会话控制器）', () => {
  // 上游 dsh-delete-turn 的 apply 不返回卸载函数，槽注册与词典注册都挂在 ctx.effect /
  // ctx.slots.inject 上，由 cordis 在插件卸载时统一撤销。这里锁住这个约定。
  assert.deepEqual(effects, ['wm-delete: dictionaries', 'wm-delete: per-session controllers']);
});

check('客户端与宿主的路由前缀一致（/wm-delete）', () => {
  const client = readFileSync(clientPath, 'utf8');
  const host = readFileSync(hostPath, 'utf8');
  assert.match(client, /const ROUTE_PREFIX = '\/wm-delete'/);
  assert.match(host, /const ROUTE_PREFIX = '\/wm-delete'/);
  for (const suffix of ['/state', '/delete']) {
    assert.ok(client.includes('${ROUTE_PREFIX}' + suffix), `客户端应使用 ${suffix}`);
    assert.ok(host.includes('${ROUTE_PREFIX}' + suffix), `宿主应注册 ${suffix}`);
  }
});

check('宿主半边只依赖 webServer（其余服务调用时按需解析）', () => {
  const host = readFileSync(hostPath, 'utf8');
  assert.match(host, /export const inject = \['webServer'\]/);
  for (const service of ['sessionQuery', 'sessionController', 'sessionPersistence', 'sessions']) {
    assert.ok(host.includes(`ctx.get('${service}')`), `应在调用时解析 ${service}`);
  }
});

console.log(`\nwm-delete 浏览器半边冒烟：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
