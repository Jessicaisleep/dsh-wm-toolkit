/**
 * wm-delete-reapply.test.mjs — 「重新 apply 不叠幽灵按钮」回归（迷你 DOM，无浏览器）。
 *
 * 起因：上游 dsh-delete-turn 0.1.7 修过一个坑 —— 插件被重新 apply（HMR / 插件开关 /
 * bundle 组重载）时，每次都是新的模块实例、新的 WeakMap，而上一次 apply 注入的宿主还
 * 留在行里，于是同一条行上叠出多个删除按钮（真机 CDP 曾数到 3 个）。
 *
 * 本仓库的 injectRowAction 用 `rowActions` WeakMap 保证**同一实例内**每行一个宿主，
 * 但跨 apply 是否复用旧节点、dispose 时是否扫掉自己注入的节点，要靠这里量：
 *
 *   1. 首次 apply + 渲染 → 该行应有 1 个宿主节点；
 *   2. dispose → 应清掉自己注入的宿主（不能留孤儿）；
 *   3. 再 apply + 渲染 → 该行仍应恰好 1 个宿主（不是 2 个）。
 *
 * 跑法：node parts/delete/tests/wm-delete-reapply.test.mjs
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
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
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

/** 支持 tag、[attr]、[attr="v"]、[attr*="v"]、.class（本测试用到的那几种形状）。 */
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

/** 宿主标记属性（本次改造后每个宿主都带）。 */
const HOST_MARK = 'data-dshwd-action-host';
const HOST_SELECTOR = '[class*="dshwd-action-host"]';

/**
 * 挂一次插件，返回渲染入口与 dispose。
 * effect 的返回值（cleanup）被收集起来，调用时相当于 cordis 卸载插件。
 */
function mount() {
  const registrations = [];
  const cleanups = [];
  const ctx = {
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
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
  const dispose = () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    cleanups.length = 0;
  };
  return {
    render: (nodes) => {
      const snapshot = { nodes: new Map(Object.entries(nodes)) };
      overlay.component({
        useChat: () => snapshot,
        useDeletion: () => injected.controller.getSnapshot(),
        controller: injected.controller,
        t: (key) => key,
      });
    },
    dispose,
  };
}

/** 带操作条的用户消息行（与 recall 半边同形状，删除按钮会插进操作条）。 */
function userRow(key) {
  const row = el('div', { 'data-chat-flow-key': key });
  const bubbleRoot = el('div', { 'data-dsh-message-recall': 'user' });
  bubbleRoot.appendChild(el('div', {}, { display: 'block' }));
  const actions = el('div', {}, { display: 'flex', gap: '2px' });
  actions.appendChild(el('span', { class: 'dbe-time' }));
  actions.appendChild(el('button', { 'data-dsh-message-recall': 'recall-key' }));
  bubbleRoot.appendChild(actions);
  row.appendChild(bubbleRoot);
  documentRoot.appendChild(row);
  return { row, actions };
}

const userNode = (seq) => ({ kind: 'user', anchorSeq: seq, data: { seq } });

function hostsIn(scope) {
  return scope.querySelectorAll(HOST_SELECTOR);
}

// ---------------------------------------------------------------- 量测

let first = null;
let rowRef = null;

check('首次 apply：该行恰好 1 个宿主节点', () => {
  documentRoot.children.length = 0;
  first = mount();
  rowRef = userRow('k1');
  first.render({ k1: userNode(3) });
  assert.equal(hostsIn(rowRef.actions).length, 1, `首次注入后宿主数应为 1`);
});

check('dispose 之后：自己注入的宿主不再留在行里（不留孤儿）', () => {
  first.dispose();
  const left = hostsIn(rowRef.actions);
  assert.equal(left.length, 0, `卸载后行里残留 ${left.length} 个宿主`);
});

check('再 apply：该行仍恰好 1 个宿主（不是 2 个幽灵叠罗汉）', () => {
  const second = mount();
  second.render({ k1: userNode(3) });
  const hosts = hostsIn(rowRef.actions);
  assert.equal(hosts.length, 1, `重新 apply 后行里有 ${hosts.length} 个宿主（应恰好 1）`);
  // 操作条结构：时间 / 撤回 / 宿主 —— 不能变成 时间 / 撤回 / 宿主 / 宿主
  assert.equal(rowRef.actions.children.length, 3, `操作条子节点数应为 3，实际 ${rowRef.actions.children.length}`);
});

check('宿主带命名空间属性，便于下一次 apply 认领而不是重建', () => {
  const hosts = hostsIn(rowRef.actions);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].getAttribute(HOST_MARK), '1', '宿主应带 data-dshwd-action-host="1"');
});

console.log(`\nwm-delete 重新 apply 回归：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
