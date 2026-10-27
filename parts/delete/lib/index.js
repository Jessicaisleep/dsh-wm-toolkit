/**
 * dsh-wm-toolkit · 消息删除半边 —— 宿主半边。
 *
 * 两条只接受回环请求的 JSON 路由：
 *
 *   GET  /wm-delete/state?sessionId=<id>
 *   POST /wm-delete/delete   { sessionId, mode, seq?, messageId?, turn? }
 *
 * 一次删除 = 追加**一个** `user/message` 替换事件，携带官方 surface 意图
 * `{ surfaceOp: { op: 'replace', startSeq, endSeq } }` 与完整的被遮蔽节点列表
 * `sourceEventSeqs`。被遮蔽的内容因此不再进入 `deriveMessages()`，而只追加的日志
 * 一个字节都不改写。替换消息的 source 标记为本插件，浏览器半边据此在刷新后重建
 * 「已删除」台账，不需要任何私有旁路状态。
 *
 * 载体为什么是带短标记的 user/message 而不是空事件：
 *   - 官方格式校验把 `system/message` 钉在「打开中的 step」上（无法用于回合外的删除），
 *     并且禁止 `assistant/message` 携带 `sourceEventSeqs`（无法声明被遮蔽节点）；
 *   - 官方 /compact 的检查点用的正是 `user/message` 替换；
 *   - 严格网关会拒绝内容为空的 user 消息（`user message must have content`），
 *     所以载体带一小段标记文本，标记本身不会重放被删掉的内容。
 *
 * 移植自 MIT 社区插件 `dsh-delete-turn`（DDDMUC/dsh-delete-turn v0.1.3）的 src/index.js，
 * 路由前缀、守卫与清理方式改为与本仓库其他半边一致的写法。上游版权见仓库根 NOTICE.md。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_ID,
  PlanError,
  clearedReplyTurns,
  deletableReplyTurns,
  foldSurface,
  hiddenEntriesOfFold,
  isBusy,
  messageIdOf,
  openTurn,
  planRange,
  pluginSource,
  replySegments,
} from './logic.js';

export const name = 'dsh-wm-delete';

/** 只依赖 webServer；sessions / sessionQuery / sessionController / sessionPersistence 在调用时按需解析。 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/wm-delete';

/**
 * 会话 id 的**形状不只有 uuid**。DSH 里外部桥接进来的会话是别的样子，实测两种：
 *
 *   lark-link:dm:oc_2a58…:mujqtyuo8ej7:0      （飞书桥接）
 *   aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A   （agents-anywhere）
 *
 * 早先这里是 `^(session-)?<uuid>$`，于是这类会话的删除请求全被 400 invalid 挡在门外，
 * 而浏览器半边用同一套白名单，连请求都发不出来（表现为「会话未激活」，且宿主无日志）。
 *
 * 现在**不按形状收紧**——形状交给 sessionQuery / sessionController 去认，认不出会明确
 * 回 404/409。这里只保证：非空、长度有界、能安全地当路径用。
 */
const MAX_SESSION_ID_LENGTH = 200;
function isSupportedSessionId(value) {
  if (typeof value !== 'string') return false;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) return false;
  if (id === '.' || id === '..') return false;
  // 会话 id 会被拼进存储路径，绝不能让它穿越目录。
  return !/[\\/\u0000-\u001f\u007f]/.test(id);
}

const MODES = new Set(['message', 'step', 'reply']);

// 生成中删除 = **先停这一轮、再删**。
//
// 官方入口是 sessionController.cancel（它解析出 live Agent 并调
// `agent.cancel({ kind: 'user' }, { keepInbox: true })`），所以排队的输入会保留，
// 只中断正在跑的那一轮。但 cancel 只是**受理**：循环还要继续收尾 —— provider 流被取消、
// 已开始的工具调用按序提交结果、残缺答案以 `interrupted: true` 落地、`turn/end` 追加
// 并 flush。所以必须轮询日志，等这一轮**真的闭合**之后再规划窗口；否则 surface 还会动，
// 规划出来的 seq 立刻过期（表现为随机 stale / 甚至遮蔽到别的节点）。
// 预算从 15s 提到 60s：本机实测（session-8c5d8123，2026-10-27 23:25–23:30）连续 5 次
// 生成中删除都在 15 秒内等不到 `turn/end`，全部落到 `stop-timeout` —— 流式生成 + 工具
// 调用收尾的真实耗时远超上游假设的 15 秒。60 秒覆盖绝大多数收尾；仍超时就明确告诉用户
// "还没停完，可以再试或先手动点停止"，而不是让他对着一个语焉不详的失败发呆。
const STOP_TIMEOUT_MS = 60000;
const STOP_POLL_MS = 250;
let stopWait = { timeoutMs: STOP_TIMEOUT_MS, pollMs: STOP_POLL_MS };

/**
 * 覆盖"先停后删"的等待预算。生产用默认值；测试把它调小，让超时分支跑得便宜。
 * @param options - `{ timeoutMs?, pollMs? }`。
 */
export function configureStopWait(options) {
  stopWait = {
    timeoutMs: options && typeof options.timeoutMs === 'number' ? options.timeoutMs : STOP_TIMEOUT_MS,
    pollMs: options && typeof options.pollMs === 'number' ? options.pollMs : STOP_POLL_MS,
  };
}

// ---------------------------------------------------------------- 日志

/**
 * 日志体积上限。超过就把现役文件轮转成 `.log.1`（只留一代，旧的直接覆盖），再写新行。
 *
 * 为什么需要：这文件是**只追加**的，每次 apply 都会写一条「已注册」，测试还会写进
 * 拒绝记录。实测 3 000+ 行 / 700 KB 里混着成批的测试数据，排查线上问题时非常容易被
 * 带偏（与 0.2.14 给 recall 日志加 4 MiB 轮转是同一个思路）。
 */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * 进程内只写一次的键（降噪：每次 apply 都写「已注册」会把日志刷爆）。
 *
 * 键里带**日志目录**：同一个进程里若 `DSH_HOME` 变了（测试反复改指向、或多 profile
 * 实例），新目录仍然需要它自己的那一条「已注册」——只按消息去重会让那些目录永远空白。
 */
const loggedOnce = new Set();

/**
 * 记录日志的归属目录（`$DSH_HOME`）。
 *
 * **不能**在模块顶层缓存：测试会反复改 `process.env.DSH_HOME` 指向不同的临时目录，
 * 缓存了就会一直往第一次那个目录写（表现：后续用例的日志全空）。
 */
function logHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 本插件版本（首次注册时写进日志，便于对齐「这条记录是哪一版写的」）。 */
const PLUGIN_VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    // 本文件在 `<包根>/parts/delete/lib/index.js`，包根的 package.json 要往上走三级：
    //   lib → parts/delete → parts → <包根>
    // 只走两级会读到 `parts/delete/package.json`（那是**上游**的 0.1.0，不是本包的版本）——
    // 日志里曾经因此记成 "version":"0.1.0"，看起来像"装错了包"。
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 现役日志超过上限就轮转到 `.log.1`（只保留一代）。 */
function rotateLogIfNeeded(file) {
  try {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    /* 轮转失败不阻塞写入 */
  }
}

/**
 * 落盘日志：删除是不可逆操作，失败必须留痕（DSH 宿主日志只看得到 load 失败）。
 *
 * @param next -
 *   `onceKey`：同一进程内相同键只写一次（用于「已注册」这类每次 apply 都会触发、
 *   但内容不变的记录）；
 *   `test`：来自离线测试（测试会设 `WM_DELETE_TEST=1`），写进日志时带 `test: true`，
 *   排查线上问题时一眼能把假数据摘出去。
 */
function logLine(level, message, data, next) {
  try {
    const options = next ?? {};
    const home = logHome();
    if (typeof options.onceKey === 'string') {
      // 键带上日志目录：换了 DSH_HOME 就是"另一个日志文件"，它需要自己的一条记录。
      const key = `${home}\u0000${options.onceKey}`;
      if (loggedOnce.has(key)) return;
      loggedOnce.add(key);
    }
    const file = join(home, 'dsh-wm-delete.log');
    rotateLogIfNeeded(file);
    const record = {
      t: new Date().toISOString(),
      level,
      plugin: PLUGIN_ID,
      message,
      data: data ?? null,
    };
    if (process.env.WM_DELETE_TEST === '1' || options.test === true) record.test = true;
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* 日志失败不影响功能 */
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- 会话解析

// 会话 id 有两种写法：裸 uuid 与 `session-<uuid>`。存储、持久化目录与工作区行
// 对用哪一种并不一致，所以每次查找都试两种。
function idVariants(sessionId) {
  const out = new Set([sessionId]);
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length));
  else out.add(`session-${sessionId}`);
  return [...out];
}

function findLiveSession(ctx, sessionId) {
  let sessions = null;
  try {
    sessions = ctx.get('sessions');
  } catch {
    sessions = null;
  }
  if (!sessions || typeof sessions.get !== 'function') return undefined;
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant);
    if (found) return found;
  }
  return undefined;
}

/**
 * 取到负责这次追加的 live Session。
 * 已经打开的会话直接用；冷会话经官方 controller 恢复——这正是 Web UI 打开会话时做的事。
 */
async function resolveSession(ctx, sessionId) {
  const live = findLiveSession(ctx, sessionId);
  if (live) return live;
  let controller = null;
  try {
    controller = ctx.get('sessionController');
  } catch {
    controller = null;
  }
  if (controller && typeof controller.resolveAgent === 'function') {
    try {
      const result = await controller.resolveAgent(sessionId);
      if (result && result.agent && result.agent.session) return result.agent.session;
    } catch {
      // 落到下面显式的失败分支
    }
  }
  return undefined;
}

function eventsFromLive(session) {
  if (session && typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    } catch {
      // 落到 query 服务
    }
  }
  return undefined;
}

/** 优先经公开 query 服务读取；服务缺席时回落到 live 会话自身的快照。 */
async function readEvents(ctx, sessionId) {
  let query = null;
  try {
    query = ctx.get('sessionQuery');
  } catch {
    query = null;
  }
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId);
      if (snapshot && Array.isArray(snapshot.events)) return snapshot.events;
    } catch {
      // 落到 live 快照
    }
  }
  const events = eventsFromLive(findLiveSession(ctx, sessionId));
  return events ?? null;
}

function surfaceOf(ctx, sessionId, events) {
  const live = findLiveSession(ctx, sessionId);
  const nodes = live && live.surface && Array.isArray(live.surface.nodes) ? live.surface.nodes : undefined;
  return nodes ?? foldSurface(events).nodes;
}

/**
 * `session.append` 返回时事件已在内存里提交，持久化写入器是异步缓冲的。
 * 等一次官方持久化检查点，这样刷新页面或重启 DSH 之后删除依然在。
 * flush 失败不算致命（事件已经提交），但有检查点就等它。
 */
async function flushSession(ctx, session) {
  const errors = [];
  let sessions = null;
  try {
    sessions = ctx.get('sessions');
  } catch {
    sessions = null;
  }
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await Promise.race([sessions.flush(session), new Promise((resolve) => setTimeout(resolve, 5000))]);
      return { flushed: true };
    } catch (error) {
      errors.push(String((error && error.message) || error));
    }
  } else {
    errors.push('sessions.flush unavailable');
  }
  let persistence = null;
  try {
    persistence = ctx.get('sessionPersistence');
  } catch {
    persistence = null;
  }
  if (persistence && typeof persistence.flush === 'function') {
    try {
      await Promise.race([persistence.flush(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      return { flushed: true };
    } catch (error) {
      errors.push(String((error && error.message) || error));
    }
  } else {
    errors.push('sessionPersistence.flush unavailable');
  }
  return { flushed: false, flushError: errors.join(' | ') };
}

// ---------------------------------------------------------------- 操作

async function stateOf(ctx, sessionId) {
  const events = await readEvents(ctx, sessionId);
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id');
  const folded = foldSurface(events);
  const hidden = hiddenEntriesOfFold(folded, events);
  const replyTurns = deletableReplyTurns(events, folded.nodes);
  // 每个可删回合被真人提问切成了几段回复（指令A→回复B→中途补发指令C→回复D 就是 2 段）。
  // 浏览器半边据此在确认框里给出「同时删掉这一轮其它回复段」的选项；只有 1 段的回合不必问。
  const segmentsByTurn = {};
  // 每一段的**段尾节点**（该段最后一个 assistant/message 的 seq）：浏览器半边只在段尾那一行
  // 挂「删除这段回复」按钮——每段恰好一个入口，段中间的行不重复长按钮。
  const segmentTails = [];
  // 每段遮蔽的 surface seq：确认框出现时，浏览器半边据此给"将被删除的段落"加删除线，
  // 让用户在落刀之前**看得见到底删哪些行**（不锁滚动，取消即消失）。
  const segmentWindows = [];
  for (const turn of replyTurns) {
    const segments = replySegments(events, folded.nodes, turn);
    if (segments.length === 0) continue;
    segmentsByTurn[turn] = segments.length;
    for (const segment of segments) {
      // 段尾优先取"最后一个有可见文本的 assistant"（tailSeq）：空文本 assistant 在转录上
      // 是工具卡 / 过程分组，把按钮挂上去就藏进折叠壳里了，表现为"这段没有删除按钮"。
      segmentTails.push(typeof segment.tailSeq === 'number' ? segment.tailSeq : segment.endSeq);
      segmentWindows.push({ turn, startSeq: segment.startSeq, endSeq: segment.endSeq, shadowed: segment.shadowed });
    }
  }
  // surface seq → 该节点的 messageId。官方助手操作条只用 messageId 定位，
  // 浏览器半边要靠这份映射把它换算成"落在哪一段"，否则官方槽点开的确认框划不到线
  // （真机表现：底部按钮删得掉、但没有删除线；用户指令走 seq 所以正常）。
  const messageIdsBySeq = {};
  const byEventSeq = new Map(events.map((event) => [event.seq, event]));
  for (const seq of folded.nodes) {
    const id = messageIdOf(byEventSeq.get(seq));
    if (typeof id === 'string' && id !== '') messageIdsBySeq[seq] = id;
  }
  return {
    hidden,
    // 当前 surface 让浏览器半边能区分「还带着上下文内容的行」与「已被官方压缩移出上下文的行」；
    // replyTurns 再把范围收窄到「确实还有可删回复」的回合。
    surface: folded.nodes,
    replyTurns,
    segmentsByTurn,
    segmentTails,
    segmentWindows,
    messageIdsBySeq,
    // clearedTurns：已经被删空、只剩提问的回合。这些回合里"映射不到 surface 节点"的行
    // （过程分组壳、重试行、中断的工具行）必须按回合号整行收起，否则就是一堆删不掉的壳。
    clearedTurns: clearedReplyTurns(events, folded.nodes, new Set(hidden.map((entry) => entry.seq))),
    live: Boolean(findLiveSession(ctx, sessionId)),
    busy: isBusy(events),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
  };
}

/**
 * 用户在一轮还在生成时点了删除：**停这一轮是这次点击的一部分**。
 *
 * 只停回合，不动压缩（压缩没有"停止"语义，维持原来的 busy 拒绝）。
 * cancel 受理之后轮询日志直到 `turn/end` 落地；超时回 `stop-timeout`，不硬删。
 *
 * @param sessionId - 会话 id（两种写法都会试，与文件里其它查找一致）。
 * @param events - 当前日志（用来判断是"回合未闭合"还是"正在压缩"）。
 */
async function stopActiveTurn(ctx, sessionId, events) {
  if (openTurn(events) === null) {
    throw new HttpError(409, 'busy', 'the session is compacting; wait for it to finish');
  }
  let controller = null;
  try {
    controller = ctx.get('sessionController');
  } catch {
    controller = null;
  }
  if (!controller || typeof controller.cancel !== 'function') {
    throw new HttpError(409, 'busy', 'the running turn cannot be stopped here');
  }
  let acknowledged = false;
  let lastError = null;
  for (const variant of idVariants(sessionId)) {
    try {
      await controller.cancel({ sessionId: variant });
      acknowledged = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!acknowledged) {
    throw new HttpError(409, 'busy', `the stop request was refused: ${String((lastError && lastError.message) || lastError)}`);
  }
  logLine('info', '生成中删除：已请求停止当前回合', { sessionId });
  const deadline = Date.now() + stopWait.timeoutMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, stopWait.pollMs));
    const current = await readEvents(ctx, sessionId);
    if (current && !isBusy(current)) return;
    if (Date.now() >= deadline) {
      throw new HttpError(409, 'stop-timeout', `the running turn did not stop within ${Math.round(stopWait.timeoutMs / 1000)}s`);
    }
  }
}

async function deleteTarget(ctx, sessionId, body) {
  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (!MODES.has(mode)) throw new HttpError(400, 'invalid', 'mode must be message, step or reply');
  const session = await resolveSession(ctx, sessionId);
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-active', 'the session is not open in DSH');
  }
  let events = await readEvents(ctx, sessionId);
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id');
  if (isBusy(events)) {
    // 先停、再删；停止之后**重新读日志**，窗口必须建立在收尾后的 surface 上。
    await stopActiveTurn(ctx, sessionId, events);
    events = await readEvents(ctx, sessionId);
    if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id');
    if (isBusy(events)) throw new HttpError(409, 'busy', 'the session is still working');
  }

  const surfaceNodes = surfaceOf(ctx, sessionId, events);
  let plan;
  try {
    plan = planRange(events, surfaceNodes, {
      mode,
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
      turn: typeof body.turn === 'number' ? body.turn : undefined,
      // scope 只对 reply 有效：'segment'（默认）只删被点的那一段，'turn' 删整轮。
      scope: body.scope === 'turn' ? 'turn' : 'segment',
    });
  } catch (error) {
    if (error instanceof PlanError) {
      const status = error.code === 'not-deletable' ? 400 : 409;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }

  // live surface 才是追加的权威；读到这里之间节点消失，说明别的写入者抢先落地了。
  // reply 模式允许**目标**已经离场（按回合清理残块），但被遮蔽的节点一个都不能少。
  // 多段窗口（回合中途有插话）时逐段校验，任何一段不干净就整单拒绝，不留半成品。
  const windows = Array.isArray(plan.windows) && plan.windows.length > 0
    ? plan.windows
    : [{ startSeq: plan.startSeq, endSeq: plan.endSeq, shadowed: plan.shadowed }];
  for (const window of windows) {
    for (const seq of window.shadowed) {
      if (!surfaceNodes.includes(seq)) throw new HttpError(409, 'stale', 'the session changed, retry');
    }
  }

  const hidden = [];
  const refusals = [];
  const landed = [];
  for (const [index, window] of windows.entries()) {
    let appended;
    try {
      appended = session.append(
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: '[deleted]' }],
          source: pluginSource(),
        },
        {
          surfaceOp: { op: 'replace', startSeq: window.startSeq, endSeq: window.endSeq },
          sourceEventSeqs: window.shadowed,
        },
      );
    } catch (error) {
      // 前几段可能已经落地（那是**真的**删掉了），所以这里不整单失败：记下来，
      // 把已落地的台账照样回报给客户端，剩下的段刷新后可以再删一次。
      const detail = String((error && error.message) || error);
      refusals.push(`window ${index + 1}: ${detail}`);
      logLine('warn', '删除窗口被 surface 拒绝', {
        sessionId,
        mode: plan.mode,
        window: `${index + 1}/${windows.length}`,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
        err: detail,
      });
      continue;
    }
    landed.push({ window, position: index + 1, replacementSeq: appended && appended.seq });
    hidden.push(...window.shadowed.map((seq) => ({ seq, mode: plan.mode })));
  }
  if (hidden.length === 0) {
    throw new HttpError(409, 'stale', `the surface refused the replacement: ${refusals.join(' | ')}`);
  }
  const flush = await flushSession(ctx, session);
  for (const entry of landed) {
    logLine('info', '删除已落地', {
      sessionId,
      mode: plan.mode,
      window: windows.length > 1 ? `${entry.position}/${windows.length}` : null,
      startSeq: entry.window.startSeq,
      endSeq: entry.window.endSeq,
      shadowed: entry.window.shadowed,
      replacementSeq: entry.replacementSeq,
      flushed: flush.flushed,
    });
  }

  // 删除已经落地：用 live 快照立刻重算「已删空的回合」，浏览器半边当场就能把过程壳行
  // （分组标题行、模型重试行）一并收起，不必等 800ms 的防抖刷新。
  const after = eventsFromLive(session) ?? events;
  const afterFolded = foldSurface(after);
  const afterHidden = hiddenEntriesOfFold(afterFolded, after);
  const clearedTurns = clearedReplyTurns(after, afterFolded.nodes, new Set(afterHidden.map((entry) => entry.seq)));

  return {
    replacementSeq: landed[landed.length - 1].replacementSeq,
    ...flush,
    partial: refusals.length > 0,
    hidden,
    clearedTurns,
  };
}

// ---------------------------------------------------------------- HTTP

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

/**
 * 改写模型上下文是破坏性操作，三重守卫：
 *   1. socket 必须来自回环地址；
 *   2. Host 头必须是本机（防 DNS rebinding）；
 *   3. 浏览器带 Origin 时必须是同源。
 */
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' });
    return false;
  }
  const host = req.headers.host;
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' });
      return false;
    }
  }
  return true;
}

function sessionIdFromQuery(url) {
  try {
    const value = new URL(url, 'http://localhost').searchParams.get('sessionId') || '';
    return value.trim();
  } catch {
    return '';
  }
}

function requireSessionId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new HttpError(400, 'invalid', 'sessionId required');
  if (!isSupportedSessionId(id)) throw new HttpError(400, 'invalid', 'unsupported session id');
  return id;
}

// ---------------------------------------------------------------- 插件

export function apply(ctx) {
  const disposers = [];

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' });
        return;
      }
      // 记**原始** id（不校验）：非法 id 正是最需要留痕的情况，而这个插件当初把
      // uuid 当唯一合法形状，害得排查时连"是哪个会话"都看不到。
      const rawSessionId = sessionIdFromQuery(req.url);
      try {
        const sessionId = requireSessionId(rawSessionId);
        sendJson(res, 200, { ok: true, ...(await stateOf(ctx, sessionId)) });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal';
        logLine(status >= 500 ? 'error' : 'warn', '/wm-delete/state 失败', {
          code,
          sessionId: rawSessionId.slice(0, 200),
          err: String((error && error.message) || error),
        });
        sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) });
      }
    },
  }));

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/delete`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' });
        return;
      }
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' });
        return;
      }
      const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      try {
        const sessionId = requireSessionId(rawSessionId);
        sendJson(res, 200, { ok: true, ...(await deleteTarget(ctx, sessionId, body)) });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal';
        logLine(status >= 500 ? 'error' : 'warn', '/wm-delete/delete 被拒绝', {
          code,
          sessionId: rawSessionId.trim().slice(0, 200),
          err: String((error && error.message) || error),
        });
        sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) });
      }
    },
  }));

  // 降噪：「已注册」内容每次 apply 都一样，只在**本进程第一次**写。
  // 以前每次 apply 都写一条，一天几十次重载就把日志刷成了流水账（实测 3 000+ 行里
  // 绝大多数是这条）。版本随记录一起写，方便对齐"这条是哪一版留下的"。
  logLine(
    'info',
    '消息删除半边已注册（/wm-delete/state、/wm-delete/delete）',
    { version: PLUGIN_VERSION },
    { onceKey: `registered:${PLUGIN_VERSION}` },
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    // 卸载不算噪声：它与注册成对出现，是排查"HMR 是否真的重载过"的关键证据。
    logLine('info', '消息删除半边已卸载', null);
  };
}
