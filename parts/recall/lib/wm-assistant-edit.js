/**
 * wm-assistant-edit — 改写「我的回复」（助手消息）文本。
 *
 * 设计沿用 dsh-session-manager-wm 中已验证过的会话工件读改写路径：
 *   readSessionArtifact → 按行拆分 → 改一行 JSON → encodeArtifact → 临时文件 + 原子 rename 发布
 * 区别只在于被改的那一行不是 header，而是某个 `assistant/message` 事件。
 *
 * 使用前提（由 client 保证）：目标会话必须是**冷态**子会话——先在父会话上按
 * 「目标回合的 turn/end」fork 出子会话，再在打开它之前调用本模块改写。原因：
 * 运行中的会话由 live writer 持有追加句柄，原子 rename 会让句柄指向被替换掉的旧文件，
 * 之后的追加全部丢失。因此活动会话一律先 flush，改写后 invalidate 宿主 preparation，
 * 并回报 wasLive（client 需重新打开该会话才能看到新文本）。
 *
 * 语义：编辑回复只影响该回合之后的对话——fork 边界就是目标回合自己的 turn/end，
 * 因此该回合之后的全部内容都会留在旧会话里（与「编辑我的消息」一致）。
 */

import { readFile, readdir, stat, open, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';

export const NL = String.fromCharCode(10);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ---------------------------------------------------------------- 纯函数（可离线测试）

/** 把 zstd 多帧工件解成完整文本（DSH 每批写一帧，必须逐帧解）。 */
export function decodeArtifactBuffer(buffer, filename) {
  if (!String(filename || '').endsWith('.zstd')) return buffer.toString('utf8');
  const plaintexts = [];
  let pos = 0;
  while (pos < buffer.length) {
    const next = buffer.indexOf(ZSTD_MAGIC, pos);
    if (next < 0) break;
    let text = null;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(next));
    } catch {
      break;
    }
    plaintexts.push(text);
    pos = next + 4;
  }
  if (plaintexts.length === 0) throw new Error('zstd 工件里没有可解帧');
  return Buffer.concat(plaintexts).toString('utf8');
}

/** 以 DSH 自己的物理布局编码：第一帧恰好是 header 行，其余合成一帧。 */
export function encodeArtifactSync(headerLine, rest, isZstd) {
  if (!isZstd) return Buffer.from(`${headerLine}${NL}${rest}`, 'utf8');
  if (typeof zlib.zstdCompressSync !== 'function') throw new Error('当前 Node 运行时没有 zstd 支持');
  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${headerLine}${NL}`, 'utf8'));
  if (rest === '') return headerFrame;
  return Buffer.concat([headerFrame, zlib.zstdCompressSync(Buffer.from(rest, 'utf8'))]);
}

/**
 * content 里最后一块指定类型（text / reasoning）的文本；没有则 null。
 * 借鉴社区 dsh-message-edit 的 `isTextualBlock`：思考块与正文一样可编辑。
 */
export function blockTextOf(event, kind = 'text') {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block && block.type === kind && typeof block.text === 'string') return block.text;
  }
  return null;
}

/** 兼容旧调用：最后一段正文。 */
export function assistantTextOf(event) { return blockTextOf(event, 'text'); }

/** content 里指定类型块的索引（默认最后一块）；没有则 -1。 */
export function blockIndexOf(event, kind = 'text') {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return -1;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block && block.type === kind && typeof block.text === 'string') return i;
  }
  return -1;
}

/** 规范化 blockKind：只认 text / reasoning（其余按 text 处理）。 */
function normalizeBlockKind(kind) { return kind === 'reasoning' ? 'reasoning' : 'text'; }

/**
 * 定位要改的那一行。优先级：messageId（最稳，来自 `data.message.id`）
 * → 精确 seq → 该 turn 内最后一条带文本的回复 / oldText 匹配。
 * @returns {{index: number, event: object, text: string} | {error: string, message: string}}
 */
export function locateAssistantLine(lines, options) {
  const { targetSeq, turn, oldText, messageId } = options;
  const candidates = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') continue;
    let event;
    try { event = JSON.parse(lines[index]); } catch { continue; }
    if (event?.type !== 'assistant/message') continue;
    const text = assistantTextOf(event);
    if (text === null) continue;
    candidates.push({ index, event, text, mid: event?.data?.message?.id });
  }
  if (candidates.length === 0) return { error: 'no-assistant-text', message: '该会话里没有可编辑的助手回复' };

  // messageId 最稳：来自 `data.message.id`，与 chat 投影的 finalNode.messageId 同源。
  if (typeof messageId === 'string' && messageId.length > 0) {
    const byId = candidates.find((c) => c.mid === messageId);
    if (byId !== undefined) return { index: byId.index, event: byId.event, text: byId.text };
  }
  if (typeof targetSeq === 'number') {
    const exact = candidates.find((c) => c.event.seq === targetSeq);
    if (exact !== undefined) return { index: exact.index, event: exact.event, text: exact.text };
  }
  let pool = candidates;
  if (typeof turn === 'number') {
    const inTurn = candidates.filter((c) => c.event?.data?.turn === turn);
    if (inTurn.length > 0) pool = inTurn;
  }
  if (typeof oldText === 'string' && oldText.length > 0) {
    const same = pool.filter((c) => c.text === oldText);
    if (same.length > 0) return { index: same[same.length - 1].index, event: same[same.length - 1].event, text: same[same.length - 1].text };
  }
  const last = pool[pool.length - 1];
  return { index: last.index, event: last.event, text: last.text };
}

/**
 * 生成改好一行之后的新工件字节。
 * @returns {{bytes: Buffer, replacedSeq: number, turn: number|undefined, oldText: string, textCount: number}}
 */
export function rewriteAssistantArtifact(buffer, options) {
  const { filename, targetSeq, turn, oldText, newText, replaceAllTextInMessage, messageId, blockKind, blockIndex } = options;
  if (typeof newText !== 'string') throw new Error('newText 必须是字符串');
  const content = decodeArtifactBuffer(buffer, filename);
  const lines = content.split(NL);
  if (lines.length < 2) throw new Error('会话工件没有事件行');
  let header;
  try { header = JSON.parse(lines[0]); } catch { throw new Error('会话 header 解析失败'); }

  const found = locateAssistantLine(lines, { targetSeq, turn, oldText, messageId });
  if (found.error !== undefined) { const e = new Error(found.message); e.code = found.error; throw e; }

  const event = found.event;
  const blocks = event.data.message.content;
  const kind = normalizeBlockKind(blockKind);
  const kindIndexes = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i].type === kind && typeof blocks[i].text === 'string') kindIndexes.push(i);
  }
  if (kindIndexes.length === 0) { const e = new Error(`目标事件没有 ${kind} 块`); e.code = kind === 'text' ? 'no-text' : 'no-block'; throw e; }
  const targets = Number.isSafeInteger(blockIndex) && kindIndexes.includes(blockIndex)
    ? [blockIndex]
    : (replaceAllTextInMessage === true ? kindIndexes : [kindIndexes[kindIndexes.length - 1]]);
  for (const i of targets) blocks[i] = { ...blocks[i], text: newText };

  lines[found.index] = JSON.stringify(event);
  // 自检：改完之后这一行必须能解析且文本已生效
  const check = JSON.parse(lines[found.index]);
  const verified = targets.every((i) => check?.data?.message?.content?.[i]?.text === newText);
  if (!verified) throw new Error('改写自检失败');

  const replacement = lines.join(NL);
  const firstNewline = replacement.indexOf(NL);
  const bytes = encodeArtifactSync(replacement.slice(0, firstNewline), replacement.slice(firstNewline + 1), String(filename).endsWith('.zstd'));
  return {
    bytes,
    replacedSeq: typeof event.seq === 'number' ? event.seq : null,
    turn: event?.data?.turn,
    oldText: found.text,
    blockKind: kind,
    blockIndex: targets[targets.length - 1],
    textCount: targets.length,
    lineIndex: found.index,
    lineCount: lines.length,
    eventCount: lines.length - 1,
  };
}

// ---------------------------------------------------------------- 宿主集成

/** 复制自 manager 分叉：读一份会话工件原文（先走 persistence，再回落磁盘扫描）。 */
export async function readSessionArtifact(ctx, sessionId, signal) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence !== undefined && typeof persistence.readRaw === 'function') {
    try {
      const raw = await persistence.readRaw(sessionId, signal);
      if (raw !== undefined) {
        const located = typeof persistence.locate === 'function' ? persistence.locate(raw.meta) : undefined;
        if (located?.path !== undefined) {
          try {
            if ((await stat(located.path)).isFile()) return { ...raw, path: located.path };
          } catch { /* 定位结果过期，落到磁盘扫描 */ }
        } else {
          return { ...raw };
        }
      }
    } catch { /* fall through */ }
  }
  const dshHomePath = ctx.get('dshHomePath');
  if (typeof dshHomePath !== 'function') return undefined;
  const root = dshHomePath('sessions');
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return undefined; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = join(root, proj.name);
    let entries;
    try { entries = await readdir(projDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name !== sessionId) continue;
      for (const filename of ['session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
        const filePath = join(projDir, entry.name, filename);
        try {
          const buffer = await readFile(filePath);
          const content = decodeArtifactBuffer(buffer, filename);
          const headerLine = content.split(NL, 1)[0];
          let meta;
          try { meta = JSON.parse(headerLine); } catch { continue; }
          if (typeof meta?.id !== 'string' || meta.id !== sessionId) continue;
          return { meta, filename, content, path: filePath };
        } catch { /* keep scanning */ }
      }
    }
  }
  return undefined;
}

/**
 * 在活动会话的内存事件里找到指定 seq 的事件对象。
 * Session 的公开面是 eventAt(seq) / snapshotEvents()；不同版本还暴露 events / log 数组，逐个兜底。
 */
function findLiveEvent(liveSession, seq) {
  if (typeof liveSession?.eventAt === 'function') {
    try {
      const found = liveSession.eventAt(seq);
      if (found !== undefined && found !== null) return found;
    } catch { /* seq 可能带品牌校验，落到数组查找 */ }
  }
  for (const key of ['events', 'log']) {
    const list = liveSession?.[key];
    if (Array.isArray(list)) {
      const found = list.find((e) => e && e.seq === seq);
      if (found !== undefined) return found;
    }
  }
  if (typeof liveSession?.snapshotEvents === 'function') {
    try {
      const list = liveSession.snapshotEvents();
      if (Array.isArray(list)) {
        const found = list.find((e) => e && e.seq === seq);
        if (found !== undefined) return found;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * 把改写同步进活动会话的内存事件。
 *
 * 为什么必须做：fork 出来的子会话**在 fork 那一刻就已经是活动会话**（实测 wasLive=true），
 * 渲染端的消息来自活动会话的事件流，只改磁盘不改内存，界面永远是旧文本。
 * 内存与磁盘改成同一份内容后，后续打开/翻页/继续对话拿到的都是新文本。
 *
 * @returns {boolean|null} true=已同步且自检通过；false=尝试过但不一致；null=取不到事件对象
 */
export function patchLiveEventText(liveSession, seq, newText, replaceAllTextInMessage, log) {
  let target;
  try { target = findLiveEvent(liveSession, seq); } catch (e) { log('warn', 'assistant-edit', '读取活动事件失败', { err: String(e?.message ?? e) }); }
  if (target === undefined) return null;
  const blocks = target?.data?.message?.content;
  if (!Array.isArray(blocks)) return null;
  const indexes = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i].type === 'text' && typeof blocks[i].text === 'string') indexes.push(i);
  }
  if (indexes.length === 0) return null;
  const use = replaceAllTextInMessage === true ? indexes : [indexes[indexes.length - 1]];
  const next = blocks.slice();
  for (const i of use) next[i] = { ...blocks[i], text: newText };
  try {
    target.data.message.content = next; // 整体替换（对象可能被冻结 → 抛错后走原地改）
  } catch {
    try {
      for (const i of use) blocks[i] = { ...blocks[i], text: newText };
    } catch (e2) {
      log('warn', 'assistant-edit', '内存事件写入失败（可能被冻结）', { err: String(e2?.message ?? e2) });
      return false;
    }
  }
  const after = findLiveEvent(liveSession, seq);
  return assistantTextOf(after) === newText;
}

async function writeTempFile(finalPath, data) {
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * 把一条助手回复的文本改掉（原子发布）。
 * 调用方负责保证：这是刚 fork 出来、尚未打开的冷态子会话。
 */
export async function editAssistantText(ctx, log, options) {
  const { sessionId, targetSeq, turn, oldText, newText, replaceAllTextInMessage, messageId } = options;
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) throw new Error('sessionPersistence 服务不可用');
  const coordinator = persistence.coordinator;
  const serialize = typeof coordinator?.serialize === 'function'
    ? (operation) => coordinator.serialize(sessionId, operation)
    : (operation) => operation();

  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession !== undefined) {
    // 活动会话：先落盘再改写；改写后内存里仍是旧文本，所以必须 invalidate preparation，
    // 让下一次打开重新从磁盘读。client 侧收到 wasLive=true 会重新打开目标会话。
    try { await ctx.sessions.flush(liveSession); } catch { /* best-effort */ }
  }

  return await serialize(async () => {
    const raw = await readSessionArtifact(ctx, sessionId);
    if (raw === undefined) { const e = new Error(`会话 ${sessionId} 没有可读工件`); e.code = 'no-artifact'; throw e; }
    const artifactPath = raw.path ?? persistence.locate?.(raw.meta)?.path;
    if (typeof artifactPath !== 'string') throw new Error('无法定位会话工件路径');

    const original = await readFile(artifactPath);
    const result = rewriteAssistantArtifact(original, { filename: raw.filename ?? artifactPath, targetSeq, turn, oldText, newText, replaceAllTextInMessage, messageId });

    // 安全网：首次改写该会话前留一份可读备份（解码后的 JSONL 明文）。
    let backupPath = null;
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh');
      const dir = join(home, 'dsh-message-recall-wm', 'assistant-backups');
      await mkdir(dir, { recursive: true });
      backupPath = join(dir, `${sessionId}.jsonl`);
      try { await stat(backupPath); } catch { await writeFile(backupPath, raw.content ?? decodeArtifactBuffer(original, raw.filename ?? artifactPath), 'utf8'); }
    } catch (err) {
      log('warn', 'assistant-edit', '备份写入失败（继续改写）', { err: String(err?.message ?? err) });
      backupPath = null;
    }

    const tempPath = await writeTempFile(artifactPath, result.bytes);
    const hiddenPath = `${artifactPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await rename(artifactPath, hiddenPath);
      await rename(tempPath, artifactPath);
    } catch (error) {
      try { await rm(artifactPath, { force: true }); } catch { /* best-effort */ }
      try { await rename(hiddenPath, artifactPath); } catch { /* 下面统一报错 */ }
      try { await rm(tempPath, { force: true }); } catch { /* best-effort */ }
      throw new Error(`改写发布失败：${String(error?.message ?? error)}`);
    }
    try { await rm(hiddenPath, { force: true }); } catch { /* best-effort */ }

    // 落盘自检：重新读一遍，确认目标事件文本已经是新值。
    try {
      const after = await readSessionArtifact(ctx, sessionId);
      const lines = String(after?.content ?? '').split(NL);
      const found = locateAssistantLine(lines, { targetSeq: result.replacedSeq, turn: result.turn, oldText: newText });
      if (found.error !== undefined || found.text !== newText) throw new Error(found.error ?? '文本不一致');
    } catch (error) {
      log('warn', 'assistant-edit', '落盘自检未通过（磁盘可能仍是旧文本）', { err: String(error?.message ?? error) });
    }

    // ---- 活动会话的内存事件改不动（DSH 事件消息 deepFreeze）----
    // 注意：**绝不卸载活动会话**（detach 会把该行从运行时与客户端列表里摘掉，客户端随后
    // sessions.select 报 unknown session、切换卡死、< > 失效，分支工件还可能被后续清理）。
    // 主路径是 /bubble/assistant-branch：建分支时就用改好的种子，从根上没有内存副本问题。
    // 本路由只作为既有子会话的修复工具：磁盘会被改成新文本，界面刷新后可见。
    let memoryPatched = null;
    if (liveSession !== undefined) {
      memoryPatched = patchLiveEventText(liveSession, result.replacedSeq, newText, replaceAllTextInMessage === true, log);
      try { coordinator?.preparations?.invalidate?.(sessionId); } catch { /* best-effort */ }
      if (memoryPatched !== true) {
        log('warn', 'assistant-edit', '活动会话内存副本未同步（界面刷新后可见；主路径请用 assistant-branch）', { sessionId, memoryPatched });
      }
    }

    log('info', 'assistant-edit', '助手回复已改写', {
      sessionId, seq: result.replacedSeq, turn: result.turn, chars: newText.length,
      wasLive: liveSession !== undefined, memoryPatched, backupPath,
    });
    return {
      replacedSeq: result.replacedSeq,
      turn: result.turn,
      oldTextLength: result.oldText.length,
      textCount: result.textCount,
      wasLive: liveSession !== undefined,
      memoryPatched,
      backupPath,
    };
  });
}

/**
 * 解析编辑器边界：边界 = 目标回复所在回合**自己的** turn/end（子会话保留该回合）。
 *
 * 定位优先级：messageId（chat 槽位直接给的 `props.messageId`，与 `data.message.id` 同源，最稳）
 * → targetSeq → turn（该回合最后一条带文本的回复）。
 *
 * @param {object} optsOrSeq 兼容旧调用：数字 = targetSeq；对象 = { targetSeq, turn, messageId }
 * @returns {{boundary, turn, targetSeq, messageId, oldText, resolvedBy} | {code, status, message?}}
 */
export function resolveAssistantBoundary(ctx, sessionId, optsOrSeq, turnArg) {
  const opts = (typeof optsOrSeq === 'object' && optsOrSeq !== null)
    ? optsOrSeq
    : { targetSeq: optsOrSeq, turn: turnArg };
  const { targetSeq, turn, messageId } = opts;

  const session = ctx.sessions.get(sessionId);
  if (!session) return { code: 'session-not-found', status: 404 };
  let events;
  if (typeof session.snapshotEvents === 'function') {
    try { events = session.snapshotEvents(); } catch (e) { return { code: 'internal', status: 500, message: String(e?.message ?? e) }; }
  } else {
    events = session.events;
  }
  if (!Array.isArray(events)) return { code: 'internal', status: 500, message: 'events unavailable' };

  const isReply = (e) => e?.type === 'assistant/message' && assistantTextOf(e) !== null;
  let targetIdx = -1;
  let resolvedBy = '';
  let seqEvent;

  if (typeof messageId === 'string' && messageId.length > 0) {
    targetIdx = events.findIndex((e) => isReply(e) && e?.data?.message?.id === messageId);
    if (targetIdx !== -1) resolvedBy = 'messageId';
  }
  if (targetIdx === -1 && typeof targetSeq === 'number') {
    const idx = events.findIndex((e) => e.seq === targetSeq);
    if (idx !== -1) {
      seqEvent = events[idx];
      if (isReply(seqEvent)) { targetIdx = idx; resolvedBy = 'seq'; }
    }
  }
  if (targetIdx === -1 && typeof turn === 'number') {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (isReply(events[i]) && events[i]?.data?.turn === turn) { targetIdx = i; resolvedBy = 'turn'; break; }
    }
  }
  if (targetIdx === -1) {
    // 诊断更准：目标事件存在但没文本 → no-text；否则 invalid-target
    if (seqEvent !== undefined && seqEvent.type === 'assistant/message') {
      return { code: 'no-text', status: 409, message: '这条回复没有可编辑的文本块' };
    }
    if (typeof messageId === 'string' && messageId.length > 0) {
      const anyById = events.find((e) => e?.data?.message?.id === messageId);
      if (anyById !== undefined) return { code: 'no-text', status: 409, message: '这条回复没有可编辑的文本块' };
    }
    return { code: 'invalid-target', status: 404, message: '找不到目标回复事件' };
  }

  const target = events[targetIdx];
  const targetTurn = typeof target?.data?.turn === 'number' ? target.data.turn : turn;

  // 目标之后的第一条 turn/end 即本回合闭包（目标事件之后的同回合事件一起保留在子会话里）。
  for (let i = targetIdx; i < events.length; i += 1) {
    if (events[i].type === 'turn/end') {
      return {
        boundary: events[i].seq,
        turn: targetTurn,
        targetSeq: target.seq,
        messageId: target?.data?.message?.id ?? null,
        oldText: assistantTextOf(target) ?? '',
        reasoningText: blockTextOf(target, 'reasoning'),
        blockIndex: blockIndexOf(target, 'text'),
        reasoningIndex: blockIndexOf(target, 'reasoning'),
        resolvedBy,
        closesAt: events[i].seq,
      };
    }
  }
  return { code: 'turn-open', status: 409, message: '这个回合还没结束（没有 turn/end），无法生成新分支；请等回复完成后再编辑' };
}

// ---------------------------------------------------------------- 自己造分支（主路径）

/** 复制一条事件，只把目标块（text / reasoning，默认正文最后一块）换成新文本。 */
export function patchSeedEvent(event, options) {
  const { messageId, targetSeq, newText, replaceAllTextInMessage, blockKind, blockIndex } = options;
  const matches = (typeof messageId === 'string' && messageId.length > 0 && event?.data?.message?.id === messageId)
    || (typeof targetSeq === 'number' && event?.seq === targetSeq);
  if (!matches) return event;
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return event;
  const kind = normalizeBlockKind(blockKind);
  const indexes = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] && content[i].type === kind && typeof content[i].text === 'string') indexes.push(i);
  }
  if (indexes.length === 0) return event;
  const use = Number.isSafeInteger(blockIndex) && indexes.includes(blockIndex)
    ? [blockIndex]
    : (replaceAllTextInMessage === true ? indexes : [indexes[indexes.length - 1]]);
  const nextContent = content.map((block, i) => (use.includes(i) ? { ...block, text: newText } : block));
  return { ...event, data: { ...event.data, message: { ...event.data.message, content: nextContent } } };
}

/**
 * 把子会话挂进父会话所在的工作区；返回诊断字符串。
 *
 * 判定与官方 `forkWorkspace` 同源：先在工作区成员表里找包含父会话的那个；找不到再按 cwd
 * 匹配工作区路径（DSH 的分组本就以 cwd 为准，父会话刚被移动过时成员表可能未刷新）。
 * 挂载本身走官方的 `workspace.attachSession(id)`，失败再用"先修索引 + record 记账"兜底
 * （兜底来自已验证的迁移模块）。
 *
 * 注意：`ctx.workspaceRegistry` 是属性访问，**必须在 inject 里声明**，否则抛
 * "cannot get property workspaceRegistry without inject" —— 这正是子会话曾落未分组的原因。
 */
async function attachToWorkspace(ctx, parent, childId, log) {
  try {
    let registry = null;
    try { registry = ctx.workspaceRegistry ?? (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null); } catch { registry = null; }
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return 'no-registry';
    const workspaces = registry.list();
    const memberIds = (workspace) => {
      if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds;
      if (Array.isArray(workspace?.record?.sessionIds)) return workspace.record.sessionIds;
      return [];
    };
    let owner = workspaces.find((workspace) => memberIds(workspace).includes(parent.id));
    if (owner === undefined && typeof parent.header?.cwd === 'string') {
      const normalize = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase();
      const cwd = normalize(parent.header.cwd);
      owner = workspaces.find((workspace) => normalize(workspace?.record?.path ?? workspace?.path) === cwd);
    }
    if (owner === undefined) return 'no-workspace';
    try {
      await owner.attachSession(childId);
      log('info', 'assistant-branch', '子会话已挂到工作区', { childId, workspaceId: owner.id });
      return 'attached';
    } catch (error) {
      try {
        const path = owner.record?.path ?? parent.header?.cwd;
        registry.sessionPaths?.set?.(childId, path);
        registry.invalidSessionPaths?.delete?.(childId);
        await owner.mutate((record) => {
          const ids = Array.isArray(record.sessionIds) ? record.sessionIds : [];
          if (!ids.includes(childId)) ids.push(childId);
        });
        log('warn', 'assistant-branch', 'attachSession 失败，已用 record 兜底挂载', { childId, err: String(error?.message ?? error) });
        return 'attached-fallback';
      } catch (error2) {
        log('warn', 'assistant-branch', '挂到工作区失败（会话仍可用，只是可能显示在未分组）', { childId, err: String(error2?.message ?? error2) });
        return 'failed';
      }
    }
  } catch (error) {
    log('warn', 'assistant-branch', '工作区挂载异常（忽略）', { childId, err: String(error?.message ?? error) });
    return 'failed';
  }
}
/**
 * 主路径：**在创建子会话时就把回复文本换成新文本**，从根上避免"活动会话内存副本是旧文本"。
 *
 * 做法（与官方 fork 同源，但种子用我们改好的）：
 *   1. 取父会话（活动）的事件快照，截到目标回合自己的 turn/end（含），并把紧随其后的
 *      非 turn 事件（session/title 之类）一并带上，直到下一个 turn/start —— 与官方 fork 的切法一致；
 *   2. 在这段种子里只改目标回复的 text 块；
 *   3. `ctx.sessions.create(childId, { seed, inheritedEventCount, meta })`：公开服务 API，
 *      内部自己 enter + announce（客户端立刻拿到这一行），API 的 session controller 会在
 *      打开/继续对话时按需 resume 出 agent；
 *   4. 挂进父会话所在工作区（失败也不影响会话本身可用）。
 *
 * @returns {{childSessionId: string, seedEvents: number, replacedSeq: number, turn: number|undefined, attach: string}}
 */
export async function branchAssistantEdit(ctx, log, options) {
  const { parentSessionId, childSessionId, targetSeq, turn, messageId, newText, replaceAllTextInMessage, blockKind, blockIndex } = options;
  if (typeof newText !== 'string' || newText.length === 0) { const e = new Error('回复内容不能为空'); e.code = 'empty-text'; throw e; }
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) { const e = new Error('缺少子会话 id'); e.code = 'bad-request'; throw e; }
  const parent = ctx.sessions.get(parentSessionId);
  if (parent === undefined) { const e = new Error('父会话不是活动会话，无法生成新分支'); e.code = 'parent-not-live'; throw e; }
  if (typeof ctx.sessions.create !== 'function') { const e = new Error('当前 DSH 未暴露 sessions.create'); e.code = 'no-create-api'; throw e; }

  const resolved = resolveAssistantBoundary(ctx, parentSessionId, { targetSeq, turn, messageId });
  if (resolved.code !== undefined) { const e = new Error(resolved.message ?? resolved.code); e.code = resolved.code; throw e; }

  const all = typeof parent.snapshotEvents === 'function' ? parent.snapshotEvents() : (Array.isArray(parent.events) ? parent.events : null);
  if (!Array.isArray(all)) { const e = new Error('读不到父会话事件'); e.code = 'no-events'; throw e; }

  let cut = 0;
  while (cut < all.length && all[cut].seq <= resolved.boundary) cut += 1;
  while (cut < all.length && all[cut].type !== 'turn/start') cut += 1;
  if (cut === 0) { const e = new Error('分支边界之前没有可复制的事件'); e.code = 'empty-seed'; throw e; }

  const patchOptions = { messageId: resolved.messageId ?? messageId, targetSeq: resolved.targetSeq, newText, replaceAllTextInMessage: replaceAllTextInMessage === true, blockKind, blockIndex };
  let patchedCount = 0;
  const seed = all.slice(0, cut).map((event) => {
    const next = patchSeedEvent(event, patchOptions);
    if (next !== event) patchedCount += 1;
    return next;
  });
  if (patchedCount === 0) { const e = new Error('在分支种子里找不到目标块'); e.code = 'target-not-in-seed'; throw e; }

  const child = ctx.sessions.create(childSessionId, {
    seed,
    inheritedEventCount: seed.length,
    meta: branchMeta(parent, seed.length),
  });
  const { attach, partial } = await finishBranch(ctx, parent, child, seed, log, { kind: 'assistant-branch' });
  log('info', 'assistant-branch', '已用改好的种子创建子会话', {
    parent: parentSessionId, child: child.id, seedEvents: seed.length, patched: patchedCount, blockKind: normalizeBlockKind(blockKind),
    replacedSeq: resolved.targetSeq, turn: resolved.turn, attach, partial,
  });
  return {
    childSessionId: child.id,
    seedEvents: seed.length,
    patched: patchedCount,
    blockKind: normalizeBlockKind(blockKind),
    replacedSeq: resolved.targetSeq,
    turn: resolved.turn,
    attach,
    partial,
  };
}

// ---------------------------------------------------------------- 重生成 / 重试（借鉴 dsh-message-edit 的回合原子性）

/**
 * 折出所有**已闭合**的回合（未闭合的尾巴故意不入列）。
 * 与社区 dsh-message-edit 的 `closedTurns()` 同构：回合起止 + 用户消息 + 助手消息。
 */
export function closedTurns(events) {
  const result = [];
  let current;
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') {
      current = { turn: event.data?.turn, startSeq: event.seq, endSeq: undefined, user: undefined, assistants: [] };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event?.data?.source?.kind === 'user') {
      current.user = event;
      continue;
    }
    if (event.type === 'assistant/message' && event?.data?.turn === current.turn) {
      current.assistants.push(event);
      continue;
    }
    if (event.type === 'turn/end' && event?.data?.turn === current.turn) {
      current.endSeq = event.seq;
      result.push(current);
      current = undefined;
    }
  }
  return result;
}

/** 用户消息里的纯文本（重放用）。 */
export function userTextOf(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * 规划"重生成/重试"：分支点取目标回合**之前**（`turn/start - 1`），
 * 该回合整段不进新会话，由客户端把原用户输入作为新回合重发（复用底座已验证的 resume-send 管道）。
 *
 * @returns {{boundary, turn, userText, userSeq} | {code, status, message?}}
 */
export function planRegenerate(events, options) {
  const turns = closedTurns(events);
  if (turns.length === 0) return { code: 'no-closed-turn', status: 409, message: '还没有已完成的回合可以重新生成' };
  let target;
  if (typeof options.turn === 'number') {
    target = turns.find((t) => t.turn === options.turn);
    if (target === undefined) return { code: 'invalid-turn', status: 404, message: '找不到该回合' };
  } else {
    const messageId = options.messageId;
    const seq = options.targetSeq;
    if (typeof messageId === 'string' || typeof seq === 'number') {
      target = turns.find((t) => t.assistants.some((a) => (typeof messageId === 'string' && a?.data?.message?.id === messageId) || (typeof seq === 'number' && a.seq === seq)));
      if (target === undefined) return { code: 'invalid-target', status: 404, message: '这条回复不属于任何已完成的回合' };
    } else {
      // 不指定 = 重新生成最后一条带文本的回复所属回合
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].user !== undefined && turns[i].assistants.some((a) => assistantTextOf(a) !== null)) { target = turns[i]; break; }
      }
      if (target === undefined) return { code: 'no-target', status: 409, message: '找不到可重新生成的回复' };
    }
  }
  if (target.user === undefined) return { code: 'no-user-input', status: 409, message: '该回合没有可重放的用户输入' };
  return {
    boundary: target.startSeq - 1,
    turn: target.turn,
    userText: userTextOf(target.user),
    userSeq: target.user.seq,
    userMessageId: target.user?.data?.id ?? null,
  };
}

/**
 * 重生成/重试：按"回合之前"的边界建子会话，**不改任何文本**（目的就是让模型重跑），
 * 并把原用户输入交给客户端去 resume-send。父会话之后的内容不进新分支。
 */
export async function regenerateBranch(ctx, log, options) {
  const { parentSessionId, childSessionId } = options;
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) { const e = new Error('缺少子会话 id'); e.code = 'bad-request'; throw e; }
  const parent = ctx.sessions.get(parentSessionId);
  if (parent === undefined) { const e = new Error('父会话不是活动会话，无法生成新分支'); e.code = 'parent-not-live'; throw e; }
  if (typeof ctx.sessions.create !== 'function') { const e = new Error('当前 DSH 未暴露 sessions.create'); e.code = 'no-create-api'; throw e; }

  const events = parentEvents(parent);
  if (events === null) { const e = new Error('读不到父会话事件'); e.code = 'no-events'; throw e; }
  const plan = planRegenerate(events, { turn: options.turn, messageId: options.messageId, targetSeq: options.targetSeq });
  if (plan.code !== undefined) { const e = new Error(plan.message ?? plan.code); e.code = plan.code; throw e; }

  const cut = plan.boundary + 1;
  if (cut <= 0) { const e = new Error('该回合之前没有可复制的事件（首回合无法重生成）'); e.code = 'empty-seed'; throw e; }
  const seed = events.slice(0, cut);
  const child = ctx.sessions.create(childSessionId, { seed, inheritedEventCount: seed.length, meta: branchMeta(parent, seed.length) });
  const { attach, partial } = await finishBranch(ctx, parent, child, seed, log, { kind: 'regenerate' });
  log('info', 'assistant-branch', '已创建重生成分支', {
    parent: parentSessionId, child: child.id, turn: plan.turn, boundary: plan.boundary,
    seedEvents: seed.length, userChars: plan.userText.length, attach, partial,
  });
  return {
    childSessionId: child.id,
    turn: plan.turn,
    boundary: plan.boundary,
    seedEvents: seed.length,
    userText: plan.userText,
    userSeq: plan.userSeq,
    attach,
    partial,
  };
}

// ---------------------------------------------------------------- 公共小工具

function parentEvents(parent) {
  if (typeof parent.snapshotEvents === 'function') {
    try {
      const list = parent.snapshotEvents();
      if (Array.isArray(list)) return list;
    } catch { /* fall through */ }
  }
  return Array.isArray(parent.events) ? parent.events : null;
}

/**
 * 子会话 header/meta：沿用父会话的 cwd 与**预设**。
 * 预设取"日志里最后一条 agent-preset/selected"（借鉴 dsh-message-edit 的 `sessionPreset()`）——
 * 只读 header.agentPreset 会在"会话中途换过预设"时把新分支带到默认档。
 */
export function sessionPresetOf(events, header) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'agent-preset/selected' && typeof event?.data?.agentPreset === 'string') return event.data.agentPreset;
  }
  return typeof header?.agentPreset === 'string' ? header.agentPreset : undefined;
}

/** 从日志解析模型路由（最后一条 request/header）——只用于诊断：子会话靠懒 resume 时会读它。 */
export function modelRoutingOf(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
    const config = events[i]?.type === 'request/header' ? events[i]?.data?.header?.config : undefined;
    if (config?.provider !== undefined && config?.model !== undefined) {
      return { provider: String(config.provider), model: String(config.model), maxTokens: config.maxTokens };
    }
  }
  return null;
}

function branchMeta(parent, seedLength) {
  const events = parentEvents(parent) ?? [];
  const preset = sessionPresetOf(events, parent.header);
  return {
    ...(parent.header?.cwd === undefined ? {} : { cwd: parent.header.cwd }),
    parentSession: parent.id,
    isSeeded: true,
    seedLength,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  };
}

/**
 * 建完子会话后的收尾：耐久屏障（flush）+ 挂工作区。
 * `partial: true` = 分支已建好但没能归入工作区（客户端据此提示，启动自愈会在下次补挂）。
 */
async function finishBranch(ctx, parent, child, seed, log, tag) {
  const routing = modelRoutingOf(seed);
  if (routing === null) log('warn', 'assistant-branch', '种子里没有 request/header，子会话模型路由将按默认解析', { childId: child.id });
  else log('info', 'assistant-branch', '子会话模型路由（来自日志）', { childId: child.id, ...routing });
  try {
    // 耐久屏障：返回成功之前先把子会话落盘，避免"刚建好就崩 → 分支内容丢"
    await ctx.sessions.flush(child);
  } catch (error) {
    log('warn', 'assistant-branch', 'flush 失败（分支已存在，可能尚未落盘）', { childId: child.id, err: String(error?.message ?? error) });
  }
  const attach = await attachToWorkspace(ctx, parent, child.id, log);
  const partial = attach !== 'attached' && attach !== 'attached-fallback';
  if (partial) log('warn', tag.kind + ': 分支已创建但未归入工作区（启动自愈会补挂）', { childId: child.id, attach });
  return { attach, partial };
}

export const __test = { locateAssistantLine, rewriteAssistantArtifact, decodeArtifactBuffer, encodeArtifactSync, assistantTextOf, blockTextOf, blockIndexOf, patchLiveEventText, findLiveEvent, patchSeedEvent, closedTurns, userTextOf, planRegenerate, sessionPresetOf, modelRoutingOf };
