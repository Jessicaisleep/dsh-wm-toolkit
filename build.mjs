/**
 * build.mjs — 把 parts/ 下的各个"半边"组合成**一个插件**的产物。
 *
 * 产物：
 *   lib/index.js   —— 宿主半边：导入各半边的 apply 并依次调用（各自独立，互不牵连）
 *   lib/client.js  —— 浏览器半边：**一次** __ModuleLoader__.load()，工厂内部把各半边各自
 *                     包进一个 IIFE（保持各自的变量作用域，避免同名冲突）
 *
 * 为什么不直接合并源码：半边各自有几百个顶层标识符（log / TEXT / apply …），
 * 手写合并极易撞名。这里只做"搬运 + 包裹"，半边的代码**逐字节不变**，
 * 以后要改就改 parts/ 下的文件，然后重跑本脚本。
 *
 * 用法：node build.mjs（或先设 ELECTRON_RUN_AS_NODE=1 用 DSH 自带 Node 跑）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'lib');
mkdirSync(outDir, { recursive: true });

const PKG = 'dsh-wm-toolkit';
const HALVES = [
  { key: 'recall', dir: join(here, 'parts', 'recall'), label: '消息撤回/编辑（含编辑我的回复、↻ 重新生成）' },
  { key: 'manager', dir: join(here, 'parts', 'manager'), label: '会话/工作区管理（含工作区真迁移）' },
  { key: 'delete', dir: join(here, 'parts', 'delete'), label: '消息删除（按条删指令/回复、按步骤删思考与工具调用）' },
];

// ---------------------------------------------------------------- 宿主半边

const hostSource = `/**
 * ${PKG} — 宿主半边（**生成物**：改 parts/ 后运行 node build.mjs，勿直接编辑本文件）。
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

export const name = '${PKG}';

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
    appendFileSync(joinPath(home, '${PKG}.log'), JSON.stringify({
      t: new Date().toISOString(), level: 'info', plugin: '${PKG}', message, data: data ?? null,
    }) + '\\n', 'utf8');
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
    throw new Error('${PKG}: 全部半边都未能加载 — ' + failures.join(' | '));
  }
  if (failures.length > 0) logLine('部分半边未加载（其余功能正常）', { failures });
}
`;

// ---------------------------------------------------------------- 浏览器半边

/** 取出一个 client 文件里 factory 的函数体（不含最外层那对花括号）。兼容 LF / CRLF。 */
function factoryBodyOf(source, label) {
  const marker = source.indexOf('factory:');
  if (marker < 0) throw new Error(`${label}: 找不到 factory`);
  const braceStart = source.indexOf('{', marker);
  if (braceStart < 0) throw new Error(`${label}: 找不到工厂起始大括号`);
  // 文件尾部形如 `  }\n});`（LF 或 CRLF）：`});` 之前那个 `}` 就是工厂的收尾大括号。
  // 工厂后面跟一个尾逗号（`  },\n});`）也接受——上游 bundle 两种写法都有。
  const loadTail = source.lastIndexOf('});');
  if (loadTail < 0) throw new Error(`${label}: 找不到 load() 收尾`);
  let i = loadTail - 1;
  while (i > braceStart && /\s/.test(source[i])) i -= 1;
  if (source[i] === ',') {
    i -= 1;
    while (i > braceStart && /\s/.test(source[i])) i -= 1;
  }
  if (source[i] !== '}') throw new Error(`${label}: 工厂收尾大括号定位失败`);
  const body = source.slice(braceStart + 1, i);
  if (!body.includes('apply')) throw new Error(`${label}: 工厂体里看不到 apply`);
  return body;
}

const halves = HALVES.map(({ key, dir, label }) => {
  const source = readFileSync(join(dir, 'lib', 'client.js'), 'utf8');
  const loads = source.split('__ModuleLoader__.load(').length - 1;
  if (loads !== 1) throw new Error(`${key}: 期望恰好一次 load()，实际 ${loads} 次`);
  return { key, label, body: factoryBodyOf(source, key) };
});

const clientSource = `/**
 * ${PKG} — 浏览器半边（**生成物**：改 parts/ 后运行 node build.mjs，勿直接编辑本文件）。
 *
 * 一次 load()，工厂内部把各半边各自包进 IIFE 后取它们的插件面（{name, inject, apply}）：
 * 半边保持各自的变量作用域，不需要改动任何一行原有代码，也不会撞名。
 * 应用时的隔离与宿主半边一致：一半抛错只影响那一半。
 */
window.__ModuleLoader__.load({
  id: "${PKG}",
  factory: function (require) {
    var halfFactories = [];

${halves.map(({ key, label, body }) => `    // ======== ${key}：${label} ========
    halfFactories.push(function () {
${body}
    });`).join('\n\n')}

    var faces = [];
    for (var i = 0; i < halfFactories.length; i++) {
      try {
        var face = halfFactories[i]();
        if (face && typeof face.apply === "function") faces.push(face);
      } catch (eHalf) {
        try { console.error("[${PKG}] 半边工厂执行失败", i, eHalf); } catch (eLog) { /* ignore */ }
      }
    }
    var inject = [];
    faces.forEach(function (face) {
      (face.inject || []).forEach(function (service) {
        if (inject.indexOf(service) < 0) inject.push(service);
      });
    });
    return {
      name: "${PKG}",
      inject: inject,
      apply: function (ctx) {
        var failures = [];
        faces.forEach(function (face) {
          try { face.apply(ctx); } catch (eApply) {
            failures.push(String(face.name || "half") + ": " + String(eApply && eApply.message ? eApply.message : eApply));
            try { console.error("[${PKG}] 半边应用失败（已隔离）", face.name, eApply); } catch (eLog2) { /* ignore */ }
          }
        });
        if (faces.length > 0 && failures.length === faces.length) {
          throw new Error("${PKG}: 浏览器半边全部未能加载 — " + failures.join(" | "));
        }
      }
    };
  }
});
`;

writeFileSync(join(outDir, 'index.js'), hostSource, 'utf8');
writeFileSync(join(outDir, 'client.js'), clientSource, 'utf8');

const clientLoads = clientSource.split('__ModuleLoader__.load(').length - 1;
console.log(`已生成 lib/index.js（${hostSource.length} 字节）`);
console.log(`已生成 lib/client.js（${clientSource.length} 字节，load 调用 ${clientLoads} 次，半边 ${halves.length} 个：${halves.map((h) => h.key).join(' + ')}）`);
