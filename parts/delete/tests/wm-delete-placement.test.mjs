/**
 * wm-delete-placement.test.mjs — 删除按钮"插在哪"的回归测试（用迷你 DOM，不需要浏览器）。
 *
 * 起因：用户消息这一格被本仓库 recall 半边**顶替**了，它自绘的操作条是纯内联样式
 * （`display:flex;gap:2px`），**没有任何类名**，所以 `[class*="_actions"]` 选择器匹配不到。
 * 结果是删除按钮回落到"浮在行上"的绝对定位按钮，压住了「撤回 / 复制」，很难点到。
 *
 * 这里构造和 recall 半边真实 markup 一致的 DOM 树，走**真实的 applyDom → injectRowAction**
 * 代码路径，断言删除按钮落在操作条里、且是最后一个（撤回 → 复制 → 删除）。
 *
 * 跑法：node parts/delete/tests/wm-delete-placement.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

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
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.classList = new FakeClassList(this);
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
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
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

/** 支持 tag、[attr]、[attr="v"]、[attr*="v"]（本测试用到的那几种形状）。 */
function matches(element, selector) {
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(selector);
  let rest = selector;
  if (tag) {
    if (element.tagName !== tag[1].toUpperCase()) return false;
    rest = selector.slice(tag[1].length);
  }
  const attrPattern = /^\[([a-zA-Z-]+)(?:([*^$]?=)"([^"]*)")?\]/;
  while (rest.length > 0) {
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

function el(tagName, attrs = {}, style = {}) {
  const element = new FakeElement(tagName);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  Object.assign(element.style, style);
  return element;
}

// ---------------------------------------------------------------- 环境

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
  querySelector: (selector) => (selector.startsWith('style[') ? styleTags.find((tag) => matches(tag, selector)) || null : null),
  querySelectorAll: (selector) => documentRoot.querySelectorAll(selector),
  createElement: (tagName) => {
    const element = new FakeElement(tagName);
    if (tagName === 'style') styleTags.push(element);
    return element;
  },
};
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__wmDeleteDefinition = definition; } },
  setTimeout: () => 0,
};

// ---------------------------------------------------------------- 载入 bundle

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

/** 挂上插件，取回 OverlayEntry 组件与真实 controller。 */
function mount() {
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
  assert.ok(overlay, '应注册 conversation.input.overlay');
  const injected = overlay.options.inject(SESSION_ID);
  return { component: overlay.component, controller: injected.controller };
}

/** 用真实 applyDom 跑一次渲染。 */
function render(component, controller, nodes) {
  const snapshot = { nodes: new Map(Object.entries(nodes)) };
  component({
    useChat: () => snapshot,
    useDeletion: () => controller.getSnapshot(),
    controller,
    t: (key) => key,
  });
}

// ---------------------------------------------------------------- 造行

/**
 * 复刻 recall 半边 UserBubbleView 的真实 markup：
 *   row[data-chat-flow-key]
 *     └ div[data-dsh-message-recall="user"][data-time-hover-root]
 *         ├ div   (气泡正文)
 *         └ div   (操作条，inline flex，无类名)
 *             ├ span.dbe-time
 *             ├ button[data-dsh-message-recall="recall-key"]   撤回
 *             └ button                                          复制
 */
function recallUserRow(key, seq) {
  const row = el('div', { 'data-chat-flow-key': key });
  const bubbleRoot = el('div', { 'data-dsh-message-recall': 'user', 'data-time-hover-root': 'true' });
  bubbleRoot.appendChild(el('div', {}, { display: 'block' }));
  const actions = el('div', {}, { display: 'flex', gap: '2px', alignItems: 'center' });
  const time = el('span', { class: 'dbe-time' });
  actions.appendChild(time);
  actions.appendChild(el('button', { 'data-dsh-message-recall': 'recall-key' }));
  actions.appendChild(el('button'));
  bubbleRoot.appendChild(actions);
  row.appendChild(bubbleRoot);
  documentRoot.appendChild(row);
  return { row, bubbleRoot, actions, time };
}

/** 官方气泡 markup：操作条有 `_actions` 类名。 */
function officialUserRow(key, seq) {
  const row = el('div', { 'data-chat-flow-key': key });
  const actions = el('div', { class: 'ChatBubble_actions_1a2b3' });
  actions.appendChild(el('button'));
  actions.appendChild(el('button'));
  row.appendChild(actions);
  documentRoot.appendChild(row);
  return { row, actions };
}

/** 没有任何操作条的行（注入上下文 / 工具卡那种）。 */
function bareRow(key, seq) {
  const row = el('div', { 'data-chat-flow-key': key });
  row.appendChild(el('div', {}, { display: 'block' }));
  documentRoot.appendChild(row);
  return { row };
}

const userNode = (seq) => ({ kind: 'user', anchorSeq: seq, data: { seq } });

// ---------------------------------------------------------------- 测试

check('用户消息：删除按钮插进「撤回 / 复制」那一排，且排在最后', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions, row } = recallUserRow('k1', 3);
  render(component, controller, { k1: userNode(3) });

  // 操作条原本是 [时间, 撤回, 复制]，删除按钮的 span 宿主排在第 4 位（= 最后）
  assert.equal(actions.children.length, 4, '应为 时间 / 撤回 / 复制 / 删除');
  assert.equal(actions.children[1].getAttribute('data-dsh-message-recall'), 'recall-key', '撤回仍在原位');
  assert.equal(actions.children[2].tagName, 'BUTTON', '复制仍在原位');
  const deleteHost = actions.children[actions.children.length - 1];
  assert.equal(deleteHost.tagName, 'SPAN');
  assert.ok(deleteHost.classList.contains('dshwd-inline'), '应带 dshwd-inline（行内样式）');
  assert.ok(!deleteHost.classList.contains('dshwd-floating'), '不应再是浮层按钮');
  const button = deleteHost.children[0];
  assert.equal(button.tagName, 'BUTTON');
  assert.ok(button.classList.contains('dshwd-action'));
  assert.equal(button.getAttribute('aria-label'), 'action.tooltip.message');
  assert.equal(row.classList.contains('dshwd-row'), false, '行内模式不应给行加 relative 类');
});

check('用户消息：删除按钮不在行上浮动（修掉"被挡住点不到"）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { row, actions } = recallUserRow('k2', 4);
  render(component, controller, { k2: userNode(4) });
  const floating = row.children.filter((child) => child.classList && child.classList.contains('dshwd-floating'));
  assert.equal(floating.length, 0, '行上不应再有浮层按钮');
  assert.equal(actions.querySelectorAll('[class*="dshwd-floating"]').length, 0);
});

check('用户消息：点击删除按钮不会冒泡到气泡（不误触"编辑"）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = recallUserRow('k3', 5);
  render(component, controller, { k3: userNode(5) });
  const button = actions.children[actions.children.length - 1].children[0];
  let stopped = false;
  button.onclick({ preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, '必须 stopPropagation');
  assert.equal(controller.getSnapshot().dialog !== null, true, '应打开确认弹窗');
});

check('官方气泡（有 _actions 类名）：同样插进操作条', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = officialUserRow('k4', 6);
  render(component, controller, { k4: userNode(6) });
  assert.equal(actions.children.length, 3, '官方两个按钮 + 删除');
  assert.ok(actions.children[2].classList.contains('dshwd-inline'));
});

check('没有操作条的行：才回落到浮层按钮', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { row } = bareRow('k5', 7);
  render(component, controller, { k5: { kind: 'context', anchorSeq: 7, data: { seq: 7 } } });
  const floating = row.children.filter((child) => child.classList && child.classList.contains('dshwd-floating'));
  assert.equal(floating.length, 1, '找不到操作条时应浮在行上');
  assert.ok(floating[0].classList.contains('dshwd-action-host'));
});

check('编辑态（操作条里只有撤回键）也能命中，不会插到取消/确认行', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  // 编辑态：气泡根节点下有 编辑器（含取消/确认 flex 行） + 操作条（只有撤回键）
  const row = el('div', { 'data-chat-flow-key': 'k6' });
  const bubbleRoot = el('div', { 'data-dsh-message-recall': 'user', 'data-time-hover-root': 'true' });
  const editor = el('div', {}, { display: 'block' });
  const editorButtons = el('div', {}, { display: 'flex', gap: '8px' });
  editorButtons.appendChild(el('button')); // 取消
  editorButtons.appendChild(el('button')); // 确认
  editor.appendChild(editorButtons);
  bubbleRoot.appendChild(editor);
  const actions = el('div', {}, { display: 'flex', gap: '2px', alignItems: 'center' });
  actions.appendChild(el('button', { 'data-dsh-message-recall': 'recall-key' }));
  bubbleRoot.appendChild(actions);
  row.appendChild(bubbleRoot);
  documentRoot.appendChild(row);

  render(component, controller, { k6: userNode(8) });
  assert.equal(editorButtons.children.length, 2, '取消/确认行不应被插入删除按钮');
  assert.equal(actions.children.length, 2, '操作条应变成 撤回 + 删除');
  assert.ok(actions.children[1].classList.contains('dshwd-inline'));
});

check('重复渲染不会重复插入按钮', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = recallUserRow('k7', 9);
  render(component, controller, { k7: userNode(9) });
  render(component, controller, { k7: userNode(9) });
  render(component, controller, { k7: userNode(9) });
  assert.equal(actions.children.length, 4, '仍然只有 时间/撤回/复制/删除');
});

check('按钮不再提供时（已被删掉）浮层/行内按钮都会被清掉', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = recallUserRow('k8', 10);
  render(component, controller, { k8: userNode(10) });
  assert.equal(actions.children.length, 4);
  // 目标离开 surface → rowDeletable 为 false
  controller.publish({ surfaceReady: true, surface: new Set([99]) });
  render(component, controller, { k8: userNode(10) });
  assert.equal(actions.children.length, 3, '删除按钮应被移除');
});

check('没有会话 id 时（新会话输入框）不发请求、不崩', () => {
  documentRoot.children.length = 0;
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
  const injected = overlay.options.inject(undefined); // ← 新会话阶段宿主就是这么传的
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  injected.controller.load();
  assert.equal(fetchCalls, 0, 'sessionId 不可用时一个请求都不该发');
  const { row, actions } = recallUserRow('k9', 11);
  overlay.component({
    useChat: () => ({ nodes: new Map([['k9', userNode(11)]]) }),
    useDeletion: () => injected.controller.getSnapshot(),
    controller: injected.controller,
    t: (key) => key,
  });
  assert.ok(actions.children.length >= 2, '界面照常渲染');
  void row;
});

// ---------------------------------------------------------------- 新内容乐观放行
//
// 回归：surface / replyTurns 只在会话打开时抓一次，于是"刚发出的消息、刚完成的回复"
// 的 seq 不在旧 surface 里 → 被判成不可删 → 按钮不出现，必须重启 DSH 才有。
// 现在对"seq 超过上次抓取末尾"的新内容乐观放行，并防抖刷新 surface 做精确校正。

// 这批测试手动 publish view；load() 不能覆盖它 → 给一个永不 resolve 的 fetch
// （load 的 .finally 不会跑，也就不会 publish）。
globalThis.fetch = () => new Promise(() => {});

check('新内容（seq 超过上次 surface 抓取末尾）→ 删除按钮照样出现，不必重启', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = recallUserRow('n1', 30);
  controller.publish({ surfaceReady: true, surface: new Set([10, 12]), lastSeq: 20 });
  render(component, controller, { n1: userNode(30) });
  assert.equal(actions.children.length, 4, '新消息也应有删除按钮');
  assert.ok(actions.children[3].classList.contains('dshwd-inline'));
  controller.dispose();
});

check('新内容不会被标记 data-dshwd-no-target（那会把官方槽的删除按钮一起藏掉）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { row } = recallUserRow('n2', 31);
  controller.publish({ surfaceReady: true, surface: new Set([10]), lastSeq: 20 });
  render(component, controller, { n2: userNode(31) });
  assert.equal(row.dataset.dshwdNoTarget, undefined, '新内容绝不能设 no-target');
  controller.dispose();
});

check('新回合的 turn-tail 行同样乐观放行（不设 no-target）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const row = el('div', { 'data-chat-flow-key': 'n6' });
  row.appendChild(el('div', {}, { display: 'block' }));
  documentRoot.appendChild(row);
  controller.publish({ surfaceReady: true, replyTurns: new Set([1]), surface: new Set([10]), lastSeq: 20 });
  // closing.finalNode.messageId 存在 → targetFor 返回 null（交给官方槽），
  // 但 rowDeletable 必须放行，否则 no-target 会把官方槽按钮藏掉。
  render(component, controller, {
    n6: { kind: 'turn-tail', anchorSeq: 30, data: { turn: 9, closing: { finalNode: { seq: 30, messageId: 'msg-new' } } } },
  });
  assert.equal(row.dataset.dshwdNoTarget, undefined, '新回合不该被标记为无入口');
  controller.dispose();
});

check('老内容仍按 surface 精确判断（该藏的还是藏）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions, row } = recallUserRow('n3', 11);
  controller.publish({ surfaceReady: true, surface: new Set([10]), lastSeq: 20 });
  render(component, controller, { n3: userNode(11) });
  assert.equal(actions.children.length, 3, '不在 surface 里的老内容不显示删除按钮');
  assert.equal(row.dataset.dshwdNoTarget, '1');
  controller.dispose();
});

check('看到新内容会安排一次防抖刷新（不是立即发请求）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  recallUserRow('n4', 32);
  controller.publish({ surfaceReady: true, surface: new Set([10]), lastSeq: 20 });
  controller.dispose(); // 清掉可能存在的旧 timer
  assert.equal(controller.refreshTimer, null);
  render(component, controller, { n4: userNode(32) });
  assert.notEqual(controller.refreshTimer, null, '应已调度刷新');
  controller.dispose();
  assert.equal(controller.refreshTimer, null, 'dispose 应清掉 timer');
});

check('没有新内容时不调度刷新（稳态零额外请求）', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  recallUserRow('n5', 12);
  controller.publish({ surfaceReady: true, surface: new Set([10, 12]), lastSeq: 20 });
  controller.dispose();
  render(component, controller, { n5: userNode(12) });
  assert.equal(controller.refreshTimer, null, '稳态下不该有刷新');
});

check('lastSeq 为 -1（还没抓过 surface）时不误判为新内容', () => {
  documentRoot.children.length = 0;
  const { component, controller } = mount();
  const { actions } = recallUserRow('n7', 50);
  // surfaceReady=true 但 lastSeq 未知 → 不应走乐观放行；靠 surface 精确判断
  controller.publish({ surfaceReady: true, surface: new Set([10]), lastSeq: -1 });
  render(component, controller, { n7: userNode(50) });
  assert.equal(actions.children.length, 3, 'lastSeq 未知时不乐观放行');
  controller.dispose();
});

// load() 会从 /state 读入 lastSeq（否则乐观放行永远不触发）。这条是 async，单独跑。
try {
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, hidden: [], surface: [10, 12, 30], replyTurns: [1], lastSeq: 30 }),
  });
  const { controller } = mount();
  controller.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const view = controller.getSnapshot();
  assert.equal(view.lastSeq, 30, 'lastSeq 应来自 /state');
  assert.equal(view.surfaceReady, true);
  assert.equal(view.surface.has(30), true);
  passed += 1;
  console.log('  ✓ load() 从 /state 读入 lastSeq（乐观放行的前提）');
} catch (error) {
  failed += 1;
  failures.push('load() lastSeq');
  console.error(`  ✗ load() 从 /state 读入 lastSeq\n    ${String(error && error.message ? error.message : error)}`);
}

console.log(`\nwm-delete 按钮位置回归：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
