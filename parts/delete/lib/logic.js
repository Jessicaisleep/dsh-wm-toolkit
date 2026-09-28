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
 * 构造写进替换事件的 source。
 *
 * 会话格式 v4 起，插件 source 必须是「生产者自己的 kind」，即 `{ kind: 'plugin:<完整插件名>' }`；
 * v3 时代的 `{ kind: 'plugin', plugin: X }` 包装已被 v4 写入守卫拒绝
 * （`assertV4RowAdmission` → `format v4 message requires a producer-owned source kind`），
 * 一旦写出就会让整个 turn 在 step 0 失败。这里统一从这里取 source，避免读写两侧再次漂移。
 *
 * @param id - 插件标识，默认本插件。
 * @returns v4 规范的 source 对象。
 */
export function pluginSource(id = PLUGIN_ID) {
  return { kind: `plugin:${id}` };
}

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
 * 一条事件是不是「真人亲手发的消息」（= 提问，含回合中途插进来的追问）。
 *
 * 这是「删除回复」的语义锚点：真人提问一律保留，其余的（注入上下文、每一步的助手消息、
 * 工具结果）都算这一轮的回复内容。回合中途插进来的追问会把回复切成前后多段——**每一段
 * 都要删**，只删最后一段会留下没有提问的孤儿残块（真实事故：回合 16 中途插过一次话，
 * 删掉「这条回复」之后，插话之前的两步助手输出还留在转录上）。
 *
 * @param event - 原始会话事件。
 * @returns 真人提问返回 true。
 */
export function isHumanPrompt(event) {
  const data = event && event.data;
  return event !== undefined && event !== null && event.type === 'user/message' && Boolean(data && data.source && data.source.kind === 'user');
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
 * 两种形状都要认：v3 及更早的日志里是 `{ kind: 'plugin', plugin: X }`（退役包装），
 * v4 会话格式规范化后是 `{ kind: 'plugin:X' }`（当前写法，见 {@link pluginSource}）。
 * 本机两种历史日志都要能重建台账，所以读侧同时接受，写侧只写 v4 形状。
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
 * 每一次删除都是一个替换事件，其消息 source 为 `{ kind: 'plugin:dsh-wm-toolkit' }`
 * （v4 当前写法）或 `{ kind: 'plugin', plugin: 'dsh-wm-toolkit' }`（v3 历史日志）。模式由被遮蔽的窗口反推：
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
 * 浏览器半边不能给它们显示删除入口。这里与 {@link planRange} 的 reply 模式对齐：
 * **只要这个回合里还有真人提问之外的 surface 内容（注入上下文、助手步骤、工具结果），
 * 这个回合就还能删**——不论那些内容夹在回合中途的追问之前还是之后。旧实现要求内容
 * 落在「最后一条真人提问」之后，于是删完最后一截之后，「回合里还有残块」的回合
 * 在界面上反而没有入口，残块就永远清不掉。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @returns 至少还有一个非提问 surface 节点的回合号。
 */
export function deletableReplyTurns(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const turnOf = turnIndex(events);
  const members = new Map();
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq);
    if (!event || event.type === 'system/message') continue;
    const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq);
    if (typeof turn !== 'number') continue;
    if (isHumanPrompt(event)) continue;
    members.set(turn, (members.get(turn) ?? 0) + 1);
  }
  return [...members.keys()].sort((a, b) => a - b);
}

/**
 * 已经被删过、而且现在确实没有任何回复内容留在 surface 上的回合号。
 *
 * 为什么需要它：转录里有一批行**映射不到 surface 节点** —— 客户端自己合成的过程分组行
 * （`data-step-process`，标题就是「执行了命令 / 已完成分析」那种折叠壳）、模型重试行、
 * 中断的工具行。它们的锚点是 `tool/call`、`llm/retry` 这类**非 surface 事件**，或者干脆
 * 是客户端合成的分组键，按「seq 在不在隐藏台账里」永远判不出来，于是删完之后转录上
 * 留一串过程壳 —— 观感就是"AI 回复删了，壳还杵在那儿"。
 *
 * 这些回合的共同点：**已经被本插件删过内容，且现在 surface 上除真人提问以外一无所有**。
 * 浏览器半边据此按行上的 `data-chat-turn` 把整回合的壳行收起（提问行不受影响）。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @param hiddenSeqs - 本插件替换事件遮蔽掉的 seq 集合。
 * @returns 已被删空、只剩提问（或什么都不剩）的回合号。
 */
export function clearedReplyTurns(events, surfaceNodes, hiddenSeqs) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const turnOf = turnIndex(events);
  const turnOfEvent = (event) => {
    if (!event) return undefined;
    if (event.data && typeof event.data.turn === 'number') return event.data.turn;
    const turn = turnOf.get(event.seq);
    return typeof turn === 'number' ? turn : undefined;
  };
  const touched = new Set();
  for (const seq of hiddenSeqs) {
    const event = bySeq.get(seq);
    if (!event || event.type === 'system/message' || isHumanPrompt(event)) continue;
    const turn = turnOfEvent(event);
    if (turn !== undefined) touched.add(turn);
  }
  if (touched.size === 0) return [];
  const alive = new Set();
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq);
    if (!event || event.type === 'system/message' || isHumanPrompt(event)) continue;
    const turn = turnOfEvent(event);
    if (turn !== undefined) alive.add(turn);
  }
  return [...touched].filter((turn) => !alive.has(turn)).sort((a, b) => a - b);
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
 * 把一个回合的 surface 内容切成「回复段」。
 *
 * 一个回合里可以有多条真人提问——除了开场那条，还有你在 agent 干活途中补发的
 * 追问（steering，日志里同样是 `user/message` + `source.kind === 'user'`，
 * 只是插在回合的第 N 步之前）。于是这一轮的回复被提问切成若干段：
 *
 *   指令A → [回复段1] → 中途补发指令C → [回复段2] → 回合结束
 *
 * 段的边界由**提问**和**surface 索引的连续性**共同确定：提问本身永远不进段
 * （界面上的删除提问走 message 模式），索引不连续（中间夹了别人的节点）也必须断开，
 * 否则替换区间会遮蔽到不相干的内容（官方契约会拒，我们自己的 range-not-clean 也会拒）。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @param turn - 要切分的回合号。
 * @returns 每个回复段一条：`{ startSeq, endSeq, shadowed, seqs, assistantSeqs, clean }`；
 *   `assistantSeqs` 是段内所有 `assistant/message` 的 seq（**最后一个**就是这一段的"段尾行"——
 *   段尾往往是个工具结果，而删除按钮只能挂在助手行上，所以宿主报给浏览器的是它）。
 */
export function replySegments(events, surfaceNodes, turn) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const turnOf = turnIndex(events);
  const humanIndexes = [];
  const members = [];
  surfaceNodes.forEach((seq, index) => {
    const event = bySeq.get(seq);
    if (!event) return;
    // 系统提示词头是在第一个步骤里追加的，因此它的所属回合就是那个回合；
    // 它从来不是回复内容，绝不能进段。
    if (event.type === 'system/message') return;
    const eventTurn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq);
    if (eventTurn !== turn) return;
    if (isHumanPrompt(event)) {
      humanIndexes.push(index);
      return;
    }
    members.push({ index, seq, assistant: event.type === 'assistant/message' });
  });
  // 段只从该回合**第一条**真人提问之后开始：提问已经不在 surface 上（被删过）时，
  // 回合里剩下的内容就都是可清的残块。
  const firstHumanIdx = humanIndexes.length > 0 ? Math.min(...humanIndexes) : -1;
  const runs = [];
  let run = null;
  for (const member of members) {
    if (member.index <= firstHumanIdx) continue;
    if (run === null || member.index !== run.endIndex + 1) {
      if (run !== null) runs.push(run);
      run = { startIndex: member.index, endIndex: member.index, seqs: [member.seq], assistantSeqs: member.assistant ? [member.seq] : [] };
      continue;
    }
    run.endIndex = member.index;
    run.seqs.push(member.seq);
    if (member.assistant) run.assistantSeqs.push(member.seq);
  }
  if (run !== null) runs.push(run);
  return runs.map((segment) => {
    const shadowed = surfaceNodes.slice(segment.startIndex, segment.endIndex + 1);
    const memberSet = new Set(segment.seqs);
    return {
      startSeq: shadowed[0],
      endSeq: shadowed[shadowed.length - 1],
      shadowed,
      seqs: segment.seqs,
      assistantSeqs: segment.assistantSeqs,
      clean: !shadowed.some((seq) => !memberSet.has(seq) && !isOwnPlaceholder(bySeq.get(seq))),
    };
  });
}

/**
 * 把一个界面目标变成一个规范的替换区间。
 *
 * 三种模式：
 *   - `message`：正好是被点的那条用户消息（真人提问或注入上下文）——永远不是系统提示词，
 *     也永远不是助手消息；
 *   - `step`：被点步骤的 assistant 消息 + 该步骤产生的全部 tool/result，
 *     所以 tool_use / tool_result 配对永远不会被拆开；
 *   - `reply`：被点回合里**被点的那一段**回复内容（注入上下文、助手步骤、工具结果），
 *     提问一律保留。一个回合里可以有多条提问（回合中途补发的追问），它们把回复切成多段，
 *     默认只删被点的那一段（scope='segment'，所见即所得）；显式给 `scope: 'turn'`
 *     时删掉整轮的所有段。定位不到目标所在段（目标已离场 / 只给了 turn 号）时回退整轮。
 *
 * 返回的窗口在 surface 顺序上连续、且不含任何外来节点，所以落地的替换不会遮蔽用户没瞄准的内容。
 *
 * @param events - 连续的完整原始事件日志。
 * @param surfaceNodes - 当前 surface 的 seq（模型顺序）。
 * @param request - `{ mode, seq?, messageId?, turn?, scope? }`；`scope` 只对 reply 有效，
 *   `'segment'`（默认）只删被点的那一段，`'turn'` 删整轮的全部回复段。
 * @returns `{ mode, targetSeq, startSeq, endSeq, shadowed, windows?, scope, segmentCount, turn, step }`；
 *   `windows` 里每个元素是一段要被替换的窗口，宿主半边按它逐段追加替换事件。
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
  const target = bySeq.get(targetSeq);
  const targetOnSurface = nodeIndex.has(targetSeq);
  // 整轮删除（reply + scope='turn'）不依赖目标自己还在场：目标已经离场的回合也能一次清干净。
  // 其余情况（单条消息 / 单步 / 只删被点的那一段）目标必须还在 surface 上，否则就是
  // 已经删掉了——回 already-deleted，别顺手删到别的东西。
  const wholeTurn = mode === 'reply' && request !== undefined && request !== null && request.scope === 'turn';
  if (!targetOnSurface && (target === undefined || !wholeTurn)) {
    throw new PlanError('already-deleted', 'target is not on the current surface');
  }
  if (!target) throw new PlanError('not-deletable', 'target event not found');

  // surface 节点 0 是系统提示词头：官方 append 契约只允许用 system/message 精确改写那一个节点，
  // 而且界面也没有任何一行指向它。
  if (targetOnSurface && targetSeq === surfaceNodes[0]) {
    throw new PlanError('not-deletable', 'the system prompt head cannot be deleted');
  }
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

    const segments = replySegments(events, surfaceNodes, turn);
    if (segments.length === 0) throw new PlanError('nothing-to-delete', 'the turn has no reply content left');

    // scope='segment'（默认）：只删**被点的这一条回复**——你在 D 位置点删除，留下
    //   「指令A——AI回复B——中途补发指令C」，不会顺手把 B 也挖掉。
    // scope='turn'：删掉整轮的全部回复段（方案一），提问一律保留。
    // 段定位失败（目标不属于任何回复段：它是提问、系统消息或被别的东西挡着）就报错，
    // 绝不静默扩大范围——"删多了"比"没删掉"更糟糕。
    const scope = wholeTurn ? 'turn' : 'segment';
    let chosen = segments;
    if (scope === 'segment') {
      const owner = segments.find((segment) => segment.seqs.includes(targetSeq));
      if (owner === undefined) throw new PlanError('not-deletable', 'the target is not part of a reply segment');
      chosen = [owner];
    }
    if (chosen.some((segment) => !segment.clean)) {
      throw new PlanError('range-not-clean', 'the reply window contains unrelated surface nodes');
    }

    const ranges = chosen.map((segment) => ({ startSeq: segment.startSeq, endSeq: segment.endSeq, shadowed: segment.shadowed }));
    const shadowed = ranges.flatMap((range) => range.shadowed);
    const closing = bySeq.get(ranges[ranges.length - 1].endSeq);
    const step = closing && closing.type === 'assistant/message' && typeof closing.data.step === 'number' ? closing.data.step : 0;
    return {
      mode,
      targetSeq,
      startSeq: ranges[0].startSeq,
      endSeq: ranges[ranges.length - 1].endSeq,
      shadowed,
      // 多段窗口：宿主半边按这个列表逐段追加替换事件（startSeq/endSeq/shadowed 是它的
      // 首段与并集，保持旧字段对老调用方的兼容）。
      windows: ranges,
      scope,
      segmentCount: segments.length,
      turn,
      step,
    };
  }

  throw new PlanError('not-deletable', `unsupported mode ${String(mode)}`);
}
