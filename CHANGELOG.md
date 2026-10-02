# Changelog

本包是**组合版**：对外一个 DSH 插件（一个包、一个插件 id），内部由三个独立半边构成。
半边各自的详细变更史保留在 `parts/recall/CHANGELOG-WM.md` 与 `parts/manager/CHANGELOG.md`；
本文件只记录**面向使用者**的包级版本。

## 0.2.12 — 2026-10-02

### 修：v4 会话被判成「没有磁盘记录」，移动/迁移静默失效

移动一个**有内容**的会话到别的工作区时弹：

> 操作失败：会话 session-… 没有磁盘记录（不存在，或是一个尚未发送任何消息的空白会话），无法移动

而那个会话磁盘上明明有 109894 字节、还在持续写入。

**根因**是宿主半边两处**硬编码的会话日志文件名列表**只列到 v3：

```js
["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"]
```

现代 DSH 写的是 `session.v4.jsonl.zstd`，**不在列表里** → 磁盘兜底扫描整个跳过它 →
`moveSession()` 找不到 header → 报「没有磁盘记录」。跟会话有没有内容、目标工作区空不空
**都无关**。同一个坑 `wm-relocate.js` 早就踩过并修过（那里的注释写着「只认 v3 会把 v4
会话当成没有日志整个跳过——迁移于是静默失效」），这次把三处统一成单一来源 `LOG_NAMES`。

实测（本机真实数据）：出故障的会话用新列表扫描命中，用旧列表扫描 **0 命中**。

### 修：弹窗出现后所有对话输入框卡死，只能重启 DSH

错误提示用的是 `window.alert()`。它在 Electron 里是**原生模态**，会阻塞渲染进程的事件
循环；用户点掉「确定」之后 DSH 自己的输入框再也拿不回焦点——表现为「这个对话框一出现，
所有对话输入框全部卡死，只能重启 DSH」。

两处 `window.alert`（右上角菜单报错、工作区搬家完成提示）全部换成插件自己的**非阻塞
内联提示**：错误走组件内气泡（8 秒自动消失，点一下关掉），成功走面板内提示条。
新增回归测试**禁止客户端半边出现 `window.alert`**。

## 0.2.11 — 2026-09-30

### 改：工作区迁移换位置、换名字，目标文件夹改用系统选择器

**三处变化**：

1. **入口挪到会话右上角**（`conversation.session.header.utilities`，跟「在应用中打开 / 计划 /
   导出会话日志」同一排）。原来的位置在侧边栏底部，和「会话管理」「Lark」挤在一行。
2. **名字改为「迁移工作区」**（原「迁移到新文件夹…」）。旧名字极容易被读成
   「把这段对话搬到另一个工作区」，而它搬的是**工作区文件夹本身**——顺带说清楚：
   `git log -S "选择文件夹"` 全历史 0 命中，这个入口从 `0.1.0` 起就是手填路径的输入框。
3. **目标位置改用系统文件夹选择器**：点「选择文件夹…」直接拉起系统对话框
   （官方 `remote.directoryPicker`，本机是 `127.0.0.1` + win32 ⇒ native），选完显示
   `将搬到：<完整路径>`；手填路径依然可用。语义仍然是**「选父文件夹，工作区文件夹以原名搬进去」**。

**点开不再先弹一层工作区列表**：以前无法确定当前会话属于哪个工作区时，会退化成
「先展开现有工作区列表让你选」。现在**一律直接开对话框**，对话框顶部只在确实认不出
当前工作区时才出现工作区下拉。

**当前工作区怎么认**：`conversation.session.header.utilities` 会把当前会话 id 作为
`sessionId` prop 直接传进来（官方契约 `standardProps` 里就写着 `sessionId: SessionId`），
优先级为 ① 该 id 落在哪个工作区的 `sessionIds` 里 → ② 会话快照的 `workspaceId` →
③ 会话 `cwd` 对工作区 `path` → ④ 只剩一个工作区就用它。

### 修：点「选择文件夹…」报 `cannot get property "remote.directoryPicker" without inject`

**根因（cordis 的服务解析机制，不是操作问题）**：

- 每个 remote 命名空间在服务表里的键名是**带点的全名**（官方 `dsh-api-gateway` 里
  `function remoteServiceKey(namespace) { return \`remote.${namespace}\`; }`），所以报错信息里
  才会出现 `remote.directoryPicker` 这个带点的名字；
- 更关键的是，`ctx.remote.<ns>` **按调用栈当前上下文校验 inject**。官方
  `dsh-api-job-controller` 的注释把这点写得很直白：命名空间要在自己上下文还是当前上下文时
  取好，因为后续访问发生在 *"a React event, a carrier retry — whose dynamic context has
  **not declared** `remote.job`"*。
- 我们原来正是在**按钮点击的 React 回调里**才去取 `wmRuntime.remote.directoryPicker`，
  那条栈没有声明这个服务，于是抛错。

**修复**：在 `apply(ctx)` 里用 `ctx.inject(["remote", "remote.directoryPicker"], cb)` 起一个
独立 fiber，**在声明了该服务的上下文里**提前把句柄存进模块级变量；点击时直接用存好的句柄。
读取优先走 `ctx.get(...)`——cordis 源码原文 *"Read a service from the store without the
inject requirement"*，它是唯一不要求 inject 的读取口。拿不到服务时，这个 fiber 只是挂着，
**不拖累插件主体**：按钮照常注册，选择器自动退回手填路径。

### 修：连点「迁移工作区」会开出多个窗口

对话框是命令式 portal 挂在 `document.body` 上的，没有单例保护。现在加了模块级
`wmMigrateOpen`：已经开着就只把焦点还给里面的输入框，不再开第二个；关闭（含 Esc）时清空。

### 修：左下角「会话管理」被挤成竖排

**现象**：三个按钮（远程控制 / 会话管理 / Lark）挤在一行时，带汉字的按钮被压到**每行一个字**；
Lark 那个是自带边框的 13px 药丸、不会缩，看着反而像"变大了"。

**根因**：官方那行 `_footerActions` 是 `display:flex` 且不换行，而 flex 子项默认
`min-width:auto` —— 带汉字的按钮 min-content 就是**单个字的宽度**。

**修复**：给那行加 `flex-wrap:wrap` + `row-gap`，子项 `flex:0 0 auto`（挤不下就**换行**，
不压字）；窄轨（rail 56px）时跟随官方同类占用者（PluginsPanelIcon / CordisPanel）**只显示图标**。

### 新增宿主接口

| 接口 | 用途 |
|---|---|
| `GET /session-manager/api/workspace-migrate/capabilities` → `{intoParent:true, version:2}` | 客户端据此判断宿主那半边是否为**认识 `intoParent`** 的新版；旧宿主会红字提示「宿主那半边还是旧代码，请先完整重启 DSH」并禁用提交 |

宿主对 `intoParent` 请求会先把「父文件夹 + 原文件夹名」拼成目标路径，**并且只在与原路径不同时**
才检查同名占用；同名就拒绝（`目标位置已存在同名文件夹：…`）——否则旧语义会走
「目标已存在 ⇒ 只重指记录，不搬文件夹」，把工作区记录指到父文件夹上。

## 0.2.10 — 2026-09-29

### 修：桥接会话里点删除，报「这个会话当前未激活，请先打开该会话再删除」（可会话明明开着）

**现象**：在**飞书桥接**（lark-link）或 agents-anywhere 桥接出来的会话里删指令 / 回复，
界面报「这个会话当前未激活，请先打开该会话再删除」——会话明明就开着；更要命的是
`$DSH_HOME\dsh-wm-delete.log` 里**一条记录都没有**。

**根因**：插件把「会话 id 的合法形状」写死成了 uuid：

```
/^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
```

而 DSH 的会话 id **不只有 uuid**。实测两种桥接形状：

| 来源 | 会话 id 形状 | 含 `:` |
|---|---|---|
| 飞书（lark-link） | `lark-link:dm:oc_2a58…:mujqtyuo8ej7:0` | 是 |
| agents-anywhere | `aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A` | 否 |

两边于是各失败一半：**浏览器半边**判 `usableSessionId()` 为假，`confirm()` 直接
`publish({ failure: 'session-not-active' })` **一个请求都不发**——所以宿主日志全空，
排查时极容易被误读成「请求被服务端拒绝了」；**宿主半边**就算收到请求也会 400 invalid。

**修复**：不再按形状收紧，改成**路径安全 + 长度有界**的判定（非空、≤200、拒绝
`/ \` 与控制字符、拒绝 `.` / `..`），形状交给 `sessionQuery` / `sessionController` 去认
——认不出会明确回 404/409，比在本地猜准得多。

| 位置 | 改动 |
|---|---|
| `parts/delete/lib/client.js` | 白名单放宽；本地拦截改用新的失败码 `unsupported-session`（不再谎报「未激活」），并 `console.warn` 打出真实 id |
| `parts/delete/lib/index.js` | 同一个 `isSupportedSessionId()`；**路径穿越底线没放**（`../etc/passwd`、`a/b`、`a\b`、超长、空 → 仍 400） |
| 词典 | 新增 `error.unsupported-session`（中英对齐） |
| `parts/delete/tests/*` | 新增 8 条回归：两种桥接 id 能真的删掉、未打开时回 session-not-active 而不是 invalid、路径穿越/控制字符/超长仍 400、拒绝日志必须带 sessionId |

**顺带修掉一个排查陷阱**：删除半边的测试以前把日志直接写进**真实的** `$DSH_HOME`，
测试记录和生产记录混在同一个 `dsh-wm-delete.log` 里（里面成批的
`session-not-active` / `busy` / `invalid` 全是测试造的，能把人带偏很远）。
现在隔离到临时目录。

### 改：拒绝日志带上 sessionId

`/wm-delete/delete` 与 `/wm-delete/state` 的失败记录现在都带 `sessionId`，记的是
**原始未校验值**——非法 id 恰恰是最需要留痕的情况。之前日志里只有 `code`，
根本看不出是哪个会话出的问题。

### 文档

`RELEASE.md` 从「0.2.5 / CI 还没跑通」的旧状态更新到 0.2.9 现状：CI 全链路已通
（Trusted Publisher 早绑定）、已发布版本清单、本机已有 node/npm 不必再用 DSH 自带 Node、
发版幂等说明、以及用 sha256 比对已发布产物的验法。

## 0.2.9 — 2026-09-28

### 修：删完 AI 回复后，转录上还杵着一串过程壳（「执行了命令」「已重试模型请求」…）

**现象**：0.2.8 修好"插话回合只删一半"之后，删除本身已经生效（助手正文、思考、工具结果都走了），
但转录上仍留着一串**过程壳行**：

```
>- 执行了命令
>- 执行了命令
已重试模型请求（1/5） ·1s >
>- 执行了命令
                       ← 中途补发的指令（保留，正确）
>- 执行了命令
□ 已完成分析
? 向用户提出了问题
```

模型上下文里这些内容确实已经没了，但界面看着就是"没删干净"。

**根因**：这些行**不是**节点行，而是宿主客户端自己合成的行，插件的行定位根本够不到它们：

| 行 | 宿主 DOM | 为什么按 seq 判不出来 |
|---|---|---|
| 「执行了命令 / 已完成分析」等过程分组壳 | `ChatGroupSeat` 根节点：`data-chat-flow-key = JSON.stringify(["process", 成员键, 分组])`、`data-chat-turn`、`data-step-process` | 这个 flow key 是**客户端合成**的分组键，`useChat` 快照里没有对应节点 → 插件 `snapshot.nodes.get(key)` 落空 → 直接 `continue`，既不隐藏也没有入口。**组成员还渲染在这个壳的内部**，所以壳不收起来，里面的东西就一直在 |
| 「已重试模型请求」 | 模型重试行（anchor 是 `llm/retry` 事件） | `llm/retry`、`tool/call` 都是**非 surface 事件**，永远不会出现在隐藏台账里 |

**修复**（原位删除路线，不做分叉——见文末）：

| 位置 | 改动 |
|---|---|
| `parts/delete/lib/logic.js` | 新增 `clearedReplyTurns()`：算出**被本插件删过内容、且现在 surface 上除真人提问以外一无所有**的回合 |
| `parts/delete/lib/index.js` | `/wm-delete/state` 与 `/wm-delete/delete` 都回报 `clearedTurns`（删除响应当场就给，不必等防抖刷新） |
| `parts/delete/lib/client.js` | 合成行（`data-step-process`）单独一遍处理：①该回合已删空（`data-chat-turn ∈ clearedTurns`）→ 整行收起；②组内成员**全部**已被隐藏 → 壳跟着收起（成员渲染在壳内部，文档顺序保证成员先处理）。**真人提问行永不因回合删空而隐藏** |
| `parts/delete/lib/client.js` | 思考行（`[data-variant="think"]`）查快照同样回退 `data-chat-node-key`；删除响应没带 `clearedTurns` 时（旧宿主）退化为一次防抖刷新 |
| `parts/delete/tests/*` | 新增 5 条回归：`clearedReplyTurns` 的"删空/未删空"边界、宿主两次回报、过程壳收起与"还有活成员时不许收"、删空回合里的重试行收起而提问行保留 |

**用真实日志验证**（本次会话 `session-5c925107`，就是残留截图那条）：

```
被遮蔽 33 个节点、5 次替换事件
deletableReplyTurns = [1,4]
clearedTurns（新）    = [2,3]     ← 正是截图里残留「执行了命令」的那两个回合
  回合 2 / 3 在 surface 上仅剩：真人提问（保留），其余全是已删内容
```

### 路线决定：不做「分叉 + 归档」

考虑过用「在删除位置分叉出新会话 + 旧会话归档」来实现删除（好处：新会话物理上就没有被删内容，
零 DOM 判据、零残留）。**不做**，理由：

- **fork 只能砍尾巴**。`A B C D → 留 A C`（中间挖空，正是本插件的核心场景）一次 fork 表达不了；
  能表达的只有"删掉末尾的 D"。
- 删单条指令、删某一步，fork 同样表达不了。
- 代价不小：同一入口两套语义、会话链膨胀、归档/跳转交互，以及 goal、token 统计、
  项目投影缓存、recall 关系等旁路数据都要跟着迁移。

所以维持**原位删除**（surface 层替换 + 精准行收起）。若将来确实需要"物理干净的新会话"，
它更适合作为一个独立功能（「以此为界重建会话」），而不是删除的默认路径。

### 改：删「这条回复」默认只删**你点的那一段**，每段都有自己的删除按钮

**现象**：0.2.8 把「这条回复」实现成"这一轮所有回复段一起删"，于是点最后一条回复的删除，
连**插话之前那几段**（已经结束的那几轮）也一起没了——"删得太干净"。

**日志证据**（本次会话 `session-5c925107`，23:11:47 那一次点击）：

```
replacement 1024  replace 710..763    ← 段1（对提问 708 的回复）
replacement 1025  replace 768..801    ← 段2（对提问 767 的回复）
replacement 1026  replace 806..844    ← 段3
replacement 1027  replace 849..994    ← 段4（用户点的就是这条回复）
同一秒、4 条替换 = 整轮被一次删光
```

**规格**（用户当时给的两种方案）：

- **方案一**：删 D 时留下「指令A —— 中途补发指令C」（整轮删回复，提问全留）；
- **方案二**：在 D 位置只删 D，留下「指令A —— AI回复B —— 中途补发指令C」——
  **前提是 AI 回复 B 那里也要有删除按钮**。

现在两种都给了，**默认走方案二**，方案一退到确认框里的显式勾选。

| 位置 | 改动 |
|---|---|
| `parts/delete/lib/logic.js` | 新增 `replySegments()`：把回合按真人提问切成回复段（提问作分隔符 + surface 索引连续），返回每段范围、`assistantSeqs`（段尾助手消息）与 `clean` |
| `parts/delete/lib/logic.js` | `planRange` 的 reply 支持 `scope`：默认 `'segment'` **只删被点的那一段**；`'turn'` 才删整轮。目标已离场时默认回 `already-deleted`（不再顺势扩大范围），只有显式整轮才继续清理残块 |
| `parts/delete/lib/index.js` | `/state` 新增 `segmentsByTurn`（每轮段数）与 `segmentTails`（每段段尾助手消息 seq）；`/delete` 透传 `scope` |
| `parts/delete/lib/client.js` | **段尾助手行**长出「删除这段回复」按钮（按 `segmentTails` 判定；段信息未抓回时乐观放行）——回合中途插话之前的那些段从此也有自己的入口，不再只有回合结尾才有；过程行 / 回合尾行 / 官方助手操作条照旧 |
| `parts/delete/lib/client.js` | 确认框在该轮段数 > 1 时提供「同时删掉这一轮里其它 N 段回复」勾选（**默认关闭**），勾上才下发 `scope: 'turn'` |
| `parts/delete/tests/*` | 新增 9 条回归：默认只删一段 / `scope=turn` 才整轮 / `replySegments` 段尾锚点 / 离场目标默认 `already-deleted` / 宿主两次追加与官方 `foldSurface` 验收 / 段尾行有按钮而段中间行不重复 / 段信息缺失时乐观放行 / 确认框下发 `scope` |

**真实日志回放验证**（同一条会话，误删之前的 turn 4）：

```
turn 4 共 4 段：  段1 710..763（段尾助手 761）
                  段2 768..801（段尾助手 799）
                  段3 806..844（段尾助手 842）
                  段4 849..994（段尾助手 994）

① 点段4（最后一条回复）→ windows=[849..994]        ← 旧行为是 4 段一起删
② 点段1（插话之前那条）→ windows=[710..763]
④ 勾选「整轮」          → windows=[710..763, 768..801, 806..844, 849..994]
```

段尾那四条助手消息（761 / 799 / 842 / 994）就是四个按钮的落点——**每段恰好一个入口**。

## 0.2.8 — 2026-09-28

### 修：删「这条回复」删不干净 —— 回合中途插过话时，插话之前那截助手输出留在转录上

**现象**：一条长会话里删掉最后几轮的「这条回复」，删完之后转录末尾仍然挂着几个
助手步骤（助手气泡 + 工具卡），而且**再也没有入口能把它们删掉**：
点那几行自带的删除入口，回的是「这条内容已经从上下文中删除了」（`already-deleted`）。

**盘证据**（真实会话 `session-f054e001`，2705 条事件）：

| seq | 事件 | 状态 |
|---|---|---|
| 2543 | `user/message` 回合 16 的开场提问 | 已删（message 模式） |
| 2544 / 2546 / 2550 / 2552 | 回合 16 前两步的助手消息 + 工具结果 | **仍在 surface 上（残块）** |
| 2556 | `user/message` 回合 16 **中途插进来的追问**（steering） | 已删（message 模式） |
| 2557 … 2592 | 回合 16 追问之后的全部助手步骤 | 已删（reply 模式，一次遮蔽 15 个节点） |

**根因**（`parts/delete/lib/logic.js` 的 reply 分支）：窗口起点取的是该回合
**最后一条真人提问**（`lastHumanIdx`）。一个回合可以有两条以上的真人提问——
你在 agent 干活途中补发的那条会以 steering 消息的形式插进同一个回合。于是
「删除这条回复」只覆盖了插话**之后**的那一截（2557…2592），插话**之前**的
2544…2552 不在窗口里；而删用户消息是单条操作（`startSeq === endSeq`），
不会连带它的回复。两件事叠加，就留下一截没有提问的孤儿回复。

第二个坑让它变成死局：那几行的删除入口走的是官方助手操作条（reply + `messageId`），
传的是**已经离场的最终答案** id。`planRange` 开头一句
`if (!nodeIndex.has(targetSeq)) throw already-deleted` 直接把整条修好的路堵死。

**修复**：

| 位置 | 改动 |
|---|---|
| `parts/delete/lib/logic.js` | reply 模式改为「回合内**除真人提问以外**的全部 surface 内容」，按真人提问切成**多段窗口**（提问全部保留，插话前后两截一起删）；窗口起点改为该回合**第一条**真人提问之后，提问本身已不在场时整个回合的残块都算回复 |
| `parts/delete/lib/logic.js` | reply 模式允许目标已离开 surface：仍能按回合把残块清干净，不再一律回 `already-deleted` |
| `parts/delete/lib/logic.js` | `deletableReplyTurns` 与新的 reply 语义对齐：只要回合里还有非提问内容就报可删（旧实现会把"只剩残块"的回合报成没得删，界面上入口消失） |
| `parts/delete/lib/index.js` | 宿主按 `plan.windows` **逐段追加替换事件**（一段一个 `surfaceOp`）；某段被 surface 拒绝时不整单失败，已落地的那几段照常回报（`partial: true`），日志逐段留痕 |
| `parts/delete/lib/client.js` | 行定位改用裸节点键 `data-chat-node-key`（回退 flow key）：宿主给「思考」分组行发的 flow key 是 `JSON.stringify([nodeKey,"reasoning"])`，旧写法查不到节点 → **这类行永远不会被隐藏**，又是一种"删不掉的残留" |
| `parts/delete/lib/client.js` | 确认框文案改为「这一轮回复…你的提问会保留，回合中途插进来的追问也保留」 |
| `parts/delete/tests/*` | 新增 6 条回归：插话回合的两段窗口 / 目标离场仍可清理 / 无内容 `nothing-to-delete` / `deletableReplyTurns` 对齐 / 宿主两次追加与官方 `foldSurface` 验收 / 思考分组行隐藏 |

**用真实日志验证**（同一份 `session-f054e001`）：

```
【当时】旧逻辑 windows = [2557 … 2592]                    （15 个节点，留残块）
        新逻辑 windows = [2544 … 2552] + [2557 … 2592]     （19 个节点，干净）
【现在】旧逻辑 → already-deleted: target is not on the current surface
        新逻辑 → windows = [2544 … 2552]，同一次点击就把残块清掉
```

**语义变化（须知）**：「删除这条回复」= 删掉**这一轮 AI 的全部输出**；你在回合中途
补发的追问**会保留**（和开场提问一样），只是它前后的回复各算一段、一起被删。
单条提问仍然用用户消息上的垃圾桶单独删。

## 0.2.7 — 2026-09-26

### 修：删除消息写出退役的 v3 source，整个 turn 在 step 0 失败（DSH v4 格式适配）

**现象**：用过「删除消息」之后，该会话再也没法继续——之后每一次发消息都立刻失败，
而且**失败在 `step 0`**（还没开始跑就挂了），宿主机日志刷：

```
agent turn failed (session session-..., turn 17, step 0): format v4 message requires a producer-owned source kind
    at source (dsh-session-format-v3-to-v4/lib/index.js:126)
    at assertV4SourceRowAdmission (...:150)
    at assertV4RowAdmission (...:1112)
    at Object.encodeEvent (...:1097)
    at eventLine (dsh-session-persistence-jsonl/lib/index.js:955)
    at Proxy.encodeEventBatch (...:3196)
    at Proxy.appendLines (...:3216)
```

会话投影缓存也一直写不进去（`session projection cache: ... failed (cache stays stale)`），
于是界面里会话列表/预览不再更新。用户观感就是「这个对话打不开了」。

**根因**：删除半边追加替换事件时，source 仍按 v3 时代写：

```js
source: { kind: 'plugin', plugin: PLUGIN_ID },   // parts/delete/lib/index.js
```

而会话格式 v4 要求「生产者自己的 kind」，即 `{ kind: 'plugin:<完整插件名>' }`；
v4 行接纳守卫（`source()`）明确拒绝 `kind === 'plugin'` 的退役包装。

**注意这是写入路径出错，不是存储损坏**：坏事件被守卫拦下，**从未落盘**，
所以会话日志本身是干净的（实测 v4 日志 3780 行可 100% 读回）。
但只要有事件要写就整个 turn 崩掉，看起来就像「对话坏了」。
排查时别去修会话文件——文件没问题。

**修复**：

| 位置 | 改动 |
|---|---|
| `parts/delete/lib/logic.js` | 新增 `pluginSource()`，统一产出 v4 规范 source |
| `parts/delete/lib/index.js` | 写入点改用 `pluginSource()` |
| `parts/delete/tests/wm-delete-host.test.mjs` | 断言改为 v4 形状；新增回归测试：用**官方 v4 守卫**验收写出的事件，并确认旧写法会被拒 |

读侧**不变**：`sourceOwnsPlugin` 依旧同时认 `{ kind:'plugin', plugin:X }`（v3 历史日志）
与 `{ kind:'plugin:X' }`（v4），历史删除台账照常重建。

## 0.2.6 — 2026-09-26

### 修：DSH 2.0 更新后，左下角「会话管理」整块消失

**现象**：DSH 桌面端从 `0.1.5-rc.x` 更新到 `2.0.15` 之后，侧边栏左下角（设置上方）的
**「会话管理」席位不见了**。而其他一切正常 —— 会话顶栏的归档/移动/删除在、用户消息行的
撤回/编辑/复制/删除在、助手回复的删除也在。

**根因**：DSH 2.0 换了官方 primitives 的**图标命名规则**：

| | 命名 | 尺寸 |
|---|---|---|
| 旧版（≤ 0.1.5-rc.x） | `IconArchiveOutline20` | 写在名字后缀里 |
| 新版（2.0.x 起） | `IconArchiveOutlineRegular` | 作为 `{ size }` prop |

`FooterAction` 里渲染的是 `h(P.IconArchiveOutline20, { size: 14 })`，在新版下 `P.IconArchiveOutline20`
是 **`undefined`** → React 抛 `Element type is invalid` → **整个 `sidebar.footer.action` 席位渲染失败**。

这解释了为什么"只消失了这一个"：

- 顶栏的 `HeaderAction` 只渲染**纯文字按钮**，不用图标组件 → 不受影响；
- `parts/recall` 与 `parts/delete` 的行内按钮用的是**内联 SVG**（`innerHTML`），不走 primitives → 不受影响；
- 只有左下角那个席位渲染了 primitives 图标 → 只有它崩。

**修法**：

1. 新增 **跨版本图标解析器** `resolvePrimitiveIcon(base, legacySize)`：按
   `<基名>Regular` → `<基名>Medium` → `<基名>` → `<基名>Artwork` → `<基名><旧尺寸>`
   的顺序取第一个存在的组件；**解析不到返回 `null`，绝不返回 `undefined`**。
2. 新增 `renderPrimitiveIcon(node, props)`：解析不到时渲染 `null`（即"没有图标"），
   而不是让 React 崩掉整个席位 —— **图标缺失不该带崩一个功能入口**。
3. recall / manager 两个半边里所有 primitives 图标都改走解析器；工作区菜单项的图标候选表
   也从旧名字换成了新名字。
4. 顺带修掉一个同类隐患：`FooterAction`、顶栏 `HeaderAction` 之外，凡是直接 `P.某名字`
   取值的地方都改成了解析器（以后再改名只会"少一个图标"，不会"少一个入口"）。

### 测试

- 新增 `parts/manager/tests/icon-compat.test.mjs`（12 项）：
  - **行为层**：用「只有新版名」「只有旧版名」「两个都没有」三种 primitives 分别加载**真实半边**，
    断言渲染树里**绝不出现 `undefined` 组件类型**（那正是崩溃条件），并验证三种情况各自的降级表现；
  - **源码层**：断言三个客户端半边里不再出现"尺寸后缀"的老式图标名（注释除外），
    且图标必须经过解析器（禁止 `h(P.Icon…)` / `React.createElement(Icon…)` 直取）。
- 汇总从 11 套增至 **12 套**。

## 0.2.5 — 2026-09-24

### 修：最新发出的消息 / 刚完成的回复没有删除按钮，必须重启 DSH 才出现

**现象**：刚发的那条指令、刚完成的那个回复，行上没有垃圾桶；重启 DSH 后按钮才出现。

**根因**：`view.surface` / `view.replyTurns`（判断"内容是否还在模型上下文里"的依据）
**只在会话打开时抓了一次**：

- `load()` 在 `loaded === true` 且非 force 时直接返回；
- `OverlayEntry` 的 effect 只在 `controller` 变化时调 `load()`（非 force）。

于是新消息的 seq **永远不在**那份旧 surface 里 → `rowDeletable()` 判成"不可删"：

| 受影响的行 | 后果 |
|---|---|
| 用户消息行 | 不注入 DOM 按钮 ✗ |
| `turn-tail`（回合尾）行 | 被打上 `data-dshwd-no-target="1"`，而那条 CSS 会**把官方槽的按钮一起隐藏** ✗（所以 AI 回复也没按钮） |

重启后所有消息都变成"历史"，`/state` 一抓就包含它们 → 按钮出现。

**修法**（只改客户端半边）：

1. **新内容乐观放行**：行的 seq 比上次抓取时的日志末尾（`/wm-delete/state` 早就返回的
   `lastSeq` 字段）还大 → 说明是抓取之后才产生的 → 直接放行，**按钮立即出现**。
2. **防抖刷新**：`applyDom` 发现新内容时调度 `scheduleRefresh()`（800ms 防抖，
   把流式回复期间的连续变化合并成一次）→ `load(true)` 拉最新 surface 做精确校正
   （例如排除已被 `/compact` 移出上下文的内容）。
3. 老内容仍按 surface 精确判断，`data-dshwd-no-target` 的语义不变（该藏的还藏）。

**效果**：按钮即时出现（不等请求往返），稳态零额外请求。

### 测试

`parts/delete/tests/wm-delete-placement.test.mjs` 从 9 项扩到 17 项，新增覆盖：
新内容放行、`no-target` 不被设置、新回合 `turn-tail` 同样放行、老内容仍精确判断、
防抖调度不立即发请求、`dispose()` 清理计时器、`lastSeq === -1` 不误判、
`load()` 确实从 `/state` 读入 `lastSeq`。汇总仍 11 套。

## 0.2.4 — 2026-09-24

### 修：`coldSnapshot` 签名不匹配，启动时每个会话都抛错（既有 bug）

**现象**：每次启动 DSH，宿主日志里刷满

```
session-manager: post-boot cache refold failed for "session-...":
    TypeError: SessionLogOffset must be a non-negative safe integer, got undefined
...
session-manager: post-boot re-folded 0 session projection cache rows
```

**根因**：`sessionProjectionCache.coldSnapshot` 的真实签名是
**`coldSnapshot(meta, inheritedEventCount, events)`**（要**完整日志**），
而本插件三处都写成了 `coldSnapshot(id)`：

| 位置 | 原调用 |
|---|---|
| post-boot sweep | `await cache.coldSnapshot(header.id)` |
| 会话跨工作区移动后 | `await cache.coldSnapshot(sessionId)` |
| 工作区文件夹迁移后 | `await projectionCache.coldSnapshot(id)` |

于是 `identityOf(meta=字符串, inheritedEventCount=undefined)` 里的
`SessionLogOffset(undefined)` 抛错——**三处都被 catch 吞掉，等于从来没生效过**。

**修法**：不再调 `coldSnapshot`，改成**只读 header 的 identity 对账**
（新增 `reconcileProjcacheIdentity` / `reconcileProjcacheForSession`）：

- 这段 sweep 的**真实目的**（见 `apply()` 注释）只是"让缓存行的 identity 不过时"——
  identity 与当前 header 不匹配时，`recordFor()` 返回 undefined，冷列表路径会退化成
  `basename(cwd)`，把工作区名（例如 "DSH"）当成会话标题显示。**修正 identity 就足以消除症状**。
- 而 `coldSnapshot` 要求调用方提供**完整日志**——启动时对每个会话解压 MB 级 zstd 工件并不划算。
- 只修能确定修正的四个字段（`formatVersion` / `createdAt` / `cwd` / `isSeeded`）；
  **`inheritedEventCount` 原样保留**——工件 header 里没有它，缓存行里的值才是唯一来源。
- 顺带**去掉了对 `sessionProjectionCache` 服务的硬依赖**（拿不到该服务也能对账）。
- 三处调用都换成对账；迁移路径原本还有 `patchProjcache` 直接改 cwd，两者互补。

### 测试

- `parts/manager/tests/reconcile-projcache-identity.test.mjs`（12 项）：用**真实多帧 zstd 工件**
  跑通"定位工件 → 读 header → 对账缓存行"，覆盖一致时不写盘、各字段修正、
  `inheritedEventCount` 保留、`rows` 不丢、JSON 损坏/无 identity/无工件/非法参数等降级，
  以及一条**源码级回归**（断言 `coldSnapshot(` 调用与 `sessionProjectionCache` 依赖已消失）。
  汇总现在 11 套。

### 文档

两个 README 都补上了「删除任意一条指令或回复」的完整说明（点哪里删什么 / 与编辑·重生成的分工 /
机制 / 边界），测试构成也列了出来。

## 0.2.3 — 2026-09-24

### 修：损坏会话「打不开、归档不了、也删不掉」

**现象**：会话管理里有一行，点开报 `历史加载失败：session "..." not found（session/not-found）`，
点「归档」无效，点「删除会话」也没反应。

**根因**：`deleteSession` 只删了会话**工件目录**，**没删投影缓存行**
（`storages/session_projcache/sessions/<id>.json`）。工件没了 → 打不开；工作区账目被摘掉 → 落到未分组；
而列表项仍被运行中的快照持有 → 行不消失。删了工件却留下索引，就攒出一堆"幽灵行"。

> 顺带澄清一个容易误解的点：**投影缓存不是对话本体**。对话本体是工件
> `sessions/<projectKey>/<id>/session.v3.jsonl.zstd`；缓存行只是从它派生的 UI 元数据
> （title / tokenUsage / turnOutline / todos / sessionListMetadata …）。所以清缓存行**不会**丢对话。

**修法两条**：

1. `deleteSession` 改用 `deleteSessionFiles`：**工件目录 + 投影缓存行一起删**。
   关键点：**缓存行的删除不依赖工件存在** —— 所以对一个"工件早就没了、只剩缓存行"的坏会话，
   再点一次「删除会话」这次就能真正清干净。
2. 启动时新增**孤儿缓存清理**（`purgeOrphanProjcache`，在 post-boot 对账里跑）：
   扫 `session_projcache`，把没有对应磁盘工件的缓存行清掉。判据只用**纯磁盘扫描**，
   不依赖任何持久化索引（索引本身可能就带着已删 id）；缓存行自带 `cwd` 时再按它复算位置复核一次，
   防目录布局差异误删真实会话。

**关于版本家族**：`recall_relations.json` 里也会残留已删成员。recall 本来就有自愈
（`pruneDeadMembers`，客户端启动时拉 `/bubble/relations` 触发），它用官方 `sessionKnown()` 判存在性；
但那是**进程内只增不减的 header 索引**，所以对"本进程启动时还在磁盘上、后来被删掉"的会话，
要**重启**才会判为不存在并被剔除。

### 测试

- `parts/manager/tests/purge-orphan-projcache.test.mjs`（11 项）：真实临时目录——
  工件+缓存一起删、工件已丢仍能删缓存、空项目目录回收、幂等、只清孤儿不动真实会话、
  cwd 复核防误删、无 cwd / JSON 损坏 / 非 .json / 目录不存在等边界。
  汇总现在 10 套。

## 0.2.2 — 2026-09-24

### 修：编辑一条指令后，**原指令没被改掉、反而又被重跑了一遍**（编辑后的文本排在它后面）

故障现场（真实会话，逐条 dump 过日志）：

```
父会话 turn/end(63)  ← 插件选的边界（正确）
       inbox 入队「原指令」
       inbox 入队「另一条」
       turn/start(64)
       inbox 出队「原指令」    ← 出队记录在 turn 里面
       user/message「原指令」  ← 原指令已进日志
       inbox 出队「另一条」
       turn/end(64)
```

- **根因**：官方 fork 门面（`dsh-api-session-controller#fork`）收到 `atSeq` 后做两件事——
  ① **往后**找第一个 `turn/end` 作边界；② 再从边界 +1 **一路吞到下一个 `turn/start` 之前**。
  于是边界之后、下一轮开始前的 `agent/inbox/spliced` **入队记录**进了子会话 seed，
  而它们的**出队记录**在那一轮 turn 里、留在源会话 → **子会话队列被整段复活**，
  第一个回合又把早就消费掉的指令认领一次。
  这不是边界算错，是 fork 的"吞并记账事件"语义导致的，**光调 `atSeq` 修不掉**
  （目标消息之前只有一个 `turn/end`，`atSeq` 取多小都会选中它）。
- **修法**：fork 成功之后、投递编辑文本之前，加一道清理——
  新增宿主路由 `POST /bubble/purge-resurrected-queue`，以**源会话此刻仍在排队的队列**为真值，
  把子会话 **seed 前缀**（`inheritedEventCount` 之前）里"源会话队列已经没有的"排队消息，
  用官方 `sessionController.updateQueue({ action: { kind: 'remove' } })` 删掉。
  - 只折叠 seed 前缀 → 编辑后新入队的文本绝不会被误删；
  - 源会话里仍排着的（用户真的还等着跑的）消息保留；
  - 单个删除失败只进 `failed` 列表，不阻断编辑投递；`sessionController` 不可用时整条降级。

### 修：`message-pending` 守卫静默失效（`hasMessageId: false`）

- 客户端读 `node.data.id` 取消息 id，但实测 dsh 0.1.5-rc.2 的 chat store 里
  `kind:"user"` 节点**不带 messageId**（只有 `steering` 节点带）→ 守卫永远拿不到 id、永远不触发。
- 现在宿主在 `resolveBoundary` 里用 `targetSeq` 从日志补出 id（目标已认领时它的 `user/message` 就在这个 seq 上）；
  补不出来就退回原行为，不会削弱守卫。

### 测试

新增两套并接入 `tests/run-all.mjs`（汇总现在 9 套）：

- `parts/recall/tests/purge-resurrected-queue.test.mjs`（15 项）：事件序列逐条照抄自真实故障会话，
  先断言 bug 前提（源队列为空 / 子会话队列被复活），再覆盖判据、误删保护与守卫行为。
- `parts/recall/tests/purge-queue-host.test.mjs`（8 项）：宿主路由集成——
  调用形状、只删幽灵、保留真实排队、失败降级、参数校验。

顺手修掉 `parts/recall/package.json` 里指向不存在文件的 `test` 脚本。

## 0.2.1 — 2026-09-24

修掉 0.2.0 实测发现的两个问题（都只在浏览器半边，宿主路由未变）。

### 修：用户消息上的删除按钮被「撤回 / 复制」挡住，很难点到

- 根因：用户消息那一格被 recall 半边**顶替**了，它自绘的操作条是纯内联样式、**没有类名**，
  所以按官方约定写的 `[class*="_actions"]` 选择器匹配不到 → 删除按钮回落到"浮在行上"的
  绝对定位按钮，压住了原有按钮。
- 现在：`findRowActions` 两级定位（官方 `_actions` → recall 气泡里 `recall-key` 按钮的父层），
  找到就**追加为操作条的最后一个子节点**，即 **撤回 → 复制 → 删除**；
  套 `.dshwd-inline`（34×34、圆角 8px、常显不透明）与旁边按钮对齐。
  找不到操作条的行（注入上下文行、工具卡、过程行…）才回落到浮层按钮。
- 新增回归测试 `wm-delete-placement.test.mjs`（迷你 DOM，9 项，走真实
  `applyDom → injectRowAction` 路径）。

### 修：新会话阶段刷 400 invalid session id

- `conversation.input.overlay` 在"还没有会话"时把 `sessionId` 传成 `undefined`，
  客户端照旧请求 `/wm-delete/state?sessionId=undefined`，日志里刷一串 400。
- 现在客户端先校验会话 id 形状，不可用就**一个请求都不发**（界面照常渲染）。

## 0.2.0 — 2026-09-24

新增第三个半边 **`parts/delete`（消息删除）**：把任意一条指令或回复从模型上下文里拿掉，
并从当前转录隐藏；原始只追加日志不改写。移植自 MIT 社区插件 `dsh-delete-turn` 0.1.3。

### 消息侧新增（`parts/delete`）

- **按条删指令**：用户消息（真人提问或注入上下文行）上的垃圾桶，只删这一条。
- **按步骤删**：思考卡 / 工具调用卡上的垃圾桶，删该步的 `assistant/message` + 配对的
  `tool/result`（工具配对永不悬空），同回合其它步骤保留。
- **按整条删回复**：助手操作条上的垃圾桶，删这条回复连同思考、工具调用与注入上下文；**提问保留**。
- 走官方 `surfaceOp: { op: 'replace' }` 契约（与 `/compact` 同一套机制），
  `session.append` 一个替换事件 + 等 `sessionPersistence.flush()` 检查点。
- 台账就是日志：隐藏集合从替换事件重建（source 标记 `plugin:dsh-wm-toolkit`），
  不依赖 localStorage；行定位只用官方 `data-chat-flow-*` 锚点与官方 `useChat`，不读 React fiber。
- 中英双语确认弹窗；行折叠退场动画（遵循 `prefers-reduced-motion`）。

### 组合层变化

- `build.mjs` 支持任意数量半边（现在是三个），宿主与浏览器两半的隔离策略不变。
- `factoryBodyOf` 现在也接受工厂后面带尾逗号的写法（上游 bundle 两种写法都有）。
- 消息删除半边另写一份 `$DSH_HOME/dsh-wm-delete.log`（删除不可逆，落地与拒绝都要留痕）。

### 测试

- 新增三套：`parts/delete` 逻辑 26 项、宿主集成 20 项、浏览器半边冒烟 7 项。
  宿主集成测试会**动态载入本机 DSH 安装的官方 `foldSurface`** 做契约验收，
  并用三个反例证明 `sourceEventSeqs` 完整性、`assistant/message` 禁带 source、
  锚点必须存在这三条规则确实生效；找不到 DSH 安装时明确跳过而不是假通过。
- `tests/run-all.mjs` 汇总现在覆盖 6 套。

### 已知边界

- 删除是**软删除**：内容离开模型上下文并从转录隐藏，但原始日志仍在，**不提供反删除**。
- 回合进行中不可删；系统提示词头不可删；已被 `/compact` 移出上下文的内容不显示删除入口。

## 0.1.0 — 2026-09-18

首个公开版本。

### 消息侧（`parts/recall`，上游 `dsh-message-recall` 2.6.1）

- 撤回我的消息；编辑我的消息（归档旧会话 + 开新分支，旧版本可切回）
- **编辑我的回复**：重写我（助手）说过的话，**正文与思考块都可编辑**
- **用原提问重新生成 ↻**：对任意一条回复点它 = 重跑该回合（同时就是"重试任意回合"）
- 版本家族 `< 1 2 >` 切换；草稿备份；设置卡

### 会话 / 工作区侧（`parts/manager`，上游 `dsh-session-manager` 0.4.11）

- 会话重命名 / 删除 / 归档 / 取消归档（挂进官方 ⋯ 菜单，不重画侧边栏）
- 跨工作区移动；**工作区文件夹真迁移**（移动或重命名目录 + 会话工件跟随 + `cwd` 重写 + 事务回滚）
- 未分组会话归位；启动自愈（父会话在工作区、子会话漏记账的自动挂回）

### 组合层（本包原创）

- **一个插件 id** 承载两半：宿主依次 `apply`，浏览器一次 `load()`，两半各自 IIFE 包裹、代码逐字节不变
- 隔离：任一半抛错只记日志、不影响另一半；两半都失败才抛出
- 加载自检写入 `$DSH_HOME/dsh-wm-toolkit.log`

### 实现要点（值得记住的坑与结论）

- 编辑回复不用"先 fork 再改文件"：fork 出的子会话**当场就是活动会话**，且 DSH 的事件消息是 `deepFreeze` 的，
  改内存改不动、改磁盘界面不认。最终做法是**建分支时就用改好的种子**（`ctx.sessions.create`）。
- **绝不卸载活动会话**（`sessionStore.detach()` 会把该行从运行时与客户端列表摘掉，导致切换卡死、`< >` 失效）。
- `ctx.workspaceRegistry` 等属性访问必须在 `inject` 里声明，否则子会话会落"未分组"。
- 无 npm 更新通道：设置卡的"检查更新"只回报当前版本（避免误升上游包名而覆盖本分叉）。

### 测试

- `parts/recall`：58 项离线断言（种子改写、块类型、回合规划、边界解析、内存同步降级路径等）
- `parts/manager`：会话迁移核心（帧级 header 改写、投影缓存同步、复读一致）

### 许可与归属

MIT。两半分别派生自 `dsh-message-recall`（Jipcon，MIT）与 `dsh-session-manager`（MIT），
完整声明见 [NOTICE.md](./NOTICE.md) 与 [LICENSE](./LICENSE)。
