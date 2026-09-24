/**
 * run-all.mjs — 一次跑完各个半边的离线测试。
 *
 * 半边的测试留在各自目录（parts/recall/tests、parts/manager/tests、parts/delete/tests），
 * 本脚本只负责依次执行并汇总。
 * 用 DSH 自带的 Node 跑：先设 ELECTRON_RUN_AS_NODE=1，再执行本文件。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  { label: 'recall · 编辑/重生成核心', file: join(here, '..', 'parts', 'recall', 'tests', 'wm-assistant-edit.test.mjs') },
  { label: 'recall · fork 复活队列清理（纯逻辑）', file: join(here, '..', 'parts', 'recall', 'tests', 'purge-resurrected-queue.test.mjs') },
  { label: 'recall · fork 复活队列清理（宿主集成）', file: join(here, '..', 'parts', 'recall', 'tests', 'purge-queue-host.test.mjs') },
  { label: 'manager · 会话迁移核心', file: join(here, '..', 'parts', 'manager', 'tests', 'wm-relocate.test.mjs') },
  { label: 'manager · 孤儿投影缓存清理（损坏会话删不掉）', file: join(here, '..', 'parts', 'manager', 'tests', 'purge-orphan-projcache.test.mjs') },
  { label: 'manager · 投影缓存 identity 对账', file: join(here, '..', 'parts', 'manager', 'tests', 'reconcile-projcache-identity.test.mjs') },
  { label: 'manager · 宿主冒烟', file: join(here, '..', 'parts', 'manager', 'tests', 'smoke-host.cjs') },
  { label: 'delete · 删除逻辑核心', file: join(here, '..', 'parts', 'delete', 'tests', 'wm-delete-logic.test.mjs') },
  { label: 'delete · 宿主集成（含官方 surface 契约验收）', file: join(here, '..', 'parts', 'delete', 'tests', 'wm-delete-host.test.mjs') },
  { label: 'delete · 浏览器半边冒烟', file: join(here, '..', 'parts', 'delete', 'tests', 'wm-delete-client.smoke.mjs') },
  { label: 'delete · 按钮位置回归（迷你 DOM）', file: join(here, '..', 'parts', 'delete', 'tests', 'wm-delete-placement.test.mjs') },
];

let failed = 0;
for (const { label, file } of suites) {
  if (!existsSync(file)) { console.log(`\n=== ${label} ===\n  跳过（不存在：${file}）`); continue; }
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}
console.log(`\n汇总：${suites.length - failed}/${suites.length} 套通过`);
process.exit(failed === 0 ? 0 : 1);
