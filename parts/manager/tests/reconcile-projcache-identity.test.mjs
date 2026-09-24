/**
 * reconcile-projcache-identity.test.mjs — 「投影缓存 identity 对账」的回归测试。
 *
 * 背景：post-boot 的 sweep 原来调 `sessionProjectionCache.coldSnapshot(id)`，
 * 但那个 API 的真实签名是 `coldSnapshot(meta, inheritedEventCount, events)`（要**完整日志**），
 * 于是每个会话都抛 `SessionLogOffset must be a non-negative safe integer, got undefined`，
 * `re-folded 0` 全军覆没。现在改成只读 header 的 identity 对账。
 *
 * 这里用**真实 zstd 工件**（header 帧 + 正文帧）跑通"定位工件 → 读 header → 对账缓存行"。
 *
 * 跑法：node parts/manager/tests/reconcile-projcache-identity.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { projectKey, reconcileProjcacheForSession, reconcileProjcacheIdentity } from '../lib/wm-relocate.js';

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

const CWD_NEW = 'D:\\DSH工作区\\银河战力党';
const CWD_OLD = 'D:\\DSH工作区\\旧名字';
const SID = 'session-8c5d8123-cce9-4c85-9532-6a00c36a92fa';

function makeSite() {
  const root = mkdtempSync(join(tmpdir(), 'wm-identity-'));
  const sessionsRoot = join(root, 'sessions');
  const projcacheDir = join(root, 'storages', 'session_projcache', 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(projcacheDir, { recursive: true });
  return { root, sessionsRoot, projcacheDir };
}

/** 造一个真实的多帧 zstd 工件（第一帧 = header 一行）。 */
function putArtifact(sessionsRoot, sessionId, header) {
  const dir = join(sessionsRoot, projectKey(header.cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const headerLine = JSON.stringify({ type: 'session', ...header }) + '\n';
  const body = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n';
  const bytes = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(body, 'utf8')),
  ]);
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), bytes);
  return dir;
}

/** 造一个缓存行（identity 可控）。 */
function putCacheRow(projcacheDir, sessionId, identity) {
  const file = join(projcacheDir, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify({
    version: 7,
    record: {
      identity,
      rows: { title: { ver: 1, seq: 9, val: '银河战力党' } },
    },
  }, null, 2) + '\n');
  return file;
}

const readIdentity = (file) => JSON.parse(readFileSync(file, 'utf8')).record.identity;

// ---------------------------------------------------------------- reconcileProjcacheIdentity

check('identity 一致时不写盘（返回 false）', () => {
  const site = makeSite();
  const header = { id: SID, version: 3, createdAt: 100, cwd: CWD_NEW, isSeeded: false };
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 100, cwd: CWD_NEW, isSeeded: false, inheritedEventCount: 0 });
  const before = readFileSync(file, 'utf8');
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header }), false);
  assert.equal(readFileSync(file, 'utf8'), before, '文件不该被改写');
  rmSync(site.root, { recursive: true, force: true });
});

check('cwd 变了 → 修正（工作区搬家/改名场景）', () => {
  const site = makeSite();
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 100, cwd: CWD_OLD, isSeeded: false, inheritedEventCount: 0 });
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: SID, version: 3, createdAt: 100, cwd: CWD_NEW, isSeeded: false } }), true);
  assert.equal(readIdentity(file).cwd, CWD_NEW);
  rmSync(site.root, { recursive: true, force: true });
});

check('createdAt / formatVersion / isSeeded 对不上 → 一并修正', () => {
  const site = makeSite();
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 2, createdAt: 1, cwd: CWD_NEW, isSeeded: false, inheritedEventCount: 0 });
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: SID, version: 3, createdAt: 999, cwd: CWD_NEW, isSeeded: true } }), true);
  const identity = readIdentity(file);
  assert.equal(identity.formatVersion, 3);
  assert.equal(identity.createdAt, 999);
  assert.equal(identity.isSeeded, true);
  rmSync(site.root, { recursive: true, force: true });
});

check('inheritedEventCount 必须原样保留（工件 header 里没有这个字段）', () => {
  const site = makeSite();
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 1, cwd: CWD_OLD, isSeeded: true, inheritedEventCount: 4535 });
  reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: SID, version: 3, createdAt: 1, cwd: CWD_NEW, isSeeded: true } });
  assert.equal(readIdentity(file).inheritedEventCount, 4535, '改 cwd 不该动 seed 长度');
  rmSync(site.root, { recursive: true, force: true });
});

check('保留 record 里除 identity 之外的其它内容（rows 不能被丢）', () => {
  const site = makeSite();
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 1, cwd: CWD_OLD, isSeeded: false, inheritedEventCount: 0 });
  reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: SID, version: 3, createdAt: 1, cwd: CWD_NEW, isSeeded: false } });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 7, '外层 version 保留');
  assert.equal(parsed.record.rows.title.val, '银河战力党', '投影行必须保留');
  rmSync(site.root, { recursive: true, force: true });
});

check('缓存行不存在 / JSON 损坏 / 没有 identity → 都返回 false 不抛错', () => {
  const site = makeSite();
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: 'nope', version: 3, cwd: CWD_NEW } }), false);
  const broken = join(site.projcacheDir, 'session-broken.json');
  writeFileSync(broken, '{ not json');
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: 'session-broken', version: 3, cwd: CWD_NEW } }), false);
  const noIdentity = join(site.projcacheDir, 'session-noident.json');
  writeFileSync(noIdentity, JSON.stringify({ version: 7, record: { rows: {} } }));
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: { id: 'session-noident', version: 3, cwd: CWD_NEW } }), false);
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: undefined, header: { id: SID } }), false);
  assert.equal(reconcileProjcacheIdentity({ projcacheDir: site.projcacheDir, header: null }), false);
  rmSync(site.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- reconcileProjcacheForSession

check('从真实 zstd 工件读 header 并对账（端到端）', () => {
  const site = makeSite();
  const header = { id: SID, version: 3, createdAt: 1790211536393, cwd: CWD_NEW, isSeeded: true, agentPreset: 'standard' };
  putArtifact(site.sessionsRoot, SID, header);
  const file = putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 1790211536393, cwd: CWD_OLD, isSeeded: true, inheritedEventCount: 4535 });

  const changed = reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SID });
  assert.equal(changed, true, '应修正 cwd');
  const identity = readIdentity(file);
  assert.equal(identity.cwd, CWD_NEW);
  assert.equal(identity.createdAt, 1790211536393);
  assert.equal(identity.inheritedEventCount, 4535, 'seed 长度保留');
  rmSync(site.root, { recursive: true, force: true });
});

check('工件不存在 → false（不抛错）', () => {
  const site = makeSite();
  putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 1, cwd: CWD_NEW, isSeeded: false, inheritedEventCount: 0 });
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SID }), false);
  rmSync(site.root, { recursive: true, force: true });
});

check('工件第一帧不是合法 zstd → false（不抛错）', () => {
  const site = makeSite();
  const dir = join(site.sessionsRoot, projectKey(CWD_NEW), SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'plain text, not zstd');
  putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 1, cwd: CWD_NEW, isSeeded: false, inheritedEventCount: 0 });
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SID }), false);
  rmSync(site.root, { recursive: true, force: true });
});

check('参数不合法 → false（不抛错）', () => {
  const site = makeSite();
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: undefined, projcacheDir: site.projcacheDir, sessionId: SID }), false);
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: '' }), false);
  rmSync(site.root, { recursive: true, force: true });
});

check('对账是幂等的：第二次返回 false 且文件不再变化', () => {
  const site = makeSite();
  putArtifact(site.sessionsRoot, SID, { id: SID, version: 3, createdAt: 5, cwd: CWD_NEW, isSeeded: false });
  putCacheRow(site.projcacheDir, SID, { formatVersion: 3, createdAt: 5, cwd: CWD_OLD, isSeeded: false, inheritedEventCount: 0 });
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SID }), true);
  const after = readFileSync(join(site.projcacheDir, `${SID}.json`), 'utf8');
  assert.equal(reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SID }), false);
  assert.equal(readFileSync(join(site.projcacheDir, `${SID}.json`), 'utf8'), after);
  rmSync(site.root, { recursive: true, force: true });
});

check('不再依赖 sessionProjectionCache 服务（旧调用的服务依赖已移除）', () => {
  // 这条是源码级回归：旧的 `ctx.get("sessionProjectionCache")` + `coldSnapshot(id)` 必须消失，
  // 否则启动时又会刷满 `SessionLogOffset ... got undefined`。
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 先把块注释与行注释剥掉，再查代码（注释里提到这两个名字是允许的、也是必要的说明）。
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.ok(!/coldSnapshot\s*\(/.test(codeOnly), '代码里不应再有 coldSnapshot( 调用（注释除外）');
  assert.ok(!/sessionProjectionCache/.test(codeOnly), '不应再依赖 sessionProjectionCache 服务');
  assert.ok(existsSync(new URL('../lib/wm-relocate.js', import.meta.url)));
});

console.log(`\n投影缓存 identity 对账：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
