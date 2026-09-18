/**
 * 离线单测：wm-assistant-edit 的改写核心。
 *
 * 用**真实会话日志的副本**（只读源文件，改动只发生在临时副本上）验证：
 *   1. 只有目标那一行变化，其余行逐字节相同、行数不变；
 *   2. header 行语义不变（帧 0 仍是单独的 header 行，满足 DSH 读取契约）；
 *   3. 目标事件的其他 content 块（reasoning / tool-call）保持原样；
 *   4. 重新解码可往返；
 *   5. locateAssistantLine 的 seq / turn / oldText 三条定位路径；
 *   6. resolveAssistantBoundary 的边界语义（保留目标回合、未闭合回合拒绝）。
 *
 * 用法：node tests/wm-assistant-edit.test.mjs [真实日志路径或 sessions 根]
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import {
  NL, decodeArtifactBuffer, encodeArtifactSync, locateAssistantLine,
  rewriteAssistantArtifact, assistantTextOf, blockTextOf, blockIndexOf, resolveAssistantBoundary, patchLiveEventText, patchSeedEvent, closedTurns, userTextOf, planRegenerate, sessionPresetOf, modelRoutingOf,
} from '../lib/wm-assistant-edit.js';

let pass = 0; let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

// ---------- 找一份真实日志 ----------
function findLog(arg) {
  const def = 'D:\\Program Files (x86)\\DSH_Data\\sessions';
  const root = arg ?? def;
  if (existsSync(root) && statSync(root).isFile()) return root;
  if (!existsSync(root)) return null;
  const found = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = join(root, proj.name);
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const f = join(pdir, e.name, 'session.v3.jsonl.zstd');
      if (existsSync(f)) found.push(f);
    }
  }
  // 取"含助手文本回复"且体积中等的
  found.sort((a, b) => statSync(b).size - statSync(a).size);
  return found[0] ?? null;
}

const logPath = findLog(process.argv[2]);
if (logPath === null) { console.log('未找到可用于测试的会话日志，跳过真实日志部分。'); }

if (logPath !== null) {
  console.log(`\n== 真实日志副本：${logPath} ==`);
  const dir = mkdtempSync(join(tmpdir(), 'wm-assist-'));
  const copyPath = join(dir, 'session.v3.jsonl.zstd');
  writeFileSync(copyPath, readFileSync(logPath)); // 副本，源文件只读
  const original = readFileSync(copyPath);
  const filename = 'session.v3.jsonl.zstd';
  const beforeLines = decodeArtifactBuffer(original, filename).split(NL);

  // 找一条带文本的助手回复
  let pick = null;
  for (let i = 1; i < beforeLines.length; i += 1) {
    if (beforeLines[i] === '') continue;
    let ev; try { ev = JSON.parse(beforeLines[i]); } catch { continue; }
    if (ev?.type === 'assistant/message' && assistantTextOf(ev) !== null) { pick = { i, ev, text: assistantTextOf(ev) }; break; }
  }
  if (pick === null) {
    console.log('  该日志没有带文本的助手回复，跳过改写断言。');
  } else {
    const newText = '【WM 单测】这是被改写后的回复文本。';
    const out = rewriteAssistantArtifact(original, { filename, targetSeq: pick.ev.seq, newText });
    const afterLines = decodeArtifactBuffer(out.bytes, filename).split(NL);

    check('行数不变', afterLines.length === beforeLines.length, { before: beforeLines.length, after: afterLines.length });
    check('header 行逐字节不变', afterLines[0] === beforeLines[0]);
    check('header 仍是单行且帧 0 可独立解出', (() => {
      const first = zlib.zstdDecompressSync(out.bytes.subarray(0, out.bytes.length));
      return first.toString('utf8').startsWith(afterLines[0] + NL);
    })());
    check('目标行已改为新文本', assistantTextOf(JSON.parse(afterLines[out.lineIndex])) === newText);
    let diff = [];
    for (let i = 1; i < beforeLines.length; i += 1) if (beforeLines[i] !== afterLines[i]) diff.push(i);
    check('只有目标行变化', diff.length === 1 && diff[0] === out.lineIndex, diff);
    const beforeEv = JSON.parse(beforeLines[out.lineIndex]);
    const afterEv = JSON.parse(afterLines[out.lineIndex]);
    const keepKeys = ['seq', 'time', 'type'];
    check('seq/time/type 保持', keepKeys.every((k) => JSON.stringify(beforeEv[k]) === JSON.stringify(afterEv[k])));
    const beforeOther = beforeEv.data.message.content.filter((b) => b.type !== 'text');
    const afterOther = afterEv.data.message.content.filter((b) => b.type !== 'text');
    check('非 text 块（reasoning/tool-call）原样保留', JSON.stringify(beforeOther) === JSON.stringify(afterOther), { beforeLen: beforeOther.length, afterLen: afterOther.length });
    check('data.turn / data.step 不变', beforeEv.data.turn === afterEv.data.turn && beforeEv.data.step === afterEv.data.step);
    check('改写结果可再次解码往返', decodeArtifactBuffer(out.bytes, filename).split(NL)[out.lineIndex] === afterLines[out.lineIndex]);

    // 定位路径
    const byTurn = locateAssistantLine(afterLines, { turn: out.turn });
    check('按 turn 能定位', byTurn.error === undefined && byTurn.text === newText, byTurn.error);
    const byOld = locateAssistantLine(afterLines, { oldText: newText });
    check('按 oldText 能定位', byOld.error === undefined && byOld.index === out.lineIndex, byOld.error);
    const missing = locateAssistantLine(afterLines, { targetSeq: 999999999 });
    check('未知 seq 回落到最后一条回复（不报错）', missing.error === undefined);
    check('replaceAllTextInMessage 选项可用', (() => {
      const r = rewriteAssistantArtifact(original, { filename, targetSeq: pick.ev.seq, newText: 'X', replaceAllTextInMessage: true });
      const ev = JSON.parse(decodeArtifactBuffer(r.bytes, filename).split(NL)[r.lineIndex]);
      return ev.data.message.content.filter((b) => b.type === 'text').every((b) => b.text === 'X');
    })());

    // ---- 回归：messageId 路径。真实日志里 data.message.id 100% 存在；chat 投影的 block 用 `kind`，
    //      事件里的 block 用 `type`，两者不同 —— 这正是"客户端按投影 block 取文本取到空"的根因，
    //      所以客户端不再取文本，改由宿主按 messageId 定位并回传原文。 ----
    const pickMid = pick.ev?.data?.message?.id;
    check('真实事件带 data.message.id', typeof pickMid === 'string' && pickMid.length > 0, { pickMid });
    if (typeof pickMid === 'string' && pickMid.length > 0) {
      const byIdLine = locateAssistantLine(beforeLines, { messageId: pickMid });
      check('locateAssistantLine 可按 messageId 定位', byIdLine.error === undefined && byIdLine.index === pick.i, byIdLine.error);
      const r2 = rewriteAssistantArtifact(original, { filename, messageId: pickMid, newText: '【按 messageId 改写】' });
      const after2 = decodeArtifactBuffer(r2.bytes, filename).split(NL);
      check('按 messageId 改写：只有目标行变化', after2.length === beforeLines.length && after2.every((l, i) => i === 0 || i === r2.lineIndex || l === beforeLines[i]));
      check('按 messageId 改写：文本已生效', assistantTextOf(JSON.parse(after2[r2.lineIndex])) === '【按 messageId 改写】');
    }
  }
}

// ---------- resolveAssistantBoundary：伪造 ctx ----------
console.log('\n== resolveAssistantBoundary 语义 ==');
function fakeCtx(events) {
  return { sessions: { get: (id) => (id === 's1' ? { snapshotEvents: () => events } : undefined) } };
}
const E = (seq, type, data) => ({ seq, type, data });
const evs = [
  E(0, 'user/message', { turn: 1, id: 'm1', content: [{ type: 'text', text: '问题一' }] }),
  E(1, 'step/start', { turn: 1, step: 1 }),
  E(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复一' }] } }),
  E(3, 'turn/end', { turn: 1 }),
  E(4, 'user/message', { turn: 2, id: 'm2', content: [{ type: 'text', text: '问题二' }] }),
  E(5, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复二' }] } }),
  E(6, 'turn/end', { turn: 2 }),
];
{
  const r = resolveAssistantBoundary(fakeCtx(evs), 's1', 2, undefined);
  check('编辑第 1 回合回复 → 边界是该回合自己的 turn/end(seq=3)', r.boundary === 3 && r.turn === 1, r);
  const r2 = resolveAssistantBoundary(fakeCtx(evs), 's1', 5, undefined);
  check('编辑第 2 回合回复 → 边界 seq=6', r2.boundary === 6 && r2.turn === 2, r2);
  const r3 = resolveAssistantBoundary(fakeCtx(evs), 's1', undefined, 1);
  check('只给 turn 也能定位', r3.boundary === 3 && r3.targetSeq === 2, r3);
  const r4 = resolveAssistantBoundary(fakeCtx(evs), 's1', 0, undefined);
  check('目标不是助手回复 → invalid-target', r4.code === 'invalid-target', r4);
  const open = [...evs, E(7, 'turn/start', { turn: 3 }), E(8, 'assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '未完成' }] } })];
  const r5 = resolveAssistantBoundary(fakeCtx(open), 's1', 8, undefined);
  check('未闭合回合 → turn-open', r5.code === 'turn-open', r5);
  const noText = [E(0, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 't' }] } }), E(1, 'turn/end', { turn: 1 })];
  const r6 = resolveAssistantBoundary(fakeCtx(noText), 's1', 0, undefined);
  check('无文本块 → no-text', r6.code === 'no-text', r6);
  const r7 = resolveAssistantBoundary(fakeCtx(evs), 'nope', 2, undefined);
  check('会话不存在 → session-not-found', r7.code === 'session-not-found', r7);

  // ---- messageId 路径（新客户端只带 sessionId + messageId） ----
  const evsWithId = [
    E(0, 'user/message', { turn: 1, id: 'm1', content: [{ type: 'text', text: '问题一' }] }),
    E(1, 'assistant/message', { turn: 1, step: 1, message: { id: 'am-1', role: 'assistant', content: [{ type: 'text', text: '回复一' }] } }),
    E(2, 'turn/end', { turn: 1 }),
    E(3, 'user/message', { turn: 2, id: 'm2', content: [{ type: 'text', text: '问题二' }] }),
    E(4, 'assistant/message', { turn: 2, step: 1, message: { id: 'am-2', role: 'assistant', content: [{ type: 'text', text: '回复二' }] } }),
    E(5, 'turn/end', { turn: 2 }),
  ];
  const m1 = resolveAssistantBoundary(fakeCtx(evsWithId), 's1', { messageId: 'am-1' });
  check('按 messageId 定位（第 1 回合）', m1.boundary === 2 && m1.turn === 1 && m1.targetSeq === 1 && m1.resolvedBy === 'messageId', m1);
  check('按 messageId 回传原文（供编辑框预填）', m1.oldText === '回复一', { oldText: m1.oldText });
  const m2 = resolveAssistantBoundary(fakeCtx(evsWithId), 's1', { messageId: 'am-2' });
  check('按 messageId 定位（第 2 回合）', m2.boundary === 5 && m2.turn === 2, m2);
  const m3 = resolveAssistantBoundary(fakeCtx(evsWithId), 's1', { messageId: 'not-exist' });
  check('未知 messageId → invalid-target', m3.code === 'invalid-target', m3);
  const m4 = resolveAssistantBoundary(fakeCtx(evsWithId), 's1', { targetSeq: 1, turn: 1 });
  check('对象式旧参数仍可用（seq 优先）', m4.boundary === 2 && m4.resolvedBy === 'seq', m4);
}

// ---------- patchLiveEventText：活动会话内存同步（DSH 事件消息是 deepFreeze 的，必须能优雅失败） ----------
console.log('\n== patchLiveEventText 语义 ==');
{
  const mkEvent = (seq, text) => ({ seq, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'am-' + seq, role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text }] } } });
  // 可写对象：应成功且自检通过
  const live = { events: [mkEvent(1, '旧文本')] };
  live.eventAt = (seq) => live.events.find((e) => e.seq === seq);
  live.snapshotEvents = () => live.events;
  const ok = patchLiveEventText(live, 1, '新文本', false, () => {});
  check('可写事件：同步成功', ok === true, { ok });
  check('可写事件：文本已改', assistantTextOf(live.events[0]) === '新文本');
  check('可写事件：reasoning 块保留', live.events[0].data.message.content[0].text === 'r');
  // 冻结对象（DSH 真实情形）：应返回 false 而不是抛错
  const frozen = { seq: 1, type: 'assistant/message', data: Object.freeze({ turn: 1, step: 1, message: Object.freeze({ id: 'am-1', role: 'assistant', content: Object.freeze([Object.freeze({ type: 'text', text: '旧' })]) }) }) };
  const live2 = { eventAt: () => frozen, snapshotEvents: () => [frozen] };
  let threw = false;
  let r2 = null;
  try { r2 = patchLiveEventText(live2, 1, '新', false, () => {}); } catch (e) { threw = true; }
  check('冻结事件：不抛错并返回 false（走卸载兜底）', threw === false && r2 === false, { threw, r2 });
  // 找不到事件
  const live3 = { eventAt: () => undefined, snapshotEvents: () => [] };
  check('找不到事件：返回 null', patchLiveEventText(live3, 9, 'x', false, () => {}) === null);
}

// ---------- patchSeedEvent：建分支时改种子（主路径） ----------
console.log('\n== patchSeedEvent 语义 ==');
{
  const mk = (seq, mid, content) => ({ seq, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: mid, role: 'assistant', content } } });
  const ev = mk(5, 'am-1', [{ type: 'reasoning', text: 'R' }, { type: 'text', text: '原文' }]);
  const other = mk(6, 'am-2', [{ type: 'text', text: '别的回复' }]);
  const byId = patchSeedEvent(ev, { messageId: 'am-1', targetSeq: 5, newText: '新文本' });
  check('按 messageId 命中并改写', assistantTextOf(byId) === '新文本' && byId.data.message.content[0].text === 'R');
  check('未命中事件原样返回（引用不变）', patchSeedEvent(other, { messageId: 'am-1', targetSeq: 5, newText: 'X' }) === other);
  const bySeq = patchSeedEvent(ev, { targetSeq: 5, newText: 'seq 命中' });
  check('按 seq 命中', assistantTextOf(bySeq) === 'seq 命中');
  check('不修改原事件（不可变）', assistantTextOf(ev) === '原文' && ev.data.message.id === 'am-1');
  const noText = mk(7, 'am-3', [{ type: 'tool-call', callId: 'c' }]);
  check('无 text 块 → 原样返回', patchSeedEvent(noText, { messageId: 'am-3', newText: 'X' }) === noText);
  const multi = mk(8, 'am-4', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  const all = patchSeedEvent(multi, { messageId: 'am-4', newText: 'Z', replaceAllTextInMessage: true });
  check('replaceAllTextInMessage 全改', all.data.message.content.every((b) => b.text === 'Z'));
  const lastOnly = patchSeedEvent(multi, { messageId: 'am-4', newText: 'Z' });
  check('默认只改最后一个 text 块', lastOnly.data.message.content[0].text === 'a' && lastOnly.data.message.content[1].text === 'Z');
}

// ---------- 重新生成 / 重试：回合原子性（借鉴 dsh-message-edit） ----------
console.log('\n== planRegenerate / closedTurns 语义 ==');
{
  const E = (seq, type, data) => ({ seq, type, data });
  const events = [
    E(0, 'turn/start', { turn: 1 }),
    E(1, 'user/message', { turn: 1, id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '问题一' }] }),
    E(2, 'step/start', { turn: 1, step: 1 }),
    E(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '答一' }] } }),
    E(4, 'step/end', { turn: 1, step: 1 }),
    E(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    E(6, 'turn/start', { turn: 2 }),
    E(7, 'user/message', { turn: 2, id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '问题二' }] }),
    E(8, 'assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '答二' }] } }),
    E(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    E(10, 'turn/start', { turn: 3 }),   // 未闭合尾巴
    E(11, 'user/message', { turn: 3, id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: '问题三' }] }),
  ];
  const turns = closedTurns(events);
  check('closedTurns 只收已闭合回合', turns.length === 2 && turns[0].turn === 1 && turns[1].turn === 2, { count: turns.length });
  check('回合带起止 seq', turns[0].startSeq === 0 && turns[0].endSeq === 5);
  const byMessage = planRegenerate(events, { messageId: 'a2' });
  check('按 messageId 定位到回合 2', byMessage.turn === 2 && byMessage.boundary === 5, byMessage);
  check('回传原提问文本（供重发）', byMessage.userText === '问题二', { userText: byMessage.userText });
  const byTurn = planRegenerate(events, { turn: 1 });
  check('按 turn 定位，边界是该回合之前', byTurn.boundary === -1 && byTurn.userText === '问题一', byTurn);
  const last = planRegenerate(events, {});
  check('不指定 = 最后一条带文本回复的回合', last.turn === 2, last);
  const noInput = planRegenerate([E(0, 'turn/start', { turn: 1 }), E(1, 'assistant/message', { turn: 1, step: 1, message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 't' }] } }), E(2, 'turn/end', { turn: 1 })], { turn: 1 });
  check('该回合没有用户输入 → no-user-input', noInput.code === 'no-user-input', noInput);
  check('userTextOf 只取文本块', userTextOf({ data: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } }) === 'a\nb');
}

// ---------- 块类型（正文 / 思考）与预设/模型读取 ----------
console.log('\n== blockKind / 预设 / 模型路由 ==');
{
  const mk = (id, content) => ({ seq: 5, type: 'assistant/message', data: { turn: 1, step: 1, message: { id, role: 'assistant', content } } });
  const ev = mk('m1', [{ type: 'reasoning', text: 'R' }, { type: 'text', text: '正文' }]);
  const r = patchSeedEvent(ev, { messageId: 'm1', newText: '新思考', blockKind: 'reasoning' });
  check('blockKind=reasoning 只改思考块', blockTextOf(r, 'reasoning') === '新思考' && assistantTextOf(r) === '正文');
  const t2 = patchSeedEvent(ev, { messageId: 'm1', newText: '新正文', blockKind: 'text' });
  check('blockKind=text 只改正文', assistantTextOf(t2) === '新正文' && blockTextOf(t2, 'reasoning') === 'R');
  check('blockIndexOf 命中最后一块', blockIndexOf(ev, 'text') === 1 && blockIndexOf(ev, 'reasoning') === 0);
  const onlyReasoning = mk('m2', [{ type: 'reasoning', text: 'R' }]);
  check('没有正文块时改正文 → 原样返回', patchSeedEvent(onlyReasoning, { messageId: 'm2', newText: 'x', blockKind: 'text' }) === onlyReasoning);
  check('blockTextOf 无该类块 → null', blockTextOf(onlyReasoning, 'text') === null);

  const withPreset = [{ type: 'agent-preset/selected', data: { agentPreset: 'old' } }, { type: 'agent-preset/selected', data: { agentPreset: 'new' } }];
  check('预设取日志里最后一条', sessionPresetOf(withPreset, { agentPreset: 'header' }) === 'new');
  check('日志里没有 → 回落 header', sessionPresetOf([], { agentPreset: 'header' }) === 'header');
  const withHeader = [{ type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1', maxTokens: 100 } } } }, { type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2' } } } }];
  check('模型路由取最后一条 request/header', modelRoutingOf(withHeader)?.provider === 'p2' && modelRoutingOf(withHeader)?.model === 'm2');
  check('没有 request/header → null', modelRoutingOf([]) === null);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
