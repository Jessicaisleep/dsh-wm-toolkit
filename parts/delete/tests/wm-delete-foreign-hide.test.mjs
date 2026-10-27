/**
 * wm-delete-foreign-hide.test.mjs — 「不显示别人藏着的行」回归（迷你 DOM）。
 *
 * 起因：上游 dsh-delete-turn 0.1.6 的修复 —— 本插件的"恢复可见"分支原来无条件把
 * `row.style.display` 清成 `''`，于是**正被兄弟插件藏着的行会突然复活**。
 * 契约：交还自己那份归属属性与折叠样式之前，先确认没有别的归属属性；
 * 有则保持 `display:none`，等对方自己解除。
 *
 * 跑法：node parts/delete/tests/wm-delete-foreign-hide.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

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
    this.innerHTML = '';
    this.classList = new FakeClassList(this);
  }
  get className() {
    return this.attributes.class || '';
  }
  set className(value) {
    this.attributes.class = value;
  }
  /** `data-*` → dataset 的驼峰键（`data-dshwd-hidden` → `dshwdHidden`），与真实 DOM 一致。 */
  static datasetKey(name) {
    if (!name.startsWith('data-')) return null;
    const rest = name.slice('data-'.length);
    if (rest === '') return null;
    return rest.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    const key = FakeElement.datasetKey(name);
    if (key !== null) this.dataset[key] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    const key = FakeElement.datasetKey(name);
    if (key !== null) delete this.dataset[key];
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
      const classes = String(element.attributes.class || '').split(/\s+/);
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
  querySelector: (selector) =>
    selector.startsWith('style[') ? styleTags.find((tag) => matches(tag, selector)) || null : null,
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
globalThis.requestAnimationFrame = undefined;

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
  const injected = overlay.options.inject(SESSION_ID);
  return {
    render: (nodes, view) => {
      const snapshot = { nodes: new Map(Object.entries(nodes)) };
      overlay.component({
        useChat: () => snapshot,
        useDeletion: () => ({ ...injected.controller.getSnapshot(), ...(view || {}) }),
        controller: injected.controller,
        t: (key) => key,
      });
    },
  };
}

/** 一行用户消息（带操作条），可预置归属属性。 */
function userRow(key, presetAttrs = {}) {
  const row = el('div', { 'data-chat-flow-key': key, ...presetAttrs });
  const actions = el('div', {}, { display: 'flex', gap: '2px' });
  actions.appendChild(el('button', { 'data-dsh-message-recall': 'recall-key' }));
  const bubbleRoot = el('div', { 'data-dsh-message-recall': 'user' });
  bubbleRoot.appendChild(actions);
  row.appendChild(bubbleRoot);
  documentRoot.appendChild(row);
  return row;
}

// ---------------------------------------------------------------- 测试

const userNode = (seq) => ({ kind: 'user', anchorSeq: seq, data: { seq } });

/**
 * 让本插件先藏这一行（台账里含它的 seq），**在藏与恢复之间**可选地设置别人的归属属性，
 * 然后从台账里移走触发"恢复可见"分支。
 *
 * 关键：别人的属性必须在**本插件仍然持有 `dshwdHidden`** 的时候设上 —— 否则恢复分支
 * 根本不会执行（`if (row.dataset.dshwdHidden !== '1') return;` 提前返回），测不到点子上。
 *
 * @param attrs - 在"藏"之后、"恢复"之前补上的属性（模拟兄弟插件同时藏了这一行）。
 */
function hideThenUnhide(row, key, seq, attrs = {}) {
  const { render } = mount();
  render({ [key]: userNode(seq) }, { hidden: new Set([seq]), surface: new Set([seq]), surfaceReady: true });
  assert.equal(row.style.display, 'none', '本插件应先把行藏起来');
  for (const [name, value] of Object.entries(attrs)) row.setAttribute(name, value);
  render({ [key]: userNode(seq) }, { hidden: new Set(), surface: new Set([seq]), surfaceReady: true });
}

check('干净的行：取消隐藏后恢复显示', () => {
  documentRoot.children.length = 0;
  const row = userRow('k1');
  hideThenUnhide(row, 'k1', 3);
  assert.notEqual(row.style.display, 'none', '没有别人的归属时应恢复显示');
});

check('兄弟插件（dshet）藏着：本插件取消隐藏后仍保持 display:none', () => {
  documentRoot.children.length = 0;
  const row = userRow('k2');
  hideThenUnhide(row, 'k2', 4, { 'data-dshet-hidden': '1' });
  assert.equal(row.style.display, 'none', '别人的隐藏必须留着，不能复活');
});

check('兄弟插件（dsrr）藏着：同样保持 display:none', () => {
  documentRoot.children.length = 0;
  const row = userRow('k3');
  hideThenUnhide(row, 'k3', 5, { 'data-dsrr-hidden': '1' });
  assert.equal(row.style.display, 'none');
});

check('上游 dsh-delete-turn（dshdt）藏着：同样保持 display:none', () => {
  documentRoot.children.length = 0;
  const row = userRow('k4');
  hideThenUnhide(row, 'k4', 6, { 'data-dshdt-hidden': '1' });
  assert.equal(row.style.display, 'none');
});

check('兄弟插件解除之后：本插件下一次刷新会把行放出来（不是永久冻结）', () => {
  documentRoot.children.length = 0;
  const row = userRow('k5');
  hideThenUnhide(row, 'k5', 7, { 'data-dshet-hidden': '1' });
  assert.equal(row.style.display, 'none', '别人还藏着');
  // 兄弟插件自己解除 → 本插件下一次"藏→恢复"应把行放出来
  row.removeAttribute('data-dshet-hidden');
  hideThenUnhide(row, 'k5', 7);
  assert.notEqual(row.style.display, 'none', '别人解除后应恢复显示');
});

check('本插件自己的 dshwd 归属不算"别人"（不能自己把自己锁死）', () => {
  documentRoot.children.length = 0;
  const row = userRow('k6');
  hideThenUnhide(row, 'k6', 8, { 'data-dshwd-hidden': '1' });
  assert.notEqual(row.style.display, 'none', '本插件自己的归属必须被跳过，否则行永远出不来');
});

console.log(`\nwm-delete 隐藏归因：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
