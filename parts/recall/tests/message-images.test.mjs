/**
 * message-images.test.mjs — rc.3 用户消息图片渲染回归 + 诊断日志体积上限。
 *
 * 起因（两件事，同一次修复）：
 *  1. DSH 0.2.1-rc.3 起宿主不再往 `conversation.chat.node` 注入 `renderMessageImages`
 *     （该串在整个 app.asar 里命中 0 次），官方改走槽 `conversation.chat.user.images`；
 *     那个槽是 single + shadows-shipped-ui，第三方注册会顶掉全 App 的官方图片组件，
 *     所以本插件只能改用 ownerProps 下发的 `loadImage` 自绘。修复前带图消息一张图都不显示。
 *  2. 那条「renderMessageImages prop 缺失」的警告写在「确实带图」判断之后，每次重渲染都落盘一行，
 *     把 dsh-message-recall-wm.log 顶到 11.1 MB / 63,102 行（其中 59,789 行是同一条警告）。
 *
 * 跑法：node parts/recall/tests/message-images.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply as applyHost } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

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

// ============================================================ 假 DOM / React / 宿主

function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentElement: null,
    attributes: {}, style: {}, dataset: {}, textContent: '', innerHTML: '', className: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    removeAttribute(k) { delete el.attributes[k]; },
    appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    remove() {}, focus() {}, blur() {}, select() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    getBoundingClientRect() { return { width: 320, height: 40, top: 0, left: 0, right: 320, bottom: 40 }; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    get firstChild() { return el.children[0] || null; },
  };
  return el;
}
globalThis.document = {
  documentElement: fakeEl('html'),
  head: fakeEl('head'),
  body: fakeEl('body'),
  createElement: fakeEl,
  createTextNode: (t) => ({ textContent: t }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  activeElement: null,
  execCommand() { return true; },
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
Object.defineProperty(globalThis, 'location', { value: { search: '', href: 'http://127.0.0.1:0/' }, configurable: true, writable: true });
globalThis.HTMLElement = class HTMLElement {};
const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => memStore.set(k, String(v)),
  removeItem: (k) => memStore.delete(k),
};

/** 捕获 client 半边经 /bubble/log 上报的日志（去重断言要用）。 */
const reportedLogs = [];
globalThis.fetch = (url, init) => {
  try {
    const u = String(url);
    if (u.endsWith('/bubble/log')) reportedLogs.push(JSON.parse((init && init.body) || '{}'));
  } catch (e) { /* ignore */ }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), blob: () => Promise.resolve({}), text: () => Promise.resolve('') });
};

const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
/** 假 React：hooks 全为「首值 + 空操作」，useEffect 不执行（渲染结果只取决于初值）。 */
const reactMod = {
  createElement: jsx,
  Fragment: 'Fragment', StrictMode: 'StrictMode', Suspense: 'Suspense',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useReducer: (r, init) => [init, () => {}],
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useEffect: () => {}, useLayoutEffect: () => {}, useInsertionEffect: () => {},
  useMemo: (fn) => fn(), useCallback: (fn) => fn, useId: () => 'id',
  useSyncExternalStore: (sub, getSnapshot) => getSnapshot(),
  Children: { map: (c) => c, toArray: (c) => c, only: (c) => c },
  cloneElement: (el) => el, isValidElement: () => true,
  Component: class C { constructor(p) { this.props = p || {}; } setState() {} render() { return null; } },
  PureComponent: class P { constructor(p) { this.props = p || {}; } setState() {} render() { return null; } },
};
const iconStub = function IconStub() { return jsx('svg', {}); };
const primitives = new Proxy({ ImageLightbox: function ImageLightbox() { return jsx('div', {}); } }, {
  get(target, key) {
    if (key in target) return target[key];
    return typeof key === 'string' ? iconStub : undefined;
  },
  has() { return true; },
});
function fakeRequire(name) {
  if (name === 'react') return reactMod;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
  if (name === 'react-dom') return { createPortal: (el) => el };
  if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + name);
}

/** 宽容 stub：假 ctx 上没有的成员一律返回「可调用、可继续取属性」的替身。 */
function permissive(path) {
  const fn = function () { return permissive(path + '()'); };
  return new Proxy(fn, {
    get(t, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive || key === 'toString') return () => '[stub ' + path + ']';
      if (key in t) return t[key];
      return permissive(path + '.' + String(key));
    },
    apply() { return permissive(path + '()'); },
    has() { return true; },
  });
}

/** 反复展开函数组件（深度有限），把 React 元素树变成可断言的普通对象树。 */
function expand(node, depth = 0, seenProps = []) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, depth, seenProps));
  if (depth > 8) return node;
  if (typeof node.type === 'function') {
    seenProps.push(node.props);
    return expand(node.type(node.props), depth + 1, seenProps);
  }
  return {
    type: node.type,
    props: node.props,
    children: (node.children || []).map((c) => expand(c, depth + 1, seenProps)),
  };
}
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, predicate, out)); return out; }
  if (predicate(node)) out.push(node);
  (node.children || []).forEach((c) => findAll(c, predicate, out));
  return out;
}

// ---- 挂上 recall 客户端半边，取回 conversation.chat.node(key=user) 组件 ----
const registrations = [];
const slots = {
  inject(name, cb) { try { cb(); } catch (e) { /* ignore */ } return () => {}; },
  register(options, component) { registrations.push({ options, component }); return () => {}; },
  registerFactory(options, component) { registrations.push({ options, component, factory: true }); return () => {}; },
  entriesOfSlot() { return []; },
};
const clientCtx = new Proxy({
  slots,
  effect: (fn) => { try { fn(); } catch (e) { /* ignore */ } return () => {}; },
  on: () => () => {},
  get: () => undefined,
  locale: { register: () => {}, bind: () => (k) => k },
  settings: { define: () => {}, get: () => undefined, set: () => {}, watch: () => () => {} },
  sessions: { open() {}, scope: () => permissive('scope'), list: { getSnapshot: () => ({ current: null, byId: {} }) } },
  workspaces: { archiveSession: () => Promise.resolve(true), refresh() {} },
}, {
  get(t, key) {
    if (key in t) return t[key];
    return typeof key === 'string' ? permissive('ctx.' + key) : undefined;
  },
  has() { return true; },
});

let face = null;
globalThis.__ModuleLoader__ = { load(def) { face = def.factory(fakeRequire); } };
await import(pathToFileURL(clientPath).href + '?v=' + Date.now());
face.apply(clientCtx);

const userNodeReg = registrations.find((r) => r.options && r.options.name === 'conversation.chat.node' && r.options.key === 'user');
const renderUserBubble = (content, extraProps) => userNodeReg.component({
  node: { key: 'user', data: { content } },
  sessionId: 'session-11111111-2222-3333-4444-555555555555',
  ...extraProps,
});
const IMAGE_BLOCK = (id) => ({ type: 'image', attachment: { attachmentId: id, name: id + '.png', mediaType: 'image/png' } });
/** 取用户气泡里「图片区」那个子元素（rowStyle 容器的第一个孩子）。 */
const imageSlotOf = (node) => (node && node.children ? node.children[0] : null);

console.log('\n=== recall · 消息图片渲染（rc.3 适配） ===');

await check('前置：conversation.chat.node(key=user) 已注册', () => {
  assert.ok(userNodeReg, '未注册 chat.node 的 user 席');
});

await check('rc.3 路径：宿主只下发 loadImage 时，图片区交给自绘组件且带上同一个加载器', () => {
  const loadImage = (att) => Promise.resolve('blob:' + att.attachmentId);
  const tree = renderUserBubble([IMAGE_BLOCK('a1'), IMAGE_BLOCK('a2')], { loadImage });
  const slot = imageSlotOf(tree);
  assert.ok(slot, '图片区不该为空（rc.3 下正是这里渲染不出来）');
  assert.equal(typeof slot.type, 'function', '图片区应是自绘组件元素');
  assert.equal(slot.props.loadImage, loadImage, '应原样传递宿主的 loadImage');
  assert.equal(slot.props.align, 'end', '用户消息图片右对齐');
  assert.equal(slot.props.images.length, 2, '两张图应都交给图片区');
});

await check('rc.3 路径：展开后出现自绘宫格，瓦片数与图片数一致', () => {
  const tree = renderUserBubble([IMAGE_BLOCK('a1'), IMAGE_BLOCK('a2'), IMAGE_BLOCK('a3')], { loadImage: () => Promise.resolve(null) });
  const expanded = expand(imageSlotOf(tree));
  const gallery = findAll(expanded, (n) => n.props && n.props['data-dsh-wm-message-images'] === 'fallback');
  assert.equal(gallery.length, 1, '应有一个自绘宫格容器');
  const row = gallery[0].children[0];
  assert.equal(row.children.length, 3, '瓦片数应等于图片数');
});

await check('首帧直出：本地回显 preview.url 不必等异步加载器', () => {
  const content = [{ type: 'image', attachment: { attachmentId: 'a1', name: 'p.png' }, preview: { url: 'blob:preview-1' } }];
  const expanded = expand(imageSlotOf(renderUserBubble(content, { loadImage: () => Promise.resolve(null) })));
  const imgs = findAll(expanded, (n) => n.type === 'img');
  assert.equal(imgs.length, 1, '应渲染出一张 <img>');
  assert.equal(imgs[0].props.src, 'blob:preview-1', 'src 应取 preview.url');
  assert.equal(imgs[0].props.alt, 'p.png', 'alt 用附件名');
});

await check('首帧直出：加载器缓存命中（loadImage.peek）时也不闪一帧「加载中」', () => {
  const loader = (att) => Promise.resolve('blob:async-' + att.attachmentId);
  loader.peek = (att) => (att.attachmentId === 'a1' ? 'blob:cached-a1' : null);
  const expanded = expand(imageSlotOf(renderUserBubble([IMAGE_BLOCK('a1')], { loadImage: loader })));
  const imgs = findAll(expanded, (n) => n.type === 'img');
  assert.equal(imgs.length, 1, '应渲染出一张 <img>');
  assert.equal(imgs[0].props.src, 'blob:cached-a1', 'src 应取 peek 缓存');
});

await check('地址还没到手时渲染「加载中」占位，而不是留空白', () => {
  const expanded = expand(imageSlotOf(renderUserBubble([IMAGE_BLOCK('a1')], { loadImage: () => Promise.resolve(null) })));
  const busy = findAll(expanded, (n) => n.props && n.props['aria-busy'] === 'true');
  assert.equal(busy.length, 1, '应有且只有一个占位');
  assert.equal(findAll(expanded, (n) => n.type === 'img').length, 0, '拿不到地址时不该有 <img>');
});

await check('旧宿主优先：仍注入 renderMessageImages 时直调官方实现，不再走自绘', () => {
  const calls = [];
  const official = (args) => { calls.push(args); return { type: 'div', props: { 'data-official-images': '' }, children: [] }; };
  const tree = renderUserBubble([IMAGE_BLOCK('a1')], { renderMessageImages: official });
  assert.equal(calls.length, 1, '官方 prop 应被调用一次');
  assert.deepEqual(calls[0], { images: [{ attachment: { attachmentId: 'a1', name: 'a1.png', mediaType: 'image/png' } }], align: 'end' });
  const slot = imageSlotOf(tree);
  assert.equal(slot.props['data-official-images'], '', '应直接采用官方返回值');
  assert.equal(findAll(tree, (n) => n.props && n.props['data-dsh-wm-message-images']).length, 0, '不该再出现自绘标记');
});

await check('两者都没有：不抛错、图片区为空，且警告只上报一次（去重）', () => {
  const before = reportedLogs.length;
  const t1 = renderUserBubble([IMAGE_BLOCK('a1')], {});
  const t2 = renderUserBubble([IMAGE_BLOCK('a1')], {});
  assert.equal(imageSlotOf(t1), null, '没有加载器时图片区应为空');
  assert.equal(imageSlotOf(t2), null, '第二次渲染同样为空');
  const added = reportedLogs.slice(before);
  const warned = added.filter((e) => String(e.message || '').includes('图片无法渲染'));
  assert.equal(warned.length, 1, `同一条警告应只上报一次，实际 ${warned.length} 次`);
  assert.equal(warned[0].tag, 'attach');
  assert.equal(warned[0].level, 'warn');
});

// ============================================================ 宿主半边：日志体积上限

console.log('\n=== recall · 诊断日志体积上限 ===');

await check('日志超上限即轮转为 .1：旧内容不丢、现役文件只装新行、只留一代', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wm-logcap-'));
  const file = join(home, 'dsh-message-recall-wm.log');
  try {
    process.env.DSH_HOME = home;
    // 预置一个刚好越线的旧日志（4 MiB + 1 B），模拟被顶爆的现场
    const seedSize = 4 * 1024 * 1024 + 1;
    writeFileSync(file, 'old\n'.repeat(Math.ceil(seedSize / 4)).slice(0, seedSize), 'utf8');
    assert.equal(statSync(file).size, seedSize, '预置文件大小应为上限 + 1 B');

    const routes = new Map();
    applyHost({
      settings: { register: () => {} },
      storageDomain: { open: () => Promise.resolve({ table: () => ({}) }) },
      webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
      sessions: {},
      get: () => undefined,
    });
    const route = routes.get('/bubble/log');
    assert.ok(route, '/bubble/log 路由应已注册');

    const post = async (message) => {
      const listeners = {};
      const req = {
        method: 'POST',
        url: '/bubble/log',
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
        (listeners.data || []).forEach((cb) => cb(Buffer.from(JSON.stringify({ level: 'warn', tag: 'attach', message }))));
        (listeners.end || []).forEach((cb) => cb());
      });
      await Promise.all([done, Promise.resolve(fired)]);
      assert.equal(res.statusCode, 200, '上报应成功');
    };
    await post('轮转后的第一条');
    await post('轮转后的第二条');

    const rotated = file + '.1';
    assert.ok(existsSync(rotated), '应生成 .1（旧日志被轮转出去，而不是继续膨胀）');
    assert.equal(statSync(rotated).size, seedSize, '.1 应逐字节保留轮转前的全部旧内容');

    const live = readFileSync(file, 'utf8');
    assert.ok(live.includes('轮转后的第一条'), '现役日志应包含新行');
    assert.ok(live.includes('轮转后的第二条'), '现役日志应包含新行');
    assert.ok(!live.includes('old\nold\n'), '现役日志不该再夹带旧内容');
    assert.ok(statSync(file).size < 64 * 1024, `现役日志应远小于上限，实际 ${statSync(file).size} B`);
    assert.ok(!existsSync(file + '.2'), '只保留一代轮转');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

console.log(`\n消息图片 + 日志上限：${passed}/${passed + failed} 通过`);
if (failed > 0) {
  console.error(`失败项：${failures.join('、')}`);
  process.exit(1);
}
