/**
 * wm-delete-log-hygiene.test.mjs — 日志卫生：测试不污染生产日志 + 降噪 + 轮转。
 *
 * 起因（2026-10-28 实际踩到）：新写的几套测试反复 `apply()` 宿主半边，而 apply 会写
 * 真实 `$DSH_HOME\dsh-wm-delete.log`。20 分钟里留下 23 条「已注册」，看起来像
 * "插件被反复重载 320 次"——排查线上问题时会被成批假数据带偏。
 *
 * 这里锁四件事：
 *   1. 测试环境必须把 `DSH_HOME` 指到临时目录（否则真实日志会被写）；
 *   2. 测试写出的记录带 `test: true` 标记（即使指回真实目录也能一眼摘出去）；
 *   3. 「已注册」在同进程内**只写一次**（降噪：以前每次 apply 都写）；
 *   4. 日志超过 4 MiB 会轮转到 `.log.1`（只留一代）。
 *
 * 跑法：node parts/delete/tests/wm-delete-log-hygiene.test.mjs
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 先隔离，再 import 宿主半边：任何模块级路径都必须在隔离之后求值。
const BOOT_HOME = mkdtempSync(join(tmpdir(), 'wm-delete-hygiene-boot-'));
process.env.DSH_HOME = BOOT_HOME;
process.env.WM_DELETE_TEST = '1';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(error && error.message ? error.message : error)}`);
  }
}

/** 新起一个隔离的 DSH_HOME（每个用例用自己的目录，互不干扰）。 */
function freshHome(label) {
  const home = mkdtempSync(join(tmpdir(), `wm-delete-hygiene-${label}-`));
  mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  return home;
}

function readLog(home) {
  const file = join(home, 'dsh-wm-delete.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** 一个什么都不做的假宿主 ctx，只满足 apply 注册路由所需。 */
function fakeCtx() {
  return {
    webServer: { register: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: () => undefined,
  };
}

const hostPath = join(here, '..', 'lib', 'index.js');
const host = await import(pathToFileURL(hostPath).href);
const { apply } = host;

// ---------------------------------------------------------------- 隔离与标记

await check('测试环境：DSH_HOME 已被本文件指到临时目录（绝不写真实日志）', () => {
  const home = process.env.DSH_HOME;
  assert.ok(home, 'DSH_HOME 必须有值');
  assert.ok(
    home.startsWith(tmpdir()) || home.includes('wm-delete-hygiene-'),
    `DSH_HOME 应指向临时目录，实际 ${home}`,
  );
});

await check('测试标记：WM_DELETE_TEST=1 时写出的记录带 test: true', () => {
  const home = freshHome('mark');
  process.env.WM_DELETE_TEST = '1';
  apply(fakeCtx());
  const entries = readLog(home);
  assert.ok(entries.length > 0, 'apply 之后应该有日志');
  for (const entry of entries) {
    assert.equal(entry.test, true, `记录应带 test: true：${JSON.stringify(entry)}`);
  }
});

await check('生产模式：不设 WM_DELETE_TEST 时记录不带 test 字段', () => {
  const home = freshHome('prod');
  delete process.env.WM_DELETE_TEST;
  apply(fakeCtx());
  const entries = readLog(home);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.test, undefined, '生产记录不该带 test 字段');
  }
});

// ---------------------------------------------------------------- 降噪

await check('降噪：同一进程内反复 apply，「已注册」只写一次（以前每次都写）', () => {
  const home = freshHome('once');
  process.env.WM_DELETE_TEST = '1';
  // 连续 apply 5 次，模拟 HMR / 插件开关反复重载
  for (let i = 0; i < 5; i += 1) apply(fakeCtx());
  const registrations = readLog(home).filter((entry) => String(entry.message).includes('已注册'));
  assert.equal(
    registrations.length,
    1,
    `5 次 apply 只应留 1 条「已注册」，实际 ${registrations.length} 条（日志会被刷爆）`,
  );
  // 但版本信息要带上，便于对齐"这条是哪一版写的"
  assert.equal(typeof registrations[0].data?.version, 'string', '注册记录应带 version');
  assert.ok(registrations[0].data.version.length > 0);
});

await check('降噪：卸载仍照常记录（与注册成对，是"真的重载过"的证据）', () => {
  const home = freshHome('dispose');
  process.env.WM_DELETE_TEST = '1';
  const dispose = apply(fakeCtx());
  assert.equal(typeof dispose, 'function', 'apply 应返回卸载函数');
  dispose();
  const unloads = readLog(home).filter((entry) => String(entry.message).includes('已卸载'));
  assert.equal(unloads.length, 1, '卸载必须留一条记录');
});

// ---------------------------------------------------------------- 轮转

await check('轮转：日志超过 4 MiB 时转成 .log.1，现役文件重新变小', () => {
  const home = freshHome('rotate');
  process.env.WM_DELETE_TEST = '1';
  const file = join(home, 'dsh-wm-delete.log');
  // 先造一个超过 4 MiB 的日志（内容不必是合法 JSON，轮转只看体积）
  writeFileSync(file, 'x'.repeat(4 * 1024 * 1024 + 1024), 'utf8');
  const beforeSize = statSync(file).size;
  assert.ok(beforeSize > 4 * 1024 * 1024, `前提：应超过 4 MiB，实际 ${beforeSize}`);
  apply(fakeCtx());
  // 轮转后：.log.1 是旧的大文件，现役文件只有新写的那条
  assert.ok(existsSync(`${file}.1`), '应生成 .log.1');
  const afterSize = statSync(file).size;
  assert.ok(afterSize < 64 * 1024, `轮转后现役文件应变小，实际 ${afterSize} B`);
  const rotated = statSync(`${file}.1`).size;
  assert.equal(rotated, beforeSize, '.log.1 应保留轮转前的大小');
});

await check('轮转只留一代：第二次轮转会覆盖旧的 .log.1', () => {
  const home = freshHome('rotate2');
  process.env.WM_DELETE_TEST = '1';
  const file = join(home, 'dsh-wm-delete.log');
  writeFileSync(file, 'a'.repeat(4 * 1024 * 1024 + 512), 'utf8');
  apply(fakeCtx());
  const firstRotated = statSync(`${file}.1`).size;
  // 再造一个大文件再 apply：注意「已注册」已经被 onceKey 吞掉，所以这里用卸载触发写入
  const dispose = apply(fakeCtx());
  writeFileSync(file, 'b'.repeat(4 * 1024 * 1024 + 256), 'utf8');
  dispose();
  const secondRotated = statSync(`${file}.1`).size;
  assert.notEqual(secondRotated, firstRotated, '第二次轮转应覆盖 .log.1（只留一代）');
});

await check('注册记录里的 version 必须是**本包**版本，不是上游 parts/delete 的 0.1.0', () => {
  const home = freshHome('version');
  process.env.WM_DELETE_TEST = '1';
  apply(fakeCtx());
  const entries = readLog(home).filter((entry) => String(entry.message).includes('已注册'));
  assert.equal(entries.length, 1, `应恰好 1 条注册记录，实际 ${entries.length}`);
  const version = entries[0].data?.version;
  assert.equal(typeof version, 'string');
  // 回归：路径往上退错级数时，会读到 parts/delete/package.json（上游 0.1.0）
  // 或者退到工作区根（没有 package.json，于是 "unknown"）。
  assert.notEqual(version, 'unknown', 'version 不该是 unknown（路径退错目录时就是这样）');
  assert.notEqual(version, '0.1.0', 'version 不该是上游 parts/delete 的 0.1.0');
  assert.match(version, /^\d+\.\d+\.\d+/, `version 应是标准版本号，实际 ${version}`);
});

console.log(`\nwm-delete 日志卫生：${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
