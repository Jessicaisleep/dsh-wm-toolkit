/**
 * wm-escaped-session-id.test.mjs — 「桥接会话删不掉、删了重启又回来」的回归测试。
 *
 * 故障现象（用户实测）：在飞书（lark-link）桥接出来的会话上点「删除会话」，
 * **界面当场掉行、磁盘却纹丝不动**；重启 DSH 后那一行又回来了——用户一直以为
 * 是"它自己恢复"，其实是**从来没删掉过**。
 *
 * 根因：DSH 把会话 id 转义成目录名（官方 `encodeSegment`：`:` → `~003A`，
 * `~` 自身 → `~007E`），而 `listSessions()` 直接把目录名当 sessionId 返回。
 * 于是 `lark-link:dm:…:0` 这种带 `:` 的 id **永远匹配不上**：
 *
 *   · `deleteSessionFiles`   → find 落空 → rmSync 压根不执行（而且不报错）
 *   · `purgeOrphanProjcache` → 把活会话的缓存行当孤儿清掉
 *   · `reconcileProjcacheForSession` → 找不到日志，对账静默跳过
 *   · `relocateSessions`     → 缓存修补落空；目标目录名也会拼错
 *
 * 顺带覆盖两个同源坑：日志文件名不能再写死 v3（现在是 `session.v4.jsonl.zstd`）、
 * 自己拼会话目录路径时必须用 `encodeSegment`。
 *
 * 跑法：node parts/manager/tests/wm-escaped-session-id.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import {
  decodeSegment,
  deleteSessionFiles,
  encodeSegment,
  listSessions,
  projectKey,
  purgeOrphanProjcache,
  reconcileProjcacheForSession,
  relocateSessions,
} from '../lib/wm-relocate.js';

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

/** 线上实际出现的桥接会话 id（飞书 lark-link），含 4 个 `:`。 */
const BRIDGED = 'lark-link:dm:oc_2a58532568e31412e69a47fc0cbb31f6:mujqtyuo8ej7:0';
/** 普通会话 id：只含 `[A-Za-z0-9._-]`，转义前后相同（所以一直没暴露这个 bug）。 */
const PLAIN = 'session-8c5d8123-cce9-4c85-9532-6a00c36a92fa';
const CWD = 'D:\\DSH工作区';

function makeSite() {
  const root = mkdtempSync(join(tmpdir(), 'wm-escaped-'));
  const sessionsRoot = join(root, 'sessions');
  const projcacheDir = join(root, 'storages', 'session_projcache', 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(projcacheDir, { recursive: true });
  return { root, sessionsRoot, projcacheDir };
}

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

/** 按 DSH 的命名落一个会话目录——目录名是**转义形式**。 */
function putSession(sessionsRoot, sessionId, cwd, logName = 'session.v4.jsonl.zstd') {
  const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId));
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ id: sessionId, version: 4, cwd, createdAt: 1, isSeeded: false, agentPreset: 'standard' }) + '\n';
  const event = JSON.stringify({ seq: 1, type: 'user/message', data: { text: 'hi' } }) + '\n';
  writeFileSync(join(dir, logName), Buffer.concat([frame(header), frame(event)]));
  return dir;
}

function putCacheRow(projcacheDir, sessionId, cwd, extra = {}) {
  const file = join(projcacheDir, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 4, createdAt: 1, cwd, isSeeded: false, inheritedEventCount: 0, ...extra }, rows: {} },
  }, null, 2) + '\n');
  return file;
}

// ---------------------------------------------------------------- 转义往返

check('encodeSegment / decodeSegment 往返（含 `:` 与 `~`）', () => {
  for (const raw of [BRIDGED, PLAIN, 'a:b~c', 'x.y-z_1', '中文会话名']) {
    assert.equal(decodeSegment(encodeSegment(raw)), raw, `往返失败：${raw}`);
  }
  assert.equal(encodeSegment('a:b'), 'a~003Ab', '`:` 必须转义成 ~003A');
  assert.equal(encodeSegment('a~b'), 'a~007Eb', '`~` 自身也必须转义');
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  // 不需要转义的字符必须原样保留（普通会话 id 才不会变样）
  assert.equal(encodeSegment(PLAIN), PLAIN);
});

// ---------------------------------------------------------------- listSessions

check('listSessions：sessionId 是解码后的原始 id，dirName 是磁盘名', () => {
  const site = makeSite();
  const dir = putSession(site.sessionsRoot, BRIDGED, CWD);
  const rows = listSessions(site.sessionsRoot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, BRIDGED, '必须能跟调用方手里的原始 id 直接比较');
  assert.ok(rows[0].dirName.includes('~003A'), `dirName 应是转义名：${rows[0].dirName}`);
  assert.equal(rows[0].dir, dir);
  assert.equal(rows[0].dir.endsWith(rows[0].dirName), true);
});

// ---------------------------------------------------------------- 删除（核心回归）

check('deleteSessionFiles：桥接会话（含 `:`）的目录真的被删掉', () => {
  const site = makeSite();
  const dir = putSession(site.sessionsRoot, BRIDGED, CWD);
  assert.ok(existsSync(dir));
  const { removed } = deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: BRIDGED });
  assert.equal(existsSync(dir), false, '目录必须消失——旧代码在这里静默失败，重启后会话就"复活"了');
  assert.ok(removed.includes(dir), `removed 应报告该目录：${JSON.stringify(removed)}`);
});

check('deleteSessionFiles：桥接会话没有投影缓存行时也照常删掉目录', () => {
  const site = makeSite();
  const dir = putSession(site.sessionsRoot, BRIDGED, CWD);
  // 含 `:` 的会话**从来就没有**投影缓存行：官方 storage 要求 per-record key 匹配
  // /^[a-zA-Z0-9_-]+$/（Windows 上 `:` 连做文件名都不行）。所以这里必须容忍
  // "缓存行不存在"，不能因此半途而废。
  const { removed } = deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: BRIDGED });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(removed, [dir], '目录删掉即可，不该虚报一个不存在的缓存行');
});

check('deleteSessionFiles：普通 uuid 会话行为不变', () => {
  const site = makeSite();
  const dir = putSession(site.sessionsRoot, PLAIN, CWD);
  const cache = putCacheRow(site.projcacheDir, PLAIN, CWD);
  deleteSessionFiles({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: PLAIN });
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(cache), false);
});

// ---------------------------------------------------------------- 孤儿缓存清理

check('purgeOrphanProjcache：桥接会话（无缓存行）不受影响，真孤儿仍被清', () => {
  const site = makeSite();
  putSession(site.sessionsRoot, BRIDGED, CWD);
  const orphan = putCacheRow(site.projcacheDir, 'session-gone-0001', CWD); // 工件不存在 → 真孤儿
  const { purged } = purgeOrphanProjcache({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir });
  assert.deepEqual(purged, ['session-gone-0001'], '只清工件确实没了的缓存行');
  assert.equal(existsSync(orphan), false);
});

// ---------------------------------------------------------------- 迁移

check('relocateSessions：桥接会话能迁移，且目标目录名仍是转义形式', () => {
  const site = makeSite();
  const oldCwd = 'D:\\old-place';
  const newCwd = 'D:\\new-place';
  putSession(site.sessionsRoot, BRIDGED, oldCwd);

  const result = relocateSessions({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, fromCwd: oldCwd, toCwd: newCwd });
  assert.deepEqual(result.failed, [], `不该有失败：${JSON.stringify(result.failed)}`);
  assert.deepEqual(result.moved, [BRIDGED], '报告里的 id 应是原始 id');

  const newDir = join(site.sessionsRoot, projectKey(newCwd), encodeSegment(BRIDGED));
  assert.ok(existsSync(newDir), '目标目录名必须转义（否则 DSH 按 encodeSegment 找不到它）');
  assert.ok(existsSync(join(newDir, 'session.v4.jsonl.zstd')), 'v4 日志应跟着搬过去');
  assert.equal(existsSync(join(site.sessionsRoot, projectKey(oldCwd), encodeSegment(BRIDGED))), false, '旧目录应被移除');
});

check('relocateSessions：v4 日志名也能识别（不再写死 v3）', () => {
  const site = makeSite();
  const oldCwd = 'D:\\v4-old';
  const newCwd = 'D:\\v4-new';
  putSession(site.sessionsRoot, PLAIN, oldCwd, 'session.v4.jsonl.zstd');
  const result = relocateSessions({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, fromCwd: oldCwd, toCwd: newCwd });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.moved, [PLAIN], '只认 v3 时这里会是空（迁移静默失效）');
});

// ---------------------------------------------------------------- 缓存对账

check('reconcileProjcacheForSession：能读到 v4 日志并修正过期 identity', () => {
  const site = makeSite();
  // agents-anywhere 的桥接 id：只含 [A-Za-z0-9_]，是 path-safe 的，所以**能**有缓存行
  // （飞书那种带 `:` 的不能）。用它来覆盖"读 v4 日志 + 对账"这条路径。
  const SAFE = 'aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A';
  putSession(site.sessionsRoot, SAFE, CWD);
  const cache = putCacheRow(site.projcacheDir, SAFE, CWD, { formatVersion: 2, cwd: 'D:\\stale' });
  const changed = reconcileProjcacheForSession({ sessionsRoot: site.sessionsRoot, projcacheDir: site.projcacheDir, sessionId: SAFE });
  assert.equal(changed, true, 'identity 过期应被修正（只认 v3 日志的旧代码在这里找不到日志）');
  const after = JSON.parse(readFileSync(cache, 'utf8')).record.identity;
  assert.equal(after.cwd, CWD);
  assert.equal(after.formatVersion, 4);
});

console.log(`\nwm 桥接会话 id（转义）回归：${passed}/${passed + failed} 通过`);
if (failures.length > 0) console.error('失败项：' + failures.join(' | '));
process.exit(failed === 0 ? 0 : 1);
