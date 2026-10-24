/**
 * header-actions.test.mjs — 会话标题栏只保留「删除会话」的回归测试。
 *
 * 背景（用户反馈）：conversation.session.header.actions 这个席位原来同时渲染
 * 「归档 / 移动至工作区 / 删除会话」三个按钮，标题栏太挤。现在只保留删除会话，
 * 归档与移动退回到侧边栏底部的「会话管理」面板（那里逐行都有，功能没有丢）。
 *
 * 这个文件守住两层：
 *   1. 行为层：真实半边加载后渲染标题栏席位，断言**恰好一个**按钮、且它是删除；
 *      并断言点击不会抛错、也不会把点击冒泡给会话行；
 *   2. 源码层：HeaderAction 函数体里不再出现归档/移动的回调与 MoveDialog，
 *      且面板（SessionManagerPanel）里的归档/移动按钮**必须还在**——防止有人
 *      顺手把面板也一起削了，那才是真的丢功能。
 *   3. 侧栏层：DSH 0.2.1-rc.3 新开的 sidebar.panellist.actions（左侧栏面板列表的
 *      「更多」菜单）里，「迁移工作区」这一行必须注册，且 order 要排在官方两行
 *      （ui-entry-customization 未写 order → 默认 0）之后。
 *
 * 跑法：node parts/manager/tests/header-actions.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const managerClient = join(here, '..', 'lib', 'client.js');

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

/** 假 React：与 icon-compat 同款，setter 是空操作（弹窗不会打开）。 */
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

/**
 * 语言环境：wmZh() 读 navigator.language / document.documentElement 的 lang，
 * 都拿不到才 catch 成中文。Node 的 navigator.language 跟着**跑测机器**走 ——
 * Windows 中文机是 zh-CN，CI（ubuntu-latest，LANG=C.UTF-8）是 en-US ——
 * 于是「文案是中文」这条断言本地过、CI 挂（2026-10-25 真事：v0.2.13 首发
 * 就死在这一条）。这里把语言钉成可切换的假环境，断言与机器无关。
 */
const fakeEnv = { lang: 'zh-CN' };

function setFakeLanguage(lang) {
  fakeEnv.lang = lang;
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: lang }, configurable: true, writable: true,
  });
}

function makeFakeDocument() {
  const node = () => ({
    style: {}, dataset: {}, children: [], firstChild: null, parentElement: null,
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute(name) { return name === 'lang' ? fakeEnv.lang : null; },
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

const PRIMITIVES = {
  IconArchiveOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconRefreshOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconCloseOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconCheckOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconCopyOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconChevronLeftOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconChevronRightOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  IconFolderOpenOutlineRegular: function Icon() { return { type: 'svg', props: {}, children: [] }; },
  // DSH 0.2.1-rc.3 起官方「更多」菜单用这个行原语（ui-entry-customization 注册的就是它）。
  MenuItemButton: function MenuItemButton() { return { type: 'div', props: {}, children: [] }; },
};

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

/** 收集渲染树里所有 type 为 button 的节点（含其 props 与子节点）。 */
function collectButtons(tree, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) { for (const item of tree) collectButtons(item, out); return out; }
  if (typeof tree !== 'object') return out;
  if (tree.type === 'button') out.push(tree);
  for (const child of tree.children || []) collectButtons(child, out);
  return out;
}

/** 取出按钮的文字标签（子节点里的字符串）。 */
function labelOf(button) {
  return (button.children || []).filter((c) => typeof c === 'string').join('');
}

// ---------------------------------------------------------------- 行为层

// 先钉死语言环境，再加载半边（渲染时才会读 navigator，但钉早一点更稳）。
setFakeLanguage('zh-CN');

const face = await loadFace(managerClient, PRIMITIVES);
const registrations = [];
face.apply(makeCtx(registrations));

const header = registrations.find((r) => r.options.name === 'conversation.session.header.actions');
const panel = registrations.find((r) => r.options.name === 'sidebar.footer.action');

const headerTree = header.component({
  t: (key) => key,
  sessionId: 'session-x',
  useWorkspaces: () => [],
});
const headerButtons = collectButtons(headerTree);

check('标题栏席位仍然注册（不是整个席位被摘掉）', () => {
  assert.ok(header, 'conversation.session.header.actions 必须还在');
  assert.ok(panel, 'sidebar.footer.action 必须还在');
});

check('标题栏只剩一个按钮（原来三个：归档 / 移动 / 删除）', () => {
  assert.equal(headerButtons.length, 1, `期望 1 个按钮，实际 ${headerButtons.length} 个：${headerButtons.map(labelOf).join(' | ')}`);
});

check('剩下的那个按钮是「删除会话」', () => {
  const [only] = headerButtons;
  assert.equal(only.props['aria-label'], 'row.delete', 'aria-label 应指向 row.delete');
  assert.equal(labelOf(only), 'row.delete', '可见文字应取 row.delete 词典项');
});

check('标题栏不再出现归档 / 移动按钮', () => {
  const labels = headerButtons.map((b) => b.props['aria-label']);
  assert.ok(!labels.includes('row.archive'), '归档按钮应已移除');
  assert.ok(!labels.includes('row.unarchive'), '移出归档按钮应已移除');
  assert.ok(!labels.includes('row.move'), '移动至工作区按钮应已移除');
});

check('删除按钮仍是危险色样式，且点击不会冒泡到会话行', () => {
  const [only] = headerButtons;
  assert.match(only.props.className, /sm-headerBtnDanger/, '应保留 sm-headerBtnDanger 样式');
  let stopped = false;
  assert.doesNotThrow(() => only.props.onClick({ stopPropagation: () => { stopped = true; } }));
  assert.ok(stopped, 'onClick 必须调用 stopPropagation（否则会连带选中/打开会话行）');
});

// ---------------------------------------------------------------- 侧栏「更多」菜单里的迁移行（rc.3）

const menuRow = registrations.find((r) => r.options.name === 'sidebar.panellist.actions');

check('侧栏「更多」席位已注册（DSH 0.2.1-rc.3 开的 sidebar.panellist.actions）', () => {
  assert.ok(menuRow, 'sidebar.panellist.actions 必须注册，否则「更多」里看不到迁移入口');
  assert.equal(menuRow.options.id, 'session-manager-wm-migrate-menu');
  assert.equal(menuRow.options.locale, 'session-manager', '行文案走本插件的词典');
});

check('侧栏菜单行的 order 排在官方两行（未写 order → 默认 0）之后', () => {
  assert.ok(Number(menuRow.options.order) > 0,
    `order 必须大于官方默认值 0，否则会跑到「浏览更多插件 / 创建你的插件」上面，实际 ${menuRow.options.order}`);
});

/** 渲染侧栏菜单行：返回渲染树与 onDismiss 计数。 */
function renderMenuRow() {
  const state = { dismissed: 0 };
  const tree = menuRow.component({ onDismiss: () => { state.dismissed += 1; } });
  return { tree, state };
}

check('侧栏菜单行渲染成官方 MenuItemButton，文案是「迁移工作区」', () => {
  const { tree } = renderMenuRow();
  assert.equal(tree.type, PRIMITIVES.MenuItemButton, '必须用官方行原语（菜单里其它行也是它）');
  assert.deepEqual(tree.children, ['迁移工作区'], '中文环境下文案应取中文字典项');
  assert.ok(tree.props.icon, '必须带图标（解析不到也不许是 undefined 组件）');
});

check('行文案随语言切换（zh → 迁移工作区 / en → Migrate workspace），与跑测机器无关', () => {
  setFakeLanguage('zh-CN');
  assert.deepEqual(renderMenuRow().tree.children, ['迁移工作区'], 'zh 环境应取中文字典项');
  setFakeLanguage('en-US');
  assert.deepEqual(renderMenuRow().tree.children, ['Migrate workspace'], 'en 环境应取英文字典项');
  setFakeLanguage('zh-CN');
});

check('点侧栏菜单行：先关菜单再开对话框，且不抛错', () => {
  const { tree, state } = renderMenuRow();
  assert.doesNotThrow(() => tree.props.onSelect(), 'onSelect 不许把异常抛回宿主');
  assert.equal(state.dismissed, 1, 'onSelect 必须先调 onDismiss 关掉菜单，否则菜单浮层压在对话框上');
});

// ---------------------------------------------------------------- 入口去重

check('会话右上角工具区不再注册迁移入口（同一个动作只留侧栏「更多」那一行）', () => {
  const stale = registrations.filter((r) => r.options.name === 'conversation.session.header.utilities');
  assert.equal(stale.length, 0,
    `2026-10-25 起迁移入口只在侧栏「更多」里；conversation.session.header.utilities 不应再有本插件注册，实际 ${stale.length} 条`);
});

check('迁移入口在整份注册表里只有一条（且是侧栏那条）', () => {
  const migrate = registrations.filter((r) => String(r.options.id || '').startsWith('session-manager-wm-migrate'));
  assert.equal(migrate.length, 1,
    `迁移入口应只有一条注册，实际 ${migrate.length} 条：${migrate.map((r) => r.options.id).join(' | ')}`);
  assert.equal(migrate[0].options.id, 'session-manager-wm-migrate-menu');
});

// ---------------------------------------------------------------- 源码层

/** 剥掉块注释与行注释，避免把说明文字当成代码。 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const source = readFileSync(managerClient, 'utf8');
const code = codeOnly(source);

/** 截出 HeaderAction 的函数体。 */
function bodyOf(name, endMarker) {
  const start = code.indexOf(`function ${name}(props) {`);
  assert.notEqual(start, -1, `找不到 function ${name}`);
  const end = code.indexOf(endMarker, start);
  assert.notEqual(end, -1, `找不到 ${name} 之后的 ${endMarker}`);
  return code.slice(start, end);
}

const headerBody = bodyOf('HeaderAction', 'class SafePanel');

check('HeaderAction 里不再引用归档/移动回调', () => {
  for (const bad of ['onArchive', 'onUnarchive', 'onMove(', 'moveFor', 'moveAnchor', 'archiveLabelKey']) {
    assert.ok(!headerBody.includes(bad), `HeaderAction 里仍有 ${bad}`);
  }
});

check('HeaderAction 里不再渲染 MoveDialog', () => {
  assert.ok(!headerBody.includes('MoveDialog'), 'HeaderAction 不应再渲染 MoveDialog');
});

check('HeaderAction 仍保留删除所需的 ConfirmDialog 与错误气泡', () => {
  assert.ok(headerBody.includes('ConfirmDialog'), 'ConfirmDialog 必须保留');
  assert.ok(headerBody.includes('onRemove'), 'onRemove 必须保留');
  assert.ok(headerBody.includes('sm-noticeBubble'), '非阻塞错误气泡必须保留（window.alert 会卡死输入框）');
});

// 面板里的归档/移动必须还在——否则就是真的把功能删了，而不是搬家。
const panelBody = bodyOf('SessionManagerPanel', 'class SafePanel');

check('侧边栏面板里归档 / 移动 / 删除 / 打开 / 迁移预设 五项都还在', () => {
  for (const key of ['row.unarchive', 'row.archive', 'row.move', 'row.delete', 'row.open', 'row.migrate']) {
    assert.ok(panelBody.includes(key), `面板里缺少 ${key}，功能被误删`);
  }
});

check('面板仍然渲染 MoveDialog（移动功能没被顺手削掉）', () => {
  assert.ok(panelBody.includes('MoveDialog'), '面板的 MoveDialog 必须保留');
});

console.log(`\n标题栏只留删除会话：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
