# CHANGELOG（WM 分叉）

本文件只记本分叉相对上游 `dsh-message-recall` 的差异，便于日后上游更新时合并。

## 2.6.1+wm.6

借鉴社区 `Moeblack/dsh-message-edit`（MIT，仅参考设计，未复制代码）后的第一批增强。

### 新增：用原提问重新生成（↻，含"重试任意回合"）
助手消息操作区新增 `↻`：
- 分支点取目标回合**之前**（`turn/start - 1`），该回合整段不进新会话 —— 与社区插件同款的"回合原子性"；
- 原用户输入交给**底座已有的 resume-send 管道**重发（写 `RESUME_PREFIX` 记录 → 打开子会话 → `claimResume` 自动投递），
  这条路径就是"编辑我的消息"在用的那条，已验证；
- 对任意历史回复点 `↻` = 重试该回合（同一实现，无需两套代码）；
- 该回合之后的内容留在旧会话里（`truncate` 语义）；**不采纳**社区的 `cascade: preserve`（会自动重跑多个回合、烧 token + 工具副作用）。

### 新增：思考块也可编辑
编辑对话框在该消息带 `reasoning` 块时出现「正文 / 思考」切换；宿主侧按 `blockKind`（`text` / `reasoning`）+
`blockIndex` 定位并改写，`rewriteAssistantArtifact` / `patchSeedEvent` 都支持。

### 修复：分支的预设与模型不再悄悄跑在默认档
- 预设改为扫日志里**最后一条** `agent-preset/selected`（只读 `header.agentPreset` 在"会话中途换过预设"时会偏）；
- 种子里没有 `request/header` 时记警告（子会话靠懒 resume 解析模型路由）；
- 客户端在建分支前捕获父会话的模型/挡位，打开子会话后写回（`modelSel.capture/apply`）。

### 加固：耐久屏障与失败可见性
- 建完子会话先 `ctx.sessions.flush()` 再返回成功，避免"刚建好就崩 → 分支内容丢"；
- 挂工作区失败不再静默：返回 `partial: true`，客户端提示"未归入工作区，重启后自动归位"，并由**启动自愈**兜底；
- 明确**不**采用社区的 `agents.create + runMaintenance` 事务缝（我们要接 preset/setup 一整条管线），
  也**不**采用"重造回合、丢弃工具链"的语义（与历史不一致），保持"只改文本、工具链保留"。

### 测试
离线单测扩到 **58 项**（新增：`closedTurns` / `planRegenerate` / `userTextOf` / `blockTextOf` /
`blockIndexOf` / `sessionPresetOf` / `modelRoutingOf`，以及 `patchSeedEvent` 的 `blockKind` 分支）。
## 2.6.1+wm.5

### UI：提示条在浅色/变量缺失主题下"黑字黑底"
`wmToast` 原来是"深色兜底背景 + `var(--dsw-alias-label-primary)` 文字"的混搭：这套主题里
背景变量缺失退回深色，文字变量却存在并解析成深色 → 全黑一片。

修复：抽出 `wmReadableTextColor(el)`（读元素**实际渲染背景**的亮度决定前景色），
提示条与编辑对话框共用它；提示条背景改用已验证的 `--dsw-alias-bg-layer-3`，
外加描边与文字投影，任何主题都可读。## 2.6.1+wm.4

### 修复：分支会话落"未分组"
根因：宿主半边**没有在 `inject` 里声明 `workspaceRegistry`**，属性访问抛
`cannot get property "workspaceRegistry" without inject`（实测日志每次都 `attach: "failed"`），
所以每建一个分支都进未分组。

修复：
- `inject` 增加 `workspaceRegistry`（以及本环境已验证可用的 `agents` / `sessionPersistence` / `agentPresets`，
  与管理插件同一组）；
- 归属判定与官方 `forkWorkspace` 同源：先在**工作区成员表**里找包含父会话的那个，
  找不到再按 cwd 匹配工作区路径；挂载走官方 `workspace.attachSession(childId)`，
  失败时用已验证的"先修索引（sessionPaths/record.mutate）再记账"兜底。

即：分叉后**留在父会话所在工作区**（同一段对话本来就属于同一个工作区）。

### 新增：启动自愈
apply 时异步扫一遍持久化的会话头：凡是"未归属任何工作区、但 `parentSession` 属于某个工作区"
的分支会话，挂回那个工作区。用于修复此前遗留的未分组分支，也兜住以后任何漏挂（每条都记日志）。

### 关于"直接用 DSH 自带的分叉"
DSH 自带分叉的子会话种子取自**活动父会话的事件流**（`agents.create({seed: source.events.slice(0,cut)})`），
所以拿到的必然是旧回复文本 —— 这正是"编辑不生效"的根源。本插件因此自己用改好的种子调
`ctx.sessions.create(...)`（同一族公开 API），但**归属/挂载完全照官方 `forkWorkspace` 的语义**，
所以分组表现与自带分叉一致。
## 2.6.1+wm.3

### 修复：切换卡死 / `< >` 失效 / 没归档（上一版 detach 方案的副作用）
上一版为了绕开"活动会话内存副本是旧文本"，用了 `ctx.sessions.store.get(id).detach()` 卸载活动会话。
后果是**该会话行从运行时与客户端列表里一起消失**：
- 客户端 `sessions.select` 抛 `unknown session`（来自 client 侧 session manager 的 summaries 校验），
  `controlledSwitch` 的 `waitForCurrent` 永远等不到 current → 卡在"正在打开新分支…"，
  `switchInFlight` 闸门被占住 → 连 `< >` 也点不动；
- 因为卡在打开步骤，`doArchive()` 从未执行 → **旧会话没有归档**；
- 被 detach 掉的分支此后不再被运行时引用，实测其工件在后续（重启/清理）中**被删除**。

**本版彻底移除 detach**（全文已无 `.detach()` 调用）。

### 重构：主路径改为"建分支时就用改好的种子"
新增宿主路由 `POST /bubble/assistant-branch`：
1. 取父会话（活动）的事件快照，按官方 fork 同样的切法截到目标回合的 `turn/end`（含），
   并把紧随其后的非 turn 事件一并带上，直到下一个 `turn/start`；
2. 在这段种子里只替换目标回复的 `text` 块（`patchSeedEvent`，不可变改写）；
3. `ctx.sessions.create(childId, { seed, inheritedEventCount, meta })` —— 公开服务 API，
   内部自己 `enter + announce`（客户端立刻拿到这一行）；API 的 session controller 会在
   打开/继续对话时按需 `resume` 出 agent（`resolve()` 对非 live 会话走 resume 路径）；
4. `workspace.attachSession(childId)` 挂进父会话所在工作区，失败时用已验证的
   `sessionPaths/record.mutate` 兜底。

这样**从一开始就没有旧文本的内存副本**：不需要 fork 后改写、不需要卸载、不会 stale、不会卡。
客户端改为：预登记关系（先铸 childId 并登记）→ 一次 `assistant-branch` → 受控切换打开 → 归档父会话。
`POST /bubble/edit-assistant` 保留为既有会话的修复工具（只改磁盘，界面刷新后可见）。

### 新增：版本家族自愈
`/bubble/relations` 读取时用官方 `workspaceRegistry.sessionKnown()` 剔除**已不存在**的成员
（判不了就当活着，绝不误删），避免翻页器里出现点不动的死版本。

### 已知损失
上一版 detach 掉的两个分支（`session-c2c27b0b…`、`session-8c5d8123…`）的工件已被后续清理删除；
改写前的内容仍留在 `$DSH_HOME/dsh-message-recall-wm/assistant-backups/<会话id>.jsonl`。
## 2.6.1+wm.2

### 修复：编辑我的回复"不生效"（关键）
现象：改写成功、分支与归档都正常，但界面上回复仍是原文。

根因（实测日志与磁盘双向确认）：
- `ctx.sessions.fork` 出来的子会话**在 fork 那一刻就已经是活动会话**（日志 `wasLive: true`），
  渲染端的消息页取自活动会话的事件流，不是磁盘；
- 而 DSH 的会话事件消息经 `deepFreeze` 处理（`dsh-session` 的 validate/snapshot 路径），
  外部无法就地改写内存事件对象；
- 于是磁盘已经是新文本（备份可比对），界面读到的仍是内存里的旧文本。

修复：改写落地后，若内存同步不可用（`patchLiveEventText !== true`），**卸载活动会话条目**
（`ctx.sessions.store.get(id).detach()`，与已验证的会话删除路径同款 API），让客户端随后
`prepare/open` 时从磁盘重读；卸载会触发一次收尾 drain，因此紧接着**复核磁盘**，若发现被回写成
旧文本就按同一份字节重新发布。返回值新增 `memoryPatched` / `detached` / `reApplied` 供诊断。

### 修复：对话框在浅色主题下"取消"看不见
自绘对话框此前只用 `--dsw-alias-*` 变量并带深色兜底值，变量缺失/浅色主题时退化成"白字白底"。
现在：改用本插件已验证可见的 token（`--dsw-alias-bg-layer-3` / `--dsw-alias-border-l2` /
`--dsw-alias-fill-l2`），并在插入后读一次卡片计算背景色的亮度，自动选深/浅前景色 —— 任何主题都可读。

### 变更：目标定位改走 messageId
chat 投影的 block 用 `kind`，事件日志里的 block 用 `type`（两者不同），客户端不再解析 block：
改为只带槽位必给的 `sessionId + messageId`，由宿主按 `assistant/message.data.message.id` 定位
（实测 2936/2936 命中）并回传原文用于预填。

### 新增：自检与诊断
- 客户端 `apply` 主体包 try/catch：本插件异常只撤自己并带堆栈写日志，不再连带影响其它功能；
- 启动自检行记录总开关状态、各槽位注册结果与注册错误；
- ✎ 前 5 次渲染记录槽位实际下发的 props；
- 改写返回 `memoryPatched / detached / reApplied`，客户端一并落日志。
## 2.6.1+wm.1

基线：上游 2.6.1。

### 改名（防上游覆盖）
- `package.json`：`name` → `dsh-message-recall-wm`，`version` → `2.6.1+wm.1`，`dsh.displayName` → `MessageRecall WM`，`repository.directory` 同步。
- `cordis.patch.yml`：插件行 `- id: … / name: …` → `dsh-message-recall-wm`。
- `lib/index.js`：`export const name`、`OWN_PACKAGE_NAME`、日志文件 `$DSH_HOME/dsh-message-recall-wm.log`、日志前缀 → 新名。
- `lib/client.js`：`window.__ModuleLoader__.load({ id })` → 新名；插件 `return { name }` → 新名。
- `lib/index.js` 自更新路由：`pnpm up dsh-message-recall` → `pnpm up dsh-message-recall-wm`（绝不 up 上游包名，否则会把分叉覆盖掉）。
- **故意未改**：路由前缀 `/bubble/*`、localStorage 键 `dsh-message-recall:*`、关系域 `recall_relations`、设置命名空间 `dsh-message-recall` —— 保证从上游升级过来时用户设置与版本关系不丢。

### 新增：编辑我的回复（助手消息重编辑）
- 新增 `lib/wm-assistant-edit.js`：
  - `decodeArtifactBuffer` / `encodeArtifactSync`：多帧 zstd 工件解码与 DSH 物理布局编码（帧 0 恰好是 header 行）。
  - `assistantTextOf` / `locateAssistantLine` / `rewriteAssistantArtifact`：定位并改写某条 `assistant/message` 的 `text` 块（纯函数，可离线测试）。
  - `readSessionArtifact` / `editAssistantText`：宿主侧读改写（先 `sessionPersistence.readRaw`，失败回落磁盘扫描），原子发布（temp + rename + 回滚）、落盘自检、改写前一次性明文备份、活动会话 flush + `preparations.invalidate`。
  - `resolveAssistantBoundary`：边界 = 目标回复所在回合**自己的** `turn/end`（子会话保留该回合）；未闭合回合拒绝。
- `lib/index.js` 新增路由：
  - `POST /bubble/recall-assistant` `{sessionId, targetSeq?, turn?}` → `{boundary, turn, targetSeq}`。
  - `POST /bubble/edit-assistant` `{sessionId(子会话), targetSeq?, turn?, oldText?, newText, replaceAllTextInMessage?}` → `{replacedSeq, turn, wasLive, backupPath}`。
- `lib/client.js` 新增：
  - `findAssistantReplyTarget(props, messageId)`：从 turn-tail 节点取 `turn / seq / 原文`。
  - `openAssistantEditDialog(opts)`：自绘对话框（Electron 无 `prompt`/`confirm`），Esc 取消、Ctrl+Enter 确定、随状态显示进度。
  - `runAssistantEdit(...)`：边界 → 预登记关系 + `ctxSessions.fork` → 改写 → 重挂关系 → `controlledSwitch` 打开并归档父会话。
  - `AssistantEditAction`：注册进 `conversation.chat.assistant-actions`（order 20），受总开关门控。
  - `wmToast(...)`：轻提示。
- 新增 `tests/wm-assistant-edit.test.mjs`（20 项断言，含真实日志副本上的逐字节比对）。

### 与上游「编辑我的消息」的差异
- 不需要 `resume-send` 机制（没有要重发的内容），因此不写 `dsh-message-recall:resume-send:*`。
- 不做图片桥接（回复不是用户输入）。
- 边界取"目标回合自己的 `turn/end`"而非"目标消息之前最近的 `turn/end`"——这正是"保留该回合、只改回复"的关键。
