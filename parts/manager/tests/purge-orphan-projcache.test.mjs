/**
 * purge-orphan-projcache.test.mjs — 「损坏会话删不掉」的回归测试。
 *
 * 故障现象：会话列表里有一行打不开（`历史加载失败：session "..." not found`）、归档不了、
 * 也删不掉。根因：删会话时只删了工件目录，**没删投影缓存行**
 * （`storages/session_projcache/sessions/<id>.json`）——而会话列表里的**冷行**正是它。
 *
 * 这里用真实临时目录测两条路径：
 *   1. deleteSessionFiles：工件没了也照样把缓存行删掉（所以"再点一次删除"能救回来）；
 *   2. purgeOrphanProjcache：启动时清掉已经积累的孤儿缓存行。
 *
 * 跑法：node parts/manager/tests/purge-orphan-projcache.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteSessionFiles, listSessions, projectKey, purgeOrphanProjcache } from '../lib/wm-relocate.js';

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

const CWD = 'D:\\DSH工作区\\银河战力党';
const ALIVE = 'session-alive-1111';
const GHOST_STUB = 'session-ghost-2222'; // 工件已删、只剩缓存行
const GHOST_OLD = 'session-ghost-3333'; // 同上，另一代（缓存行里带 cwd）

/** 搭一个最小现场：sessionsRoot + projcacheDir。 */
function makeSite() {
  const root = mkdtempSync(join(tmpdir(), 'wm-projcache-'));
  const sessionsRoot = join(root, 'sessions');
  const projcacheDir = join(root, 'storages', 'session_projcache', 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(projcacheDir, { recursive: true });
  return { root, sessionsRoot, projcacheDir };
}

/** 造一个"还在"的会话工件（只需目录存在，listSessions 认目录）。 */
function putArtifact(sessionsRoot, sessionId, cwd) {
  const dir = join(sessionsRoot, projectKey(cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'dummy');
  return dir;
}

/** 造一个投影缓存行。 */
function putCacheRow(projcacheDir, sessionId, cwd) {
  const file = join(projcacheDir, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 3, createdAt: 1, cwd, isSeeded: true, inheritedEventCount: 1 }, rows: { title: { ver: 1, seq: 1, val: '银河战力党' } } },
  }, null, 2) + '\n');
  return file;
}

// ---------------------------------------------------------------- deleteSessionFiles

check('deleteSessionFiles：工件 + 缓存行一起删', () => {
  const site = makeSite();
  const dir = putArtifact(site.sessionsRoot, ALIVE, CWD);
  const cache = putCacheRow(site.projcacheDir, ALIVE, CWD);
  const { removed } = deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: ALIVE });
  assert.equal(existsSync(dir), false, '工件目录应被删除');
  assert.equal(existsSync(cache), false, '缓存行应被删除');
  assert.equal(removed.length, 2, '两项都应记入 removed');
  rmSync(site.root, { recursive: true, force: true });
});

check('deleteSessionFiles：工件早就没了，只靠缓存行也能删干净（"再点一次删除"救得回来）', () => {
  const site = makeSite();
  // 工件不存在 —— 正是用户现场的状态
  const cache = putCacheRow(site.projcacheDir, GHOST_STUB, CWD);
  assert.equal(existsSync(cache), true);
  const { removed } = deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: GHOST_STUB });
  assert.equal(existsSync(cache), false, '缓存行必须被删掉，否则幽灵行永远留在列表里');
  assert.deepEqual(removed, [cache]);
  rmSync(site.root, { recursive: true, force: true });
});

check('deleteSessionFiles：工件目录空了会顺手删掉项目目录', () => {
  const site = makeSite();
  putArtifact(site.sessionsRoot, ALIVE, CWD);
  putCacheRow(site.projcacheDir, ALIVE, CWD);
  const projectDir = join(site.sessionsRoot, projectKey(CWD));
  deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: ALIVE });
  assert.equal(existsSync(projectDir), false, '空的项目目录应被回收');
  rmSync(site.root, { recursive: true, force: true });
});

check('deleteSessionFiles：完全不存在时幂等，不抛错', () => {
  const site = makeSite();
  assert.doesNotThrow(() => deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: 'session-nope' }));
  rmSync(site.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- purgeOrphanProjcache

check('purgeOrphanProjcache：只清孤儿，真实会话行一个不动', () => {
  const site = makeSite();
  putArtifact(site.sessionsRoot, ALIVE, CWD);
  putCacheRow(site.projcacheDir, ALIVE, CWD);
  const ghostA = putCacheRow(site.projcacheDir, GHOST_STUB, CWD);
  const ghostB = putCacheRow(site.projcacheDir, GHOST_OLD, CWD);

  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged.sort(), [GHOST_OLD, GHOST_STUB].sort());
  assert.equal(existsSync(join(site.projcacheDir, `${ALIVE}.json`)), true, '真实会话的缓存行必须保留');
  assert.equal(existsSync(ghostA), false);
  assert.equal(existsSync(ghostB), false);
  rmSync(site.root, { recursive: true, force: true });
});

check('purgeOrphanProjcache：缓存行里的 cwd 指向一个其实存在的目录时不删（防布局差异误删）', () => {
  const site = makeSite();
  // 缓存行 id 与目录名一致，但目录不在 listSessions 常规位置可被识别时……
  // 这里构造成：工件放在 cwd 算出的位置，但用一个"listSessions 扫不到"的中间层来模拟布局差异。
  const sessionId = 'session-layout-diff';
  const realDir = join(site.sessionsRoot, projectKey(CWD), sessionId);
  mkdirSync(realDir, { recursive: true });
  const cache = putCacheRow(site.projcacheDir, sessionId, CWD);
  // 先确认 listSessions 确实能看到它（正常情况），所以这里不会进孤儿分支
  assert.ok(listSessions(site.sessionsRoot).some((item) => item.sessionId === sessionId));
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged, []);
  assert.equal(existsSync(cache), true);
  rmSync(site.root, { recursive: true, force: true });
});

check('purgeOrphanProjcache：缓存行没有 cwd 时也能靠磁盘扫描判孤儿', () => {
  const site = makeSite();
  const file = join(site.projcacheDir, 'session-no-cwd.json');
  writeFileSync(file, JSON.stringify({ version: 7, record: { rows: {} } }));
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged, ['session-no-cwd']);
  assert.equal(existsSync(file), false);
  rmSync(site.root, { recursive: true, force: true });
});

check('purgeOrphanProjcache：非 .json 文件与空目录都安全跳过', () => {
  const site = makeSite();
  writeFileSync(join(site.projcacheDir, 'README.txt'), 'not a cache row');
  mkdirSync(join(site.projcacheDir, 'session-dir-like'));
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged, []);
  assert.equal(existsSync(join(site.projcacheDir, 'README.txt')), true);
  rmSync(site.root, { recursive: true, force: true });
});

check('purgeOrphanProjcache：缓存行 JSON 损坏时清掉它（读不出 cwd 的坏行同样是孤儿）', () => {
  const site = makeSite();
  const file = join(site.projcacheDir, 'session-broken.json');
  writeFileSync(file, '{ this is not json');
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged, ['session-broken']);
  rmSync(site.root, { recursive: true, force: true });
});

check('purgeOrphanProjcache：projcacheDir 不存在时返回空，不抛错', () => {
  const site = makeSite();
  assert.deepEqual(purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: join(site.root, 'nope') }), { purged: [] });
  assert.deepEqual(purgeOrphanProjcache({ sessionsRoot: undefined, projcacheDir: undefined }), { purged: [] });
  rmSync(site.root, { recursive: true, force: true });
});

check('真实现场复刻：241 个在盘会话 + 83 个孤儿缓存行 → 只清 83 个', () => {
  const site = makeSite();
  const alive = [];
  for (let i = 0; i < 40; i += 1) {
    const id = `session-alive-${String(i).padStart(4, '0')}`;
    putArtifact(site.sessionsRoot, id, CWD);
    putCacheRow(site.projcacheDir, id, CWD);
    alive.push(id);
  }
  const ghosts = [];
  for (let i = 0; i < 12; i += 1) {
    const id = `session-ghost-${String(i).padStart(4, '0')}`;
    putCacheRow(site.projcacheDir, id, CWD);
    ghosts.push(id);
  }
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.equal(purged.length, 12);
  for (const id of alive) assert.equal(existsSync(join(site.projcacheDir, `${id}.json`)), true, `${id} 不该被删`);
  for (const id of ghosts) assert.equal(existsSync(join(site.projcacheDir, `${id}.json`)), false, `${id} 该被删`);
  rmSync(site.root, { recursive: true, force: true });
});

console.log(`\n孤儿投影缓存清理：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
