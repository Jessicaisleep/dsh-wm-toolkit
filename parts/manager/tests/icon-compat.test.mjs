/**
 * icon-compat.test.mjs — 图标命名跨版本兼容的回归测试。
 *
 * 背景（真实故障）：DSH 2.0 更新后，官方 primitives 的图标命名换了代 ——
 *   旧版（≤ 0.1.5-rc.x）：尺寸写在名字后缀里，如 `IconArchiveOutline20`
 *   新版（2.0.x 起）    ：风格写在名字后缀里，如 `IconArchiveOutlineRegular` + `{ size }`
 * 本插件当时直接引用 `P.IconArchiveOutline20`，在新版下拿到 `undefined`；
 * React 遇到 undefined 组件会抛 "Element type is invalid"，于是
 * **左下角整块「会话管理」席位渲染失败、凭空消失**（而旁边的纯文字按钮都正常）。
 *
 * 这个文件同时守住两层：
 *   1. 行为层：用「只有新版名」「只有旧版名」「两个都没有」三种 primitives 加载真实半边，
 *      断言渲染树里**绝不出现 undefined 组件类型**（那正是崩溃条件）；
 *   2. 源码层：断言三个客户端半边里不再出现「尺寸后缀」的老式图标名（注释除外）。
 *
 * 跑法：node parts/manager/tests/icon-compat.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const managerClient = join(here, '..', 'lib', 'client.js');
const recallClient = join(here, '..', '..', 'recall', 'lib', 'client.js');
const deleteClient = join(here, '..', '..', 'delete', 'lib', 'client.js');

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

// ---------------------------------------------------------------- 加载脚手架

let loadSeq = 0;

/** 假 React：createElement 产出可遍历的普通对象，钩子全部返回可控值。 */
function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    memo: (component) => component,
    Fragment: 'Fragment',
    createPortal: () => null,
    Component: class Component { constructor(props) { this.props = props; } },
    PureComponent: class PureComponent { constructor(props) { this.props = props; } },
  };
}

function makeFakeDocument() {
  const node = () => ({
    style: {}, dataset: {}, children: [], firstChild: null, parentElement: null,
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    removeAttribute() {}, addEventListener() {}, removeEventListener() {}, append() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  });
  return {
    createElement: node, body: node(), head: node(), documentElement: node(),
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

/** 载入一个客户端半边（带 cache-buster，可反复用不同 primitives 加载）。 */
async function loadFace(clientPath, primitives) {
  let definition = null;
  globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def; } } };
  globalThis.document = makeFakeDocument();
  await import(`${pathToFileURL(clientPath).href}?v=${(loadSeq += 1)}`);
  if (definition === null) throw new Error(`没有捕获到 __ModuleLoader__.load：${clientPath}`);
  const fakeReact = makeFakeReact();
  const fakeRequire = (specifier) => {
    if (specifier === 'react') return fakeReact;
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null };
    if (specifier === 'react-dom') return { createPortal: () => null };
    if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require: ${specifier}`);
  };
  return definition.factory(fakeRequire);
}

/** 假宿主 ctx：把槽注册收集起来，其余服务给无害实现。 */
function makeCtx(registrations) {
  return {
    effect: (fn) => { try { fn(); } catch { /* 词典注册失败不该影响本测试 */ } return () => {}; },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    sessions: {
      open: () => {}, clear: () => {}, refresh: async () => {},
      list: { getSnapshot: () => ({ current: null, byId: {} }) },
    },
    workspaces: { archiveSession: async () => {}, refresh: async () => {} },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/** 收集渲染树里出现过的所有组件类型。 */
function collectTypes(tree, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) collectTypes(item, out);
    return out;
  }
  if (typeof tree !== 'object') return out;
  out.push(tree.type);
  for (const child of tree.children || []) collectTypes(child, out);
  return out;
}

const NEW_ICON = function NewStyleIcon(props) { return { type: 'svg', props, children: [] }; };
const LEGACY_ICON = function LegacyStyleIcon(props) { return { type: 'svg', props, children: [] }; };

const NEW_PRIMITIVES = {
  IconArchiveOutlineRegular: NEW_ICON,
  IconRefreshOutlineRegular: NEW_ICON,
  IconCloseOutlineRegular: NEW_ICON,
  IconCheckOutlineRegular: NEW_ICON,
  IconCopyOutlineRegular: NEW_ICON,
  IconChevronLeftOutlineRegular: NEW_ICON,
  IconChevronRightOutlineRegular: NEW_ICON,
  IconFolderOpenOutlineRegular: NEW_ICON,
};
const LEGACY_PRIMITIVES = {
  IconArchiveOutline20: LEGACY_ICON,
  IconRefreshOutline16: LEGACY_ICON,
  IconCloseOutline16: LEGACY_ICON,
  IconCheckOutline16: LEGACY_ICON,
  IconCopyOutline16: LEGACY_ICON,
  IconChevronLeftOutline14: LEGACY_ICON,
  IconChevronRightOutline14: LEGACY_ICON,
  IconFolderOpenOutline16: LEGACY_ICON,
};

// ---------------------------------------------------------------- 行为层

// ① 新版命名的 primitives：正是 DSH 2.0 更新后的真实情况。
{
  const face = await loadFace(managerClient, NEW_PRIMITIVES);
  const registrations = [];
  face.apply(makeCtx(registrations));
  const footer = registrations.find((r) => r.options.name === 'sidebar.footer.action');

  check('新版 primitives：sidebar.footer.action 席位仍会被注册', () => {
    assert.ok(footer, '「会话管理」所在的 sidebar.footer.action 槽必须注册');
  });

  check('新版 primitives：渲染「会话管理」席位不产生 undefined 组件（DSH 2.0 消失的那个 bug）', () => {
    const tree = footer.component({ t: (key) => key, onOpenPanel: () => {} });
    const types = collectTypes(tree);
    assert.ok(!types.includes(undefined), `渲染树里出现了 undefined 组件类型：${JSON.stringify(types)}`);
    assert.ok(types.includes(NEW_ICON), '应当解析到新版 IconArchiveOutlineRegular');
  });

  check('新版 primitives：顶栏的动作席位同样不产生 undefined 组件', () => {
    const header = registrations.find((r) => r.options.name === 'conversation.session.header.actions');
    assert.ok(header, '顶栏席位应注册');
    const types = collectTypes(header.component({
      t: (key) => key, sessionId: 'session-x', useWorkspaces: () => [],
    }));
    assert.ok(!types.includes(undefined), `顶栏渲染树出现 undefined：${JSON.stringify(types)}`);
  });

  check('新版 primitives：工作区菜单项能拿到图标（不再是 undefined）', () => {
    const items = globalThis.__DSH_WM__.workspaceMenuItems();
    assert.equal(items.length, 1);
    assert.notEqual(items[0].icon, undefined, '应解析到新版 IconFolderOpenOutlineRegular');
    assert.ok(!collectTypes(items[0].icon).includes(undefined));
  });
}

// ② 旧版命名的 primitives：老 DSH 上仍应工作（向后兼容）。
{
  const face = await loadFace(managerClient, LEGACY_PRIMITIVES);
  const registrations = [];
  face.apply(makeCtx(registrations));
  const footer = registrations.find((r) => r.options.name === 'sidebar.footer.action');

  check('旧版 primitives：仍能解析出图标（兼容老 DSH）', () => {
    const types = collectTypes(footer.component({ t: (key) => key, onOpenPanel: () => {} }));
    assert.ok(!types.includes(undefined));
    assert.ok(types.includes(LEGACY_ICON), '应当回退到旧版 IconArchiveOutline20');
  });
}

// ③ 两个都没有：必须降级成「没有图标」，而不是崩掉整个席位。
{
  const face = await loadFace(managerClient, {});
  const registrations = [];
  face.apply(makeCtx(registrations));
  const footer = registrations.find((r) => r.options.name === 'sidebar.footer.action');

  check('图标全都没有时：降级为无图标，绝不崩（不返回 undefined）', () => {
    const types = collectTypes(footer.component({ t: (key) => key, onOpenPanel: () => {} }));
    assert.ok(!types.includes(undefined), `出现 undefined 组件：${JSON.stringify(types)}`);
  });
}

// ④ recall 半边同样应该能在新版 primitives 下 apply 成功。
{
  const face = await loadFace(recallClient, NEW_PRIMITIVES);
  check('新版 primitives：recall 半边 apply 不抛错，且注册了槽', () => {
    const registrations = [];
    face.apply(makeCtx(registrations));
    assert.ok(registrations.length > 0, '应注册至少一个槽');
  });
}

// ---------------------------------------------------------------- 源码层

/** 剥掉块注释与行注释，避免把说明文字当成代码。 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

for (const [label, path] of [['recall', recallClient], ['manager', managerClient], ['delete', deleteClient]]) {
  check(`${label} 半边：代码里不再有「尺寸后缀」的老式图标名`, () => {
    const hits = codeOnly(readFileSync(path, 'utf8')).match(/Icon[A-Za-z]+(?:14|16|20|24)\b/g);
    assert.equal(hits, null, `发现老式图标名：${hits ? hits.join(', ') : ''}（新版是 <基名>Regular + size prop）`);
  });
}

check('manager 半边：图标必须经过跨版本解析器，不再直接取 P.<名字>', () => {
  const code = codeOnly(readFileSync(managerClient, 'utf8'));
  assert.ok(/resolvePrimitiveIcon/.test(code), '应有 resolvePrimitiveIcon');
  assert.ok(/renderPrimitiveIcon/.test(code), '应有 renderPrimitiveIcon');
  assert.ok(!/h\(P\.Icon/.test(code), '不应再出现 h(P.Icon…) 这种直取');
  assert.ok(!/P\[[A-Za-z]/.test(code) || /resolvePrimitiveIcon/.test(code));
});

check('recall 半边：图标同样经过解析器渲染', () => {
  const code = codeOnly(readFileSync(recallClient, 'utf8'));
  assert.ok(/resolvePrimitiveIcon/.test(code), '应有 resolvePrimitiveIcon');
  assert.ok(/renderPrimitiveIcon/.test(code), '应有 renderPrimitiveIcon');
  assert.ok(!/React\.createElement\(Icon/.test(code), '不应再直接 createElement(Icon…)');
});

console.log(`\n图标跨版本兼容：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
