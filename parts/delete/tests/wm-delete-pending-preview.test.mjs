/**
 * wm-delete-pending-preview.test.mjs — 确认框出现时给"将被删除的段落"加删除线的回归。
 *
 * 需求：点删除 → 弹确认框 → **先看到哪几行会被划掉**；确认无误再落刀，取消则标记消失。
 * 硬约束：绝不能锁 DSH 窗口的滚动（Modal 自己会锁一层，插件再锁一层长段落就没法核对）。
 *
 * 这里锁四件事：
 *   1. 确认框打开后，落在删除窗口里的行带 `data-dshwd-pending="1"`；
 *   2. 不在窗口里的行不带；
 *   3. 取消（dialog=null）后所有标记消失；
 *   4. 插件**不**改 overflow / pointer-events / body 的滚动锁。
 *
 * 跑法：node parts/delete/tests/wm-delete-pending-preview.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

// 日志隔离 + 测试标记：这些用例会 apply() 插件面，任何写日志的路径都不该落到真实的
// `$DSH_HOME\dsh-wm-delete.log`（详见 wm-delete-stop-first.test.mjs 的说明）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wm-delete-preview-'));
process.env.WM_DELETE_TEST = '1';

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
    this.innerHTML = '';
    this.classList = new FakeClassList(this);
    // dataset 必须是**双向同步**的：真实 DOM 里 `el.dataset.fooBar = '1'` 会同时出现在
    // `getAttribute('data-foo-bar')` 上，反之亦然。用 Proxy 让假 DOM 也这样，
    // 否则"代码用 dataset 写、测试用 hasAttribute 读"就会永远读不到（曾误判成实现有 bug）。
    this.dataset = new Proxy(Object.create(null), {
      get: (target, prop) => target[prop],
      set: (target, prop, value) => {
        target[prop] = String(value);
        const attr = 'data-' + String(prop).replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
        this.attributes[attr] = String(value);
        return true;
      },
      deleteProperty: (target, prop) => {
        delete target[prop];
        const attr = 'data-' + String(prop).replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
        delete this.attributes[attr];
        return true;
      },
      has: (target, prop) => prop in target,
    });
  }
  get className() {
    return this.attributes.class || '';
  }
  set className(value) {
    this.attributes.class = value;
  }
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
  const render = (nodes, viewPatch) => {
    const snapshot = { nodes: new Map(Object.entries(nodes)) };
    overlay.component({
      useChat: () => snapshot,
      useDeletion: () => ({ ...injected.controller.getSnapshot(), ...(viewPatch || {}) }),
      controller: injected.controller,
      t: (key) => key,
    });
  };
  return { render, controller: injected.controller };
}

/** 一行助手回复（带 flow key）。 */
function assistantRow(key) {
  const row = el('div', { 'data-chat-flow-key': key });
  row.appendChild(el('div'));
  documentRoot.appendChild(row);
  return row;
}

const assistantNode = (seq) => ({ kind: 'assistant-step', anchorSeq: seq, data: { turn: 1, step: 1, finalNode: { seq } } });

// ---------------------------------------------------------------- 测试

/** 一个单段回合：窗口 [100..102]。 */
const SEGMENTS = [{ turn: 1, startSeq: 100, endSeq: 102, shadowed: [100, 101, 102] }];

check('确认框关闭时：没有任何行带 pending 标记', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('a');
  render({ a: assistantNode(100) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    dialog: null,
  });
  assert.ok(!row.hasAttribute('data-dshwd-pending'), '没打开确认框时不该有标记');
});

check('确认框打开（删这一段）：落在窗口里的添加删除线标记', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('b');
  render({ b: assistantNode(101) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    // 官方槽点的是 messageId，客户端拿到的是 seq；这里模拟"点 seq 101"
    dialog: { mode: 'reply', seq: 101, turn: 1 },
  });
  assert.equal(row.getAttribute('data-dshwd-pending'), '1', '窗口内的行必须被划掉');
});

check('确认框打开：窗口外的行不加标记（不能把整页都划掉）', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const inside = assistantRow('c1');
  const outside = assistantRow('c2');
  render({ c1: assistantNode(101), c2: assistantNode(999) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102, 999]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    dialog: { mode: 'reply', seq: 101, turn: 1 },
  });
  assert.equal(inside.getAttribute('data-dshwd-pending'), '1');
  assert.ok(!outside.hasAttribute('data-dshwd-pending'), '窗口外的行不该被划掉');
});

check('勾了「整轮」时：该回合所有段都被划掉', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const seg1Row = assistantRow('d1');
  const seg2Row = assistantRow('d2');
  render({ d1: assistantNode(100), d2: assistantNode(200) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102, 200, 201]),
    segmentTails: new Set([102, 201]),
    segmentWindows: [
      { turn: 1, startSeq: 100, endSeq: 102, shadowed: [100, 101, 102] },
      { turn: 1, startSeq: 200, endSeq: 201, shadowed: [200, 201] },
    ],
    wholeTurn: true,
    dialog: { mode: 'reply', turn: 1, scope: 'turn' },
  });
  assert.equal(seg1Row.getAttribute('data-dshwd-pending'), '1', '第一段应被划掉');
  assert.equal(seg2Row.getAttribute('data-dshwd-pending'), '1', '第二段也应被划掉');
});

check('取消后（dialog 变回 null）标记全部消失', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('e');
  const nodes = { e: assistantNode(101) };
  const base = {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
  };
  render(nodes, { ...base, dialog: { mode: 'reply', seq: 101, turn: 1 } });
  assert.equal(row.getAttribute('data-dshwd-pending'), '1');
  // 取消：dialog 变 null，重新渲染
  render(nodes, { ...base, dialog: null });
  assert.ok(!row.hasAttribute('data-dshwd-pending'), '取消后删除线必须消失');
});

check('预览不锁滚动：插件不改行或 body 的 overflow / pointer-events', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('f');
  const bodyOverflowBefore = documentRoot.style.overflow;
  render({ f: assistantNode(101) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    dialog: { mode: 'reply', seq: 101, turn: 1 },
  });
  assert.equal(row.style.overflow, undefined, '行上不该被设 overflow（长段落必须能滚动核对）');
  assert.equal(row.style.pointerEvents, undefined, '行上不该被设 pointer-events');
  assert.equal(documentRoot.style.overflow, bodyOverflowBefore, 'body 的 overflow 不该被改');
});

check('surface 还没就绪时：宁可不划线，也不划错线', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('g');
  render({ g: assistantNode(101) }, {
    surfaceReady: false,
    surface: new Set(),
    segmentTails: new Set(),
    segmentWindows: [],
    dialog: { mode: 'reply', seq: 101, turn: 1 },
  });
  assert.ok(!row.hasAttribute('data-dshwd-pending'), 'surface 未就绪时不该猜着划线');
});

check('官方槽点开的确认框（只带 messageId）也能划线——靠 messageIdsBySeq 换算', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('h1');
  render({ h1: assistantNode(101) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    // surface seq → messageId：官方槽只知道 messageId，靠这份映射换算出落在哪一段。
    messageIdsBySeq: new Map([[101, 'msg-101']]),
    // 真机表现：底部按钮删得掉但没有删除线，因为它带的是 messageId 而不是 seq。
    dialog: { mode: 'reply', messageId: 'msg-101' },
  });
  assert.equal(
    row.getAttribute('data-dshwd-pending'),
    '1',
    '官方槽（messageId 定位）也必须划到线，否则用户看不到要删哪一段',
  );
});

check('官方槽的 messageId 换算不出段时：宁可不划线，也不乱划', () => {
  documentRoot.children.length = 0;
  const { render } = mount();
  const row = assistantRow('h2');
  render({ h2: assistantNode(101) }, {
    surfaceReady: true,
    surface: new Set([100, 101, 102]),
    segmentTails: new Set([100]),
    segmentWindows: SEGMENTS,
    messageIdsBySeq: new Map(),
    dialog: { mode: 'reply', messageId: 'unknown-id' },
  });
  assert.ok(!row.hasAttribute('data-dshwd-pending'), '映射不到时不该瞎划线');
});

console.log(`\nwm-delete 删除线预览：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
