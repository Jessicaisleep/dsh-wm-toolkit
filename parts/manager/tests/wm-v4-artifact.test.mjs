/**
 * wm-v4-artifact.test.mjs — 「有内容的会话被判成没有磁盘记录」的回归测试。
 *
 * 真实故障（2026-10-02）：用户把会话 `session-f922fa6b-…` 移动到工作区
 * 「哥伦比娅生日会3D」，弹出：
 *   操作失败：会话 session-f922fa6b-… 没有磁盘记录（不存在，或是一个尚未发送
 *   任何消息的空白会话），无法移动
 * 而磁盘上那个会话明明有 109894 字节、还在持续写入。
 *
 * 根因：`listSessionHeaders()` 的磁盘兜底只认这几个文件名
 *   ["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"]
 * **不含 `session.v4.jsonl.zstd`** —— 于是 v4 会话在兜底扫描里被整个跳过，
 * `moveSession()` 找不到 header 就报「没有磁盘记录」。
 * 同一份硬编码列表在宿主半边还有第二处（原 index.js:1205）。
 * wm-relocate.js 的 LOG_NAMES 早就修过同一个坑（注释里写着「只认 v3 会把 v4
 * 会话当成没有日志整个跳过——迁移于是静默失效」），这次把三处统一成单一来源。
 *
 * 另外守一条客户端禁令：报错**不许用 window.alert**。它在 Electron 里是原生
 * 模态，会阻塞渲染进程，用户点掉之后 DSH 的输入框再也拿不回焦点 —— 表现为
 * 「这个对话框一出现，所有对话输入框全部卡死，只能重启 DSH」。
 *
 * 跑法：node parts/manager/tests/wm-v4-artifact.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { LOG_NAMES, encodeSegment, findSessionLog, projectKey } from '../lib/wm-relocate.js';

const here = dirname(fileURLToPath(import.meta.url));
const hostLib = join(here, '..', 'lib', 'index.js');
const clientLib = join(here, '..', 'lib', 'client.js');
const relocateLib = join(here, '..', 'lib', 'wm-relocate.js');

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

/** 线上实际出故障的那个会话 id 与 cwd（复刻现场）。 */
const SESSION = 'session-f922fa6b-bf05-4a68-ba17-7226604d7fbe';
const CWD = 'D:\\DSH工作区';

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
});

/**
 * 按 DSH 的真实布局落一个会话：
 *   <sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/<logName>
 * 注意是**两层**目录——少一层的话兜底扫描会把会话目录本身当成文件跳过，
 * 测试就会假红（这个脚手架 bug 在写本文件时真踩过一次）。
 */
function putSession(sessionsRoot, sessionId, cwd, logName) {
  const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId));
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ id: sessionId, version: 4, cwd, createdAt: 1 }) + '\n';
  const body = JSON.stringify({ seq: 1, type: 'user/message', data: { text: 'hi' } }) + '\n';
  writeFileSync(join(dir, logName), Buffer.concat([frame(header), frame(body)]));
  return dir;
}

const read = (file) => readFileSync(file, 'utf8');
/** 去掉注释行，只留真正会执行的代码——避免注释里提到 window.alert 就误报。 */
const stripComments = (source) => source
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  })
  .join('\n');

// ------------------------------------------------------ LOG_NAMES 是唯一来源

check('LOG_NAMES 以 v4 打头，且覆盖 v0~v4 全部世代', () => {
  assert.equal(LOG_NAMES[0], 'session.v4.jsonl.zstd', 'v4 必须排第一（当前世代优先）');
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
    assert.ok(LOG_NAMES.includes(name), `LOG_NAMES 缺少 ${name}`);
  }
});

check('findSessionLog 能认出 v4 会话目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-v4-'));
  const dir = putSession(root, SESSION, CWD, 'session.v4.jsonl.zstd');
  const found = findSessionLog(dir);
  assert.ok(found !== undefined, 'v4 日志必须被认出来');
  assert.equal(found.name, 'session.v4.jsonl.zstd');
});

// ------------------------------------------------------ 宿主半边不再硬编码

check('宿主 index.js 不再硬编码文件名列表（必须走 LOG_NAMES）', () => {
  const source = read(hostLib);
  const code = stripComments(source);
  // 现场那两个列表的典型片段：以 session.v3 / session.jsonl.zstd 开头的字面量数组
  const hardcoded = [
    /\[\s*"session\.v3\.jsonl\.zstd"/,
    /\[\s*"session\.jsonl\.zstd"/,
  ];
  for (const pattern of hardcoded) {
    assert.ok(!pattern.test(code), `宿主半包里仍有硬编码日志文件名列表：${pattern}`);
  }
  assert.ok(code.includes('LOG_NAMES'), '宿主半包必须从 wm-relocate.js 取 LOG_NAMES');
  // 两处调用点都要用上
  const uses = (code.match(/for \(const filename of LOG_NAMES\)/g) || []).length;
  assert.ok(uses >= 2, `期望至少 2 处遍历 LOG_NAMES，实际 ${uses} 处`);
});

check('wm-relocate.js 的 LOG_NAMES 是导出的单一来源', () => {
  const code = stripComments(read(relocateLib));
  assert.ok(/export const LOG_NAMES/.test(code), 'LOG_NAMES 必须是导出的');
});

// ------------------------------------------------------ 兜底扫描真的能扫到 v4

/**
 * 复刻 listSessionHeaders 的磁盘兜底：遍历 sessions/<proj>/<dir>/<LOG_NAMES>，
 * 逐代候选文件名读取，解出 header 里的 id。这里用真实的 LOG_NAMES 驱动，
 * 所以只要列表漏了 v4，本用例就会红。
 */
function diskFallbackScan(sessionsRoot) {
  const out = [];
  for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const entry of readdirSync(join(sessionsRoot, proj.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(sessionsRoot, proj.name, entry.name);
      for (const filename of LOG_NAMES) {
        const file = join(dir, filename);
        if (!existsSync(file)) continue;
        const buf = readFileSync(file);
        let content;
        try {
          content = zlib.zstdDecompressSync(buf).toString('utf8');
        } catch {
          continue;
        }
        const headerLine = content.split('\n', 1)[0];
        const meta = JSON.parse(headerLine);
        out.push({ id: meta.id, cwd: meta.cwd });
        break;
      }
    }
  }
  return out;
}

check('磁盘兜底能按 sessionId 找回 v4 会话（出故障的那条）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-v4-scan-'));
  putSession(root, SESSION, CWD, 'session.v4.jsonl.zstd');
  const headers = diskFallbackScan(root);
  const hit = headers.find((header) => header.id === SESSION);
  assert.ok(hit !== undefined, '兜底扫描必须能找回 v4 会话（否则又会报「没有磁盘记录」）');
  assert.equal(hit.cwd, CWD);
});

check('磁盘兜底对 v3 会话同样有效（新列表不能倒退）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wm-v3-scan-'));
  putSession(root, SESSION, CWD, 'session.v3.jsonl.zstd');
  const headers = diskFallbackScan(root);
  assert.ok(headers.some((header) => header.id === SESSION));
});

// ------------------------------------------------------ 客户端不许用阻塞弹窗

check('客户端半边不再出现 window.alert（会卡死输入框）', () => {
  const code = stripComments(read(clientLib));
  assert.ok(!/window\.alert\s*\(/.test(code), '发现 window.alert：Electron 原生模态会阻塞渲染进程，点掉后输入框卡死');
  assert.ok(!/(^|[^.\w])alert\s*\(/.test(code), '发现裸 alert() 调用，同上');
});

check('客户端半边改用组件内联提示（sm-noticeBubble）', () => {
  const source = read(clientLib);
  assert.ok(source.includes('setNotice('), '错误出口必须走组件内联 notice');
  assert.ok(source.includes('sm-noticeBubble'), '必须有内联气泡的类名');
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`失败用例：${failures.join('、')}`);
  process.exit(1);
}
