/**
 * wm-delete-reentry.test.mjs — 防重入 + 停止预算的回归。
 *
 * 两件事：
 *   1. **防重入**：真机日志里出现过同一秒两条 `/wm-delete/delete`
 *      （2026-10-27 15:25:40 / 15:26:01 各两条），说明按钮的 `pending` 界面态
 *      来不及挡住第二下。确认框的 `confirm()` 必须在**第一个 await 之前**就上锁。
 *   2. **停止预算**：15 秒在本机实测不够（连续 5 次 stop-timeout），已提到 60 秒；
 *      超时文案必须给出可操作的下一步。
 *
 * 跑法：node parts/delete/tests/wm-delete-reentry.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 日志隔离 + 测试标记（这条测试会用假 fetch 打真实路由，必须不落到真实日志）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wm-delete-reentry-'));
process.env.WM_DELETE_TEST = '1';
const clientPath = join(here, '..', 'lib', 'client.js');
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

// ---------------------------------------------------------------- 迷你 DOM

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get set() {
    return new Set(String(this.element.attributes.class || '').split(/\s+/).filter(Boolean));
  }
  write(set) {
    this.element.attributes.class = [...set].join(' ');
  }
  add(...names) {
    const set = this.set;
    for (const name of names) set.add(name);
    this.write(set);
  }
  remove(...names) {
    const set = this.set;
    for (const name of names) set.delete(name);
    this.write(set);
  }
  contains(name) {
    return this.set.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = Object.create(null);
    this.style = {};
    this.innerHTML = '';
    this.classList = new FakeClassList(this);
    this.dataset = new Proxy(Object.create(null), {
      get: (t, p) => t[p],
      set: (t, p, v) => {
        t[p] = String(v);
        this.attributes['data-' + String(p).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(v);
        return true;
      },
      deleteProperty: (t, p) => {
        delete t[p];
        delete this.attributes['data-' + String(p).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())];
        return true;
      },
      has: (t, p) => p in t,
    });
  }
  get className() {
    return this.attributes.class || '';
  }
  set className(value) {
    this.attributes.class = value;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentElement = null;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  getBoundingClientRect() {
    return { height: 40 };
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

function matches(element, selector) {
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(selector);
  let rest = selector;
  if (tag) {
    if (element.tagName !== tag[1].toUpperCase()) return false;
    rest = selector.slice(tag[1].length);
  }
  const attrPattern = /^\[([a-zA-Z-]+)(?:([*^$]?=)"([^"]*)")?\]/;
  const classPattern = /^\.([a-zA-Z][a-zA-Z0-9_-]*)/;
  while (rest.length > 0) {
    const classFound = classPattern.exec(rest);
    if (classFound) {
      const classes = String(element.attributes.class || '').split(/\s+/).filter(Boolean);
      if (!classes.includes(classFound[1])) return false;
      rest = rest.slice(classFound[0].length);
      continue;
    }
    const found = attrPattern.exec(rest);
    if (!found) throw new Error(`迷你 DOM 不支持的选择器：${selector}`);
    const [, name, op, value] = found;
    const actual = element.attributes[name];
    if (actual === undefined) return false;
    if (op === '*=') {
      if (!String(actual).includes(value)) return false;
    } else if (op) {
      if (String(actual) !== value) return false;
    }
    rest = rest.slice(found[0].length);
  }
  return true;
}

function el(tagName, attrs = {}) {
  const element = new FakeElement(tagName);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

const documentRoot = el('body');
const styleTags = [];
globalThis.HTMLElement = FakeElement;
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.document = {
  body: documentRoot,
  head: el('head'),
  querySelector: (selector) =>
    selector.startsWith('style[') ? styleTags.find((tag) => matches(tag, selector)) || null : null,
  querySelectorAll: (selector) => documentRoot.querySelectorAll(selector),
  createElement: (tagName) => {
    const element = new FakeElement(tagName);
    if (tagName === 'style') styleTags.push(element);
    return element;
  },
};

// fetch 打桩：记录每次调用，并让它一直挂起（模拟"请求还没回来"）
const fetchCalls = [];
let releaseFetch = null;
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options });
  return new Promise((resolve) => {
    releaseFetch = () =>
      resolve({
        ok: true,
        json: async () => ({ ok: true, hidden: [], clearedTurns: [] }),
      });
  });
};

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__wmDeleteDefinition = definition; } },
  setTimeout: () => 0,
};

await import(pathToFileURL(clientPath).href);
const definition = globalThis.__wmDeleteDefinition;

const fakeReact = { useEffect: (fn) => { fn(); }, memo: (component) => component };
const fakeRequire = (specifier) => {
  if (specifier === 'react') return fakeReact;
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`unexpected require: ${specifier}`);
};

const SESSION_ID = 'session-8c5d8123-cce9-4c85-9532-6a00c36a92fa';

function mountController() {
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  definition.factory(fakeRequire).apply(ctx);
  const overlay = registrations.find((entry) => entry.options.name === 'conversation.input.overlay');
  return overlay.options.inject(SESSION_ID).controller;
}

// ---------------------------------------------------------------- 防重入

await check('getSnapshot 必须返回稳定引用（否则 React 无限重渲染 → 所有删除按钮消失）', async () => {
  const controller = mountController();
  const a = controller.getSnapshot();
  const b = controller.getSnapshot();
  // React 的 useSyncExternalStore 用 Object.is 比较；每次返回新对象会被判成"一直在变"，
  // 重渲染到抛错（"The result of getSnapshot should be cached"），整个槽渲染崩溃
  // —— 2026-10-28 真机踩到：重启后连**官方槽**的删除按钮都不见了。
  assert.equal(a, b, '两次 getSnapshot 必须返回同一个引用（不能每次 spread 新对象）');
  controller.publish({ pending: true });
  const c = controller.getSnapshot();
  assert.notEqual(c, a, '状态变化后应换成新引用');
  const d = controller.getSnapshot();
  assert.equal(c, d, '状态没变时必须保持同一个引用');
  controller.dispose();
});

await check('confirmInFlight 随 view 发布，而不是藏在派生字段里', async () => {
  const controller = mountController();
  controller.publish({ loaded: true, surfaceReady: true, dialog: { mode: 'reply', seq: 100, turn: 1 }, pending: false });
  const first = controller.confirm();
  assert.equal(controller.getSnapshot().confirmInFlight, true, '锁状态必须能从 view 读到');
  if (releaseFetch !== null) releaseFetch();
  await first;
  assert.equal(controller.getSnapshot().confirmInFlight, false, '结束后必须复位');
  controller.dispose();
});

await check('锁的作用：`pending` 已复位但请求仍在途时，第二次点击仍被挡（只有锁能挡这个场景）', async () => {
  fetchCalls.length = 0;
  const controller = mountController();
  controller.publish({ loaded: true, surfaceReady: true, dialog: { mode: 'reply', seq: 100, turn: 1 }, pending: false });
  const first = controller.confirm();
  // 关键场景：请求还在途，但界面态 pending 被别的 publish 复位了
  // （例如 /state 刷新、applyDom 引起的重渲染）。此时只有 confirmInFlight 能挡住第二次。
  controller.publish({ pending: false });
  assert.equal(controller.getSnapshot().pending, false, '前提：界面态 pending 已复位');
  assert.equal(controller.getSnapshot().confirmInFlight, true, '前提：锁仍在');
  const second = controller.confirm();
  const deleteCalls = fetchCalls.filter((call) => String(call.url).includes('/delete'));
  assert.equal(deleteCalls.length, 1, `pending 已复位时也必须只发 1 个请求，实际 ${deleteCalls.length}`);
  if (releaseFetch !== null) releaseFetch();
  await Promise.all([first, second]);
  controller.dispose();
});

await check('连点两次 confirm：只发出一个 /delete 请求', async () => {
  fetchCalls.length = 0;
  const controller = mountController();
  controller.publish({
    loaded: true,
    surfaceReady: true,
    dialog: { mode: 'reply', seq: 100, turn: 1 },
    pending: false,
  });
  const first = controller.confirm();
  const second = controller.confirm();
  const deleteCalls = fetchCalls.filter((call) => String(call.url).includes('/delete'));
  assert.equal(deleteCalls.length, 1, `应只发 1 个删除请求，实际 ${deleteCalls.length} 个`);
  if (releaseFetch !== null) releaseFetch();
  await Promise.all([first, second]);
  assert.equal(controller.getSnapshot().confirmInFlight, false, '请求结束后 confirmInFlight 必须复位');
  controller.dispose();
});

await check('请求完成后再点：能正常发出第二个请求（锁必须释放）', async () => {
  fetchCalls.length = 0;
  const controller = mountController();
  controller.publish({
    loaded: true,
    surfaceReady: true,
    dialog: { mode: 'reply', seq: 100, turn: 1 },
  });
  const first = controller.confirm();
  if (releaseFetch !== null) releaseFetch();
  await first;
  // 第二次：重新打开确认框再点
  controller.publish({ dialog: { mode: 'reply', seq: 100, turn: 1 }, pending: false });
  const second = controller.confirm();
  if (releaseFetch !== null) releaseFetch();
  await second;
  const deleteCalls = fetchCalls.filter((call) => String(call.url).includes('/delete'));
  assert.equal(deleteCalls.length, 2, `两次独立操作应各发 1 个请求，实际 ${deleteCalls.length} 个`);
  controller.dispose();
});

await check('请求失败后锁也释放（否则按钮永久失效）', async () => {
  fetchCalls.length = 0;
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  const controller = mountController();
  controller.publish({ loaded: true, surfaceReady: true, dialog: { mode: 'reply', seq: 100, turn: 1 } });
  await controller.confirm();
  assert.equal(controller.getSnapshot().pending, false, '失败后不应停在 pending');
  // 锁已释放：再点能再次发请求（这次打桩成成功）
  globalThis.fetch = (url, options) => {
    fetchCalls.push({ url, options });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, hidden: [], clearedTurns: [] }) });
  };
  controller.publish({ dialog: { mode: 'reply', seq: 100, turn: 1 }, pending: false });
  await controller.confirm();
  assert.ok(fetchCalls.some((call) => String(call.url).includes('/delete')), '失败后应能重试');
  controller.dispose();
});

// ---------------------------------------------------------------- 停止预算

await check('停止预算已提到 60 秒（15 秒在本机实测不够）', async () => {
  const host = await import(pathToFileURL(hostPath).href);
  const source = String(host.apply ?? '');
  // 常量在模块顶层，直接读源码文本更可靠
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(hostPath, 'utf8');
  assert.match(text, /const STOP_TIMEOUT_MS = 60000;/, 'STOP_TIMEOUT_MS 应为 60000');
  assert.match(text, /const STOP_POLL_MS = 250;/, 'STOP_POLL_MS 应为 250');
});

await check('超时错误文案给出可操作的下一步（不再是干巴巴的 did not stop in time）', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(clientPath, 'utf8');
  assert.match(client, /'error\.stop-timeout'/, '客户端必须有 stop-timeout 的文案键');
  const zh = /'error\.stop-timeout':\s*'([^']+)'/.exec(client);
  assert.ok(zh !== null, '应能找到中文文案');
  assert.match(zh[1], /再点一次|停止键|手动/, `文案应给出下一步：${zh[1]}`);
  const en = /'error\.stop-timeout':\s*'([^']+)'/.exec(client.slice(client.indexOf('const en =')));
  assert.ok(en !== null, '应能找到英文文案');
});

console.log(`\nwm-delete 防重入 + 停止预算：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
