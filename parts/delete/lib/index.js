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
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_ID, PlanError, deletableReplyTurns, foldSurface, hiddenEntriesOfFold, isBusy, planRange, pluginSource } from './logic.js';

export const name = 'dsh-wm-delete';

/** 只依赖 webServer；sessions / sessionQuery / sessionController / sessionPersistence 在调用时按需解析。 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/wm-delete';
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['message', 'step', 'reply']);

// ---------------------------------------------------------------- 日志

/** 落盘日志：删除是不可逆操作，失败必须留痕（DSH 宿主日志只看得到 load 失败）。 */
function logLine(level, message, data) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    appendFileSync(
      join(home, 'dsh-wm-delete.log'),
      JSON.stringify({ t: new Date().toISOString(), level, plugin: PLUGIN_ID, message, data: data ?? null }) + '\n',
      'utf8',
    );
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
  return {
    hidden: hiddenEntriesOfFold(folded, events),
    // 当前 surface 让浏览器半边能区分「还带着上下文内容的行」与「已被官方压缩移出上下文的行」；
    // replyTurns 再把范围收窄到「确实还有可删回复」的回合。
    surface: folded.nodes,
    replyTurns: deletableReplyTurns(events, folded.nodes),
    live: Boolean(findLiveSession(ctx, sessionId)),
    busy: isBusy(events),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
  };
}

async function deleteTarget(ctx, sessionId, body) {
  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (!MODES.has(mode)) throw new HttpError(400, 'invalid', 'mode must be message, step or reply');
  const session = await resolveSession(ctx, sessionId);
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-active', 'the session is not open in DSH');
  }
  const events = await readEvents(ctx, sessionId);
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id');
  if (isBusy(events)) throw new HttpError(409, 'busy', 'the session is still working');

  const surfaceNodes = surfaceOf(ctx, sessionId, events);
  let plan;
  try {
    plan = planRange(events, surfaceNodes, {
      mode,
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
      turn: typeof body.turn === 'number' ? body.turn : undefined,
    });
  } catch (error) {
    if (error instanceof PlanError) {
      const status = error.code === 'not-deletable' ? 400 : 409;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }

  // live surface 才是追加的权威；读到这里之间节点消失，说明别的写入者抢先落地了。
  for (const seq of plan.shadowed) {
    if (!surfaceNodes.includes(seq)) throw new HttpError(409, 'stale', 'the session changed, retry');
  }

  let replacement;
  try {
    replacement = session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '[deleted]' }],
        source: pluginSource(),
      },
      {
        surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
        sourceEventSeqs: plan.shadowed,
      },
    );
  } catch (error) {
    throw new HttpError(409, 'stale', `the surface refused the replacement: ${String((error && error.message) || error)}`);
  }
  const flush = await flushSession(ctx, session);
  logLine('info', '删除已落地', {
    sessionId,
    mode: plan.mode,
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    shadowed: plan.shadowed,
    replacementSeq: replacement && replacement.seq,
    flushed: flush.flushed,
  });

  return {
    replacementSeq: replacement && replacement.seq,
    ...flush,
    hidden: plan.shadowed.map((seq) => ({ seq, mode: plan.mode })),
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
  if (!value) throw new HttpError(400, 'invalid', 'sessionId required');
  if (!SESSION_ID_RE.test(value)) throw new HttpError(400, 'invalid', 'invalid session id');
  return value;
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
      try {
        const sessionId = requireSessionId(sessionIdFromQuery(req.url));
        sendJson(res, 200, { ok: true, ...(await stateOf(ctx, sessionId)) });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal';
        logLine(status >= 500 ? 'error' : 'warn', '/wm-delete/state 失败', { code, err: String((error && error.message) || error) });
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
      try {
        const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '');
        sendJson(res, 200, { ok: true, ...(await deleteTarget(ctx, sessionId, body)) });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal';
        logLine(status >= 500 ? 'error' : 'warn', '/wm-delete/delete 被拒绝', {
          code,
          err: String((error && error.message) || error),
        });
        sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) });
      }
    },
  }));

  logLine('info', '消息删除半边已注册（/wm-delete/state、/wm-delete/delete）', null);

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    logLine('info', '消息删除半边已卸载', null);
  };
}
