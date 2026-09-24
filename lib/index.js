/**
 * dsh-wm-toolkit — 宿主半边（**生成物**：改 parts/ 后运行 node build.mjs，勿直接编辑本文件）。
 *
 * 组合方式：导入各半边的模块，依次调用它们的 apply(ctx)。任何一半抛错都只记日志、
 * 不影响另一半（只有全部半边都失败才抛出，让 DSH 明确报错而不是静默半死）。
 *
 * 各半边的模块标识符（inject）取并集：召回侧需要 settings/storageDomain/agentPresets 等，
 * 管理侧需要 workspaceRegistry/agents/sessionPersistence 等，删除侧只需要 webServer。
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';

import * as recallHalf from '../parts/recall/lib/index.js';
import * as managerHalf from '../parts/manager/lib/index.js';
import * as deleteHalf from '../parts/delete/lib/index.js';

export const name = 'dsh-wm-toolkit';

const HALVES = [
  ['recall', recallHalf],
  ['manager', managerHalf],
  ['delete', deleteHalf],
];

export const inject = Array.from(new Set(
  HALVES.flatMap(([, half]) => (Array.isArray(half.inject) ? half.inject : [])),
));

/** 落盘日志（插件自身的失败必须能被看见：DSH 的宿主日志里只会看到 load 失败）。 */
function logLine(message, data) {
  try {
    const home = process.env.DSH_HOME || joinPath(homedir(), '.dsh');
    appendFileSync(joinPath(home, 'dsh-wm-toolkit.log'), JSON.stringify({
      t: new Date().toISOString(), level: 'info', plugin: 'dsh-wm-toolkit', message, data: data ?? null,
    }) + '\n', 'utf8');
  } catch { /* 日志失败不影响功能 */ }
}

export function apply(ctx) {
  const failures = [];
  for (const [label, half] of HALVES) {
    if (half === undefined || typeof half.apply !== 'function') {
      failures.push(label + ': 没有可用的 apply 导出');
      logLine('半边缺少 apply', { half: label });
      continue;
    }
    try {
      half.apply(ctx);
      logLine('半边已应用', { half: label });
    } catch (error) {
      const detail = String(error?.stack ?? error?.message ?? error).slice(0, 1600);
      failures.push(label + ': ' + String(error?.message ?? error));
      logLine('半边应用失败（已隔离）', { half: label, detail });
    }
  }
  if (failures.length === HALVES.length) {
    throw new Error('dsh-wm-toolkit: 全部半边都未能加载 — ' + failures.join(' | '));
  }
  if (failures.length > 0) logLine('部分半边未加载（其余功能正常）', { failures });
}
