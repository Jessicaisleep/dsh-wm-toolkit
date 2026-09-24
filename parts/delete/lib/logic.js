/**
 * dsh-wm-toolkit · 消息删除半边 —— 纯会话日志逻辑（无任何 DSH SDK 依赖）。
 *
 * 移植自 MIT 社区插件 `dsh-delete-turn`（DDDMUC/dsh-delete-turn v0.1.3）的 src/logic.js，
 * 保留其算法与契约，只做两处改动：
 *   1. `PLUGIN_ID` 改为 `dsh-wm-toolkit`（替换占位消息的 source 标记）；
 *   2. `sourceOwnsPlugin` 同时认上游插件留下的标记（见该函数注释）。
 * 上游版权与许可见仓库根 NOTICE.md。
 *
 * 这里只处理「通过官方 sessionQuery 读回来的普通事件 JSON」，所以本文件在 `node --test`
 * 下可直接运行。两块核心：
 *   - 官方 surface 折叠：模型现在还能看到哪些节点、历史替换事件各自遮蔽了哪些节点；
 *   - 区间规划器：把一个界面目标变成一个规范、连续、干净的 surface-replace 区间。
 */

/** 宿主半边与浏览器半边共用的插件标识（写进替换事件的 source）。 */
export const PLUGIN_ID = 'dsh-wm-toolkit';

/**
 * 上游插件 `dsh-delete-turn` 的标识。
 *
 * 如果这台机器上曾经装过它、并留下过删除记录，那些替换事件在日志里依然是有效的
 * surface 变更（内容确实已经不在上下文里）。本插件重放台账时一并承认它们，
 * 这样界面不会把「已被上游删掉的行」当成还活着的内容再显示一次删除入口。
 */
const UPSTREAM_PLUGIN_ID = 'dsh-delete-turn';

/** 可以携带 `surfaceOp` 的四种事件类型（官方 surface 契约）。 */
const SURFACE_TYPES = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/**
 * 某个事件是否参与模型可见的 surface。
 * @param event - 原始会话事件。
 * @returns 消息类事件类型返回 true。
 */
export function isSurfaceEvent(event) {
  return SURFACE_TYPES.has(event.type);
}

/**
 * 重放一份完整日志的 surface 操作。
 *
 * 与官方折叠保持一致：`append` 把事件压到尾部；`replace` 用它自己换掉两个 surface
 * 节点之间的闭区间。锚点已经不在 surface 上的替换会被防御性跳过——日志损坏也绝不能在
 * HTTP handler 里抛错。
 *
 * @param events - 按 seq 连续排列的完整原始事件日志。
 * @returns 当前 surface 的 seq（模型顺序）+ 每一次落地替换及其精确遮蔽的 seq。
 */
export function foldSurface(events) {
  const nodes = [];
  const replacements = [];
  for (const event of events) {
    const op = event.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push(event.seq);
      continue;
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue;
    const startIdx = nodes.indexOf(op.startSeq);
    const endIdx = nodes.indexOf(op.endSeq);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue;
    const shadowed = nodes.slice(startIdx, endIdx + 1);
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed });
  }
  return { nodes, replacements };
}

/**
 * 一个 surface 事件里消息的持久身份。
 * @param event - 原始会话事件。
 * @returns 消息 id；没有 id 的事件返回 undefined。
 */
export function messageIdOf(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  if (event.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined;
  if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message') {
    const message = data.message;
    return message && typeof message.id === 'string' ? message.id : undefined;
  }
  return undefined;
}

/**
 * 某个消息 source 是否属于本插件（或上游删除插件）。
 *
 * 两种形状都要认：本机 DSH 0.1.5-rc.2 的日志里是 `{ kind: 'plugin', plugin: X }`
 * （见真实日志中 system/message 的 source）；DSH 0.1.7 的会话格式 v4 规范化会把
 * 插件 source 展平为 `{ kind: 'plugin:X' }`。日志升级前后都要能重建台账。
 *
 * @param source - 日志事件里的消息 source 对象。
 * @returns 属于本插件或上游删除插件时返回 true。
 */
export function sourceOwnsPlugin(source) {
  if (!source || typeof source !== 'object') return false;
  for (const id of [PLUGIN_ID, UPSTREAM_PLUGIN_ID]) {
    if (source.kind === 'plugin' && source.plugin === id) return true;
    if (source.kind === `plugin:${id}`) return true;
  }
  return false;
}

/**
 * 只靠日志重建本插件的删除台账。
 *
 * 每一次删除都是一个替换事件，其消息 source 为 `{ kind: 'plugin', plugin: 'dsh-wm-toolkit' }`
 * （v3）或 `{ kind: 'plugin:dsh-wm-toolkit' }`（v4）。模式由被遮蔽的窗口反推：
 * 单条用户消息 = 单条删除；同一个 turn+step 的 assistant/tool 节点 = 步骤删除；
 * 更宽的就是整条回复删除。别的生产者（例如官方 /compact）落下的替换一律忽略。
 *
 * @param events - 连续的完整原始事件日志。
 * @returns 每个被隐藏的 seq 一条：`{ seq, mode, replacement }`。
 */
export function hiddenEntries(events) {
  return hiddenEntriesOfFold(foldSurface(events), events);
}

/**
 * 用已有的折叠结果重建删除台账。
 * @param folded - {@link foldSurface} 的结果。
 * @param events - 折叠所依据的同一份日志。
 * @returns 每个被隐藏的 seq 一条：`{ seq, mode, replacement }`。
 */
export function hiddenEntriesOfFold(folded, events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const out = [];
  for (const replacement of folded.replacements) {
    const event = bySeq.get(replacement.seq);
    const data = event && event.data;
    const source = data && (data.source || (data.message && data.message.source));
    if (!sourceOwnsPlugin(source)) continue;
    const mode = inferMode(bySeq, replacement.shadowed);
    for (const seq of replacement.shadowed) out.push({ seq, mode, replacement: replacement.seq });
  }
  return out;
}

/**
 * 回复窗口里仍有可删 surface 内容的回合号。
 *
 * 转录会刻意保留那些已经被 /compact 移出模型上下文的行（压缩就是这个用途），所以
 * 浏览器半边不能给它们显示删除入口。这里镜像 {@link planRange} 的 reply 模式成员扫描，
 * 但不做「窗口干净」校验；真正删除时仍以宿主为准。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @returns 在「该回合最后一条真人提问」之后至少还有一个非提问 surface 节点的回合号。
 */
export function deletableReplyTurns(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const turnOf = turnIndex(events);
  const lastHuman = new Map();
  const members = new Map();
  surfaceNodes.forEach((seq, index) => {
    const event = bySeq.get(seq);
    if (!event || event.type === 'system/message') return;
    const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq);
    if (typeof turn !== 'number') return;
    if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
      lastHuman.set(turn, index);
      return;
    }
    const list = members.get(turn) ?? [];
    list.push(index);
    members.set(turn, list);
  });
  const out = [];
  for (const [turn, indexes] of members) {
    const last = lastHuman.get(turn);
    if (last === undefined || indexes.some((index) => index > last)) out.push(turn);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 从被遮蔽的窗口反推这次删除属于哪一类，让刷新后的客户端能区分
 * 步骤删除（过程行还在）与整条回复删除。
 * @param bySeq - 同一份日志的 seq → event 查表。
 * @param shadowed - 按模型顺序排列的被遮蔽 surface seq。
 * @returns `message`、`step` 或 `reply`。
 */
export function inferMode(bySeq, shadowed) {
  const members = shadowed.map((seq) => bySeq.get(seq)).filter((event) => event !== undefined);
  if (members.length === 1 && members[0].type === 'user/message') return 'message';
  if (members.length > 0 && members.every((event) => event.type === 'assistant/message' || event.type === 'tool/result')) {
    const turn = members[0].data && members[0].data.turn;
    const step = members[0].data && members[0].data.step;
    if (members.every((event) => event.data && event.data.turn === turn && event.data.step === step)) return 'step';
  }
  return 'reply';
}

/**
 * 把每个事件 seq 映射到包住它的回合。
 *
 * 回合括号是用户消息（其 payload 没有 turn 字段）的可靠来源；assistant / tool 事件
 * 自带 turn 与 step，优先用自己的。
 *
 * @param events - 连续的完整原始事件日志。
 * @returns seq → 回合号（不在任何回合内为 undefined）。
 */
export function turnIndex(events) {
  const turnOf = new Map();
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = event.data && event.data.turn;
      turnOf.set(event.seq, current);
      continue;
    }
    if (event.type === 'turn/end') {
      turnOf.set(event.seq, current);
      current = undefined;
      continue;
    }
    const data = event.data;
    const explicit =
      (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/call') &&
      data && typeof data.turn === 'number'
        ? data.turn
        : undefined;
    turnOf.set(event.seq, explicit !== undefined ? explicit : current);
  }
  return turnOf;
}

/** 还没等到 `turn/end` 的回合号；所有回合都闭合时返回 null。 */
export function openTurn(events) {
  let open = null;
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data && event.data.turn;
    else if (event.type === 'turn/end' && (open === null || event.data.turn === open)) open = null;
  }
  return open;
}

/** 是否还有会继续写 surface 的操作在跑（未闭合回合 / 进行中的压缩）。 */
export function isBusy(events) {
  if (openTurn(events) !== null) return true;
  let compaction = false;
  for (const event of events) {
    if (event.type === 'compaction/start') compaction = true;
    else if (event.type === 'compaction/end') compaction = false;
  }
  return compaction;
}

/** 规划器拒绝：带一个机器码，由 HTTP 层原样透传。 */
export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * 某个事件是不是本插件自己留下的删除占位。
 * 占位本来就是已经不在上下文里的空操作，所以后续窗口可以再次遮蔽它；别的外来节点保留否决权。
 * @param event - 原始会话事件。
 * @returns 本插件（或上游删除插件）产生的 user/message 返回 true。
 */
export function isOwnPlaceholder(event) {
  const data = event && event.data;
  const source = data && (data.source || (data.message && data.message.source));
  return sourceOwnsPlugin(source);
}

/**
 * 把一个界面目标变成一个规范的替换区间。
 *
 * 三种模式：
 *   - `message`：正好是被点的那条用户消息（真人提问或注入上下文）——永远不是系统提示词，
 *     也永远不是助手消息；
 *   - `step`：被点步骤的 assistant 消息 + 该步骤产生的全部 tool/result，
 *     所以 tool_use / tool_result 配对永远不会被拆开；
 *   - `reply`：被点回合里「最后一条真人提问」之后的全部 surface 节点（注入上下文、助手步骤、
 *     工具结果），于是提问留下、整次回答尝试离开上下文。
 *
 * 返回的窗口在 surface 顺序上连续、且不含任何外来节点，所以落地的替换不会遮蔽用户没瞄准的内容。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @param request - `{ mode, seq?, messageId?, turn? }`。
 * @returns `{ mode, targetSeq, startSeq, endSeq, shadowed, turn, step }`。
 * @throws {PlanError} 目标无法规划时抛出带稳定 code 的错误。
 */
export function planRange(events, surfaceNodes, request) {
  const mode = request && request.mode;
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]));
  const turnOf = turnIndex(events);

  let targetSeq = typeof request.seq === 'number' ? request.seq : undefined;
  if (targetSeq === undefined && typeof request.messageId === 'string' && request.messageId !== '') {
    for (const event of events) {
      if (messageIdOf(event) === request.messageId) {
        targetSeq = event.seq;
        break;
      }
    }
  }
  if (targetSeq === undefined && mode === 'reply' && typeof request.turn === 'number') {
    for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
      const seq = surfaceNodes[index];
      const event = bySeq.get(seq);
      if (!event) continue;
      const eventTurn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq);
      if (eventTurn === request.turn) {
        targetSeq = seq;
        break;
      }
    }
  }
  if (targetSeq === undefined) throw new PlanError('not-deletable', 'target not found');
  if (!nodeIndex.has(targetSeq)) throw new PlanError('already-deleted', 'target is not on the current surface');
  const target = bySeq.get(targetSeq);
  if (!target) throw new PlanError('not-deletable', 'target event not found');

  // surface 节点 0 是系统提示词头：官方 append 契约只允许用 system/message 精确改写那一个节点，
  // 而且界面也没有任何一行指向它。
  if (targetSeq === surfaceNodes[0]) throw new PlanError('not-deletable', 'the system prompt head cannot be deleted');
  if (target.type === 'system/message') throw new PlanError('not-deletable', 'the system prompt cannot be deleted');

  if (mode === 'message') {
    if (target.type !== 'user/message') {
      throw new PlanError('not-deletable', 'only user messages can be removed on their own');
    }
    const turn = turnOf.get(targetSeq);
    return {
      mode,
      targetSeq,
      startSeq: targetSeq,
      endSeq: targetSeq,
      shadowed: [targetSeq],
      turn: typeof turn === 'number' ? turn : 0,
      step: 0,
    };
  }

  if (mode === 'step') {
    if (target.type !== 'assistant/message' && target.type !== 'tool/result') {
      throw new PlanError('not-deletable', 'step deletion requires an assistant message or a tool result');
    }
    const turn = target.data && target.data.turn;
    const step = target.data && target.data.step;
    if (typeof turn !== 'number' || typeof step !== 'number') {
      throw new PlanError('not-deletable', 'step deletion requires a closed step');
    }
    const members = events
      .filter(
        (event) =>
          (event.type === 'assistant/message' || event.type === 'tool/result') &&
          event.data &&
          event.data.turn === turn &&
          event.data.step === step &&
          nodeIndex.has(event.seq),
      )
      .map((event) => event.seq);
    if (members.length === 0 || !members.includes(targetSeq)) {
      throw new PlanError('already-deleted', 'this step is no longer on the surface');
    }
    const memberSet = new Set(members);
    const indexes = members.map((seq) => nodeIndex.get(seq));
    const startIdx = Math.min(...indexes);
    const endIdx = Math.max(...indexes);
    const shadowed = surfaceNodes.slice(startIdx, endIdx + 1);
    if (shadowed.some((seq) => !memberSet.has(seq) && !isOwnPlaceholder(bySeq.get(seq)))) {
      throw new PlanError('range-not-clean', 'the step window contains unrelated surface nodes');
    }
    return {
      mode,
      targetSeq,
      startSeq: shadowed[0],
      endSeq: shadowed[shadowed.length - 1],
      shadowed,
      turn,
      step,
    };
  }

  if (mode === 'reply') {
    const turn = target.data && typeof target.data.turn === 'number' ? target.data.turn : turnOf.get(targetSeq);
    if (typeof turn !== 'number') throw new PlanError('not-deletable', 'the target does not belong to a turn');
    let lastHumanIdx = -1;
    for (const event of events) {
      if (event.type !== 'user/message') continue;
      if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue;
      if (turnOf.get(event.seq) !== turn) continue;
      const index = nodeIndex.get(event.seq);
      if (index !== undefined && index > lastHumanIdx) lastHumanIdx = index;
    }
    const members = [];
    for (const seq of surfaceNodes) {
      const index = nodeIndex.get(seq);
      if (index <= lastHumanIdx) continue;
      const event = bySeq.get(seq);
      if (!event) continue;
      // 系统提示词头是在第一个步骤里追加的，因此它的所属回合就是那个回合；
      // 它从来不是回复内容，绝不能用来锚定回复窗口。
      if (event.type === 'system/message') continue;
      const eventTurn =
        event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq);
      if (eventTurn !== turn) continue;
      members.push(seq);
    }
    if (members.length === 0) throw new PlanError('nothing-to-delete', 'the turn has no reply content left');
    const memberSet = new Set(members);
    const startIdx = nodeIndex.get(members[0]);
    const endIdx = nodeIndex.get(members[members.length - 1]);
    const shadowed = surfaceNodes.slice(startIdx, endIdx + 1);
    if (shadowed.some((seq) => !memberSet.has(seq) && !isOwnPlaceholder(bySeq.get(seq)))) {
      throw new PlanError('range-not-clean', 'the reply window contains unrelated surface nodes');
    }
    const closing = bySeq.get(members[members.length - 1]);
    const step = closing && closing.type === 'assistant/message' && typeof closing.data.step === 'number' ? closing.data.step : 0;
    return {
      mode,
      targetSeq,
      startSeq: members[0],
      endSeq: members[members.length - 1],
      shadowed,
      turn,
      step,
    };
  }

  throw new PlanError('not-deletable', `unsupported mode ${String(mode)}`);
}
