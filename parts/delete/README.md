# parts/delete — 消息删除半边（dsh-wm-delete）

`dsh-wm-toolkit` 的第三个半边：**把任意一条指令或回复从模型上下文里拿掉**，
同时从当前转录里隐藏它。原始只追加的会话日志**一个字节都不改写**。

派生自 MIT 社区插件 [`dsh-delete-turn`](https://github.com/DDDMUC/dsh-delete-turn) v0.1.3
（作者 DDDMUC，MIT）的 `src/logic.js` / `src/index.js` / `src/client.js`，
改名与路由前缀、守卫与清理写法对齐本仓库其它半边。完整归属声明见仓库根 [NOTICE.md](../../NOTICE.md)。

## 为什么需要它（和其它功能的分工）

| 需求 | 用哪个 |
|---|---|
| 我想改一句话然后**重发** | recall 半边：撤回 / 编辑我的消息 |
| 我想改**我说过的话**（含思考块） | recall 半边：编辑我的回复 |
| 我想让这条回复**重新生成** | recall 半边：用原提问重新生成 ↻ |
| 我发错了一条、或者模型答偏了，想让**后面每一轮都别再看到它** | **本半边：删除** |

DSH 的会话日志是 append-only 的：说错的话会一直留在模型上下文里，污染后续每一轮。
官方只给了整段摘要式的 `/compact`，没有单条消息级的删除——本半边补上这一格。

## 三种删除范围

| 点哪里 | 删掉什么 |
|---|---|
| 用户消息上的垃圾桶 | **就这一条**（真人提问或注入上下文行）；助手回复留在原地 |
| 思考卡 / 工具调用卡上的垃圾桶 | **就这一步**：该步的 `assistant/message` + 它请求的 `tool/result` 一起走，工具配对永不悬空 |
| 助手回复操作条（复制 / 分支那一排）上的垃圾桶 | **就这一段回复**：连同它的思考、工具调用与注入上下文；同一轮里其它段和你的提问都保留 |
| 段尾助手行上的垃圾桶 | 同上（**每一段都有自己的入口**；回合中途插进追问之前的那些段也有） |

过程行、失败行、重试行上的垃圾桶按「这一段回复」处理。

**「一段」是怎么切的**：一个回合里可以有多条真人提问——开场那条，加上你在 agent
干活途中补发的追问（steering）。提问一律保留，于是回复被切成若干段：

```
指令A → [回复段1] → 中途补发指令C → [回复段2]   （= 2 段）
```

点哪一段的垃圾桶就只删那一段（默认）；确认框在该轮段数 > 1 时会给出
「同时删掉这一轮里其它 N 段回复」的勾选（**默认关闭**），勾上才整轮一起删。

### 按钮插在哪（一个踩过的坑）

用户消息那一格被本仓库 recall 半边**顶替**了，它自绘的操作条是纯内联样式
（`display:flex;gap:2px`），**没有任何类名** —— 所以按官方约定写的
`row.querySelector('[class*="_actions"]')` 匹配不到，删除按钮只能回落到"浮在行上"的
绝对定位按钮，压住了「撤回 / 复制」，**很难点到**。

现在的做法（`findRowActions`）两级定位：

1. 官方气泡的操作条：`[class*="_actions"]` 且里面确实有按钮；
2. recall 半边自绘的用户气泡：操作条里必有那个 `data-dsh-message-recall="recall-key"`
   的「撤回」按钮，从它往上找到直接挂在气泡根节点下的那一层
   （正常态与编辑态都成立，且不会误命中编辑器的取消/确认行）。

找到就**追加为最后一个子节点**（撤回 → 复制 → **删除**），并套 `.dshwd-inline`
（34×34、圆角 8px、常显不透明，与旁边按钮一致）；实在找不到操作条的行（注入上下文行、
工具卡、过程行…）才回落到浮层按钮。

回归测试：`tests/wm-delete-placement.test.mjs`（迷你 DOM，走真实的
`applyDom → injectRowAction` 代码路径，24 项，含"每段一个按钮"）。

## 工作原理

```
浏览器：垃圾桶按钮 → 确认弹窗（默认「只删这一段」，可勾选「整轮」）
   → POST /wm-delete/delete { sessionId, mode, seq? / messageId? / turn?, scope? }
宿主：
   sessionQuery.readSession() 读完整日志（优先 live 快照）
   自实现 surface 折叠 → 当前 surface 节点 + 历史替换遮蔽集
   按真人提问分段（replySegments），只取 scope 指定的那一段 / 整轮
   校验（节点在 surface 上 / 区间干净 / 回合已闭合 / 不碰系统提示词头）
   对选中的每个回复段各追加一个替换事件：
   session.append('user/message', 短标记占位, {
     surfaceOp: { op: 'replace', startSeq, endSeq },
     sourceEventSeqs: [被遮蔽的全部 seq],
   })
   等官方 sessionPersistence.flush() 持久化检查点
   → { hidden: [{ seq, mode }] }
浏览器：
   useChat 快照把 data-chat-flow-key 映射到节点，按 hidden 集合把行折叠掉
   GET /wm-delete/state 每次打开会话时从日志重建 hidden 台账，
   并取回 segmentsByTurn（每轮几段）与 segmentTails（每段的段尾助手行 → 按钮落点）
```

**默认只删一段**：`scope: 'segment'`（不传就是它）只遮蔽被点的那一段回复——你在 D
位置点删除，留下「指令A——AI回复B——中途补发指令C」。只有显式 `scope: 'turn'`
（确认框里的勾选）才会把整轮的段一起删（方案一：留下全部提问）。目标已经离开
surface 时默认回 `already-deleted`，**绝不顺势扩大范围**。

段的切分见 {@link replySegments}：提问作分隔符，且必须保持 surface 索引连续。
一次整轮删除在日志里会连续出现多条替换事件；某段被 surface 拒绝（例如别的写入者
抢先动了节点）时，已落地的那几段照常生效，宿主返回 `partial: true`，剩下的刷新后再删一次。

几个必须知道的设计取舍：

- **载体为什么是带短标记的 `user/message`**：官方格式校验把 `system/message` 钉在
  「打开中的 step」上（不能用于回合外的删除），并且**禁止 `assistant/message` 携带
  `sourceEventSeqs`**（无法声明被遮蔽节点）；官方 `/compact` 的检查点用的正是
  `user/message` 替换。严格网关会拒绝内容为空的 user 消息，所以载体带一小段
  `[deleted]` 标记——标记不会重放被删掉的内容。
- **替换事件就地顶替，不追加到尾部**：surface 折叠是 `splice`，被删节点的位置由替换事件占据。
- **台账就是日志**：隐藏集合从日志里的替换事件重建（其消息 source 标记为
  `{ kind: 'plugin', plugin: 'dsh-wm-toolkit' }`），不依赖 localStorage，不需要预检，
  也不会和官方压缩的替换混淆。
- **行定位只用官方锚点**：`data-chat-flow-*` / `data-chat-node-key` / `data-chat-turn` 与官方 `useChat` 标准 hook；
  不读 React fiber、不依赖 CSS-modules 哈希类名，宿主 UI 重构不会静默失效。
  （分组行——例如「思考」——的 flow key 是 `JSON.stringify([节点键, "reasoning"])`，
  必须回退到 `data-chat-node-key` 才能查到节点，否则这类行永远不会被隐藏。）

## 已知边界（诚实说明）

- **这是「软删除」**：被删内容离开模型上下文并从转录隐藏，但**原始日志仍在**，
  官方工具可以据此重建会话；本插件**不提供反删除**。
- **不可逆**：append-only 语义下没有真正的「撤销删除」。
- **回合进行中不能删**：等回复结束后再操作（宿主返回 `busy`）。
- **系统提示词头（surface 节点 0）不可删**。
- **已经被官方 `/compact` 移出上下文的内容不显示删除入口**：它已经不在上下文里了，
  转录是刻意保留的。
- **默认只删被点的那一段回复**（含它的思考、工具调用与注入上下文）；整轮一起删要在确认框里显式勾选。
  只想删某一步请用思考卡 / 工具卡上的垃圾桶。
- **每一段都有自己的删除按钮**：按钮挂在各段的**段尾助手行**上（宿主用 `segmentTails` 报出段尾）。
  段的中间行不重复长按钮，精细删除走思考卡 / 工具卡的「删这一步」。
- **整轮删除（勾选后）会写多条替换事件**：回复被真人提问切成多段，每段一个；
  某段失败不影响已落地的段（`partial: true`），刷新后接着删剩下的即可。
- **目标已经不在 surface 上时**，默认的「删除这一段」会明确回 `already-deleted`（不会顺势删别的）；
  要把该轮剩下的残块一次清掉，请在确认框里勾选「整轮」（或点那段自己的段尾行）。
- **有一类行映射不到 surface 节点**：宿主自己合成的过程分组壳（`data-step-process`，
  标题就是「执行了命令 / 已完成分析」）、模型重试行、中断的工具行 —— 它们的锚点是
  `tool/call`、`llm/retry` 这类非 surface 事件，或者是客户端合成的分组键。对它们，
  插件用两条兜底判据：①该回合已被删空（宿主的 `clearedTurns` + 行上的 `data-chat-turn`）
  → 整行收起；②过程壳内部成员**全部**已被隐藏 → 壳跟着收起。真人提问行不受影响。
- 宿主插件树只在 DSH 启动时读取：**装完 / 改完必须重启 DSH**。

## 路由与安全

| 路由 | 方法 | 说明 |
|---|---|---|
| `/wm-delete/state?sessionId=` | GET | 当前 surface、隐藏台账、可删回合（`replyTurns`）、每轮段数（`segmentsByTurn`）、每段的段尾助手行（`segmentTails`）、已删空的回合（`clearedTurns`）、是否忙 |
| `/wm-delete/delete` | POST | `{ sessionId, mode, seq?/messageId?/turn?, scope? }` → `{ hidden, clearedTurns, partial?, flushed }` |

守卫三重：socket 必须来自回环地址、`Host` 头必须是本机（防 DNS rebinding）、
浏览器带 `Origin` 时必须同源。会话 id 必须匹配 uuid / `session-uuid` 形式。

## 服务依赖

只声明 `inject = ['webServer']`；`sessions` / `sessionQuery` / `sessionController` /
`sessionPersistence` 都在调用时经 `ctx.get()` 按需解析——缺哪个就降级成一条明确的
HTTP 错误，而不是让整个插件加载失败。

## 测试

```powershell
node parts\delete\tests\wm-delete-logic.test.mjs      # 33 项：折叠 / 规划 / 台账 / 安全拒绝 / 分段（默认只删一段 vs 整轮）/ 删空回合
node parts\delete\tests\wm-delete-host.test.mjs       # 26 项：路由 / 守卫 / 追加事件形状 + 官方契约验收 + scope 透传 + clearedTurns
node parts\delete\tests\wm-delete-client.smoke.mjs    # 7 项：bundle 加载 / 槽注册 / 路由前缀一致 / 词典中英对齐
node parts\delete\tests\wm-delete-placement.test.mjs  # 24 项：按钮插在哪 / 每段一个按钮 / 思考行与过程分组壳收起 / 确认框 scope
```

`wm-delete-host.test.mjs` 会把追加出来的替换事件再过一遍**官方** `foldSurface`
（动态从本机 DSH 安装载入 `@deepseek-ai/dsh-session`），等于用真实的 surface 契约验收；
同时用三个反例证明 `sourceEventSeqs` 的完整性、`assistant/message` 的禁令、
以及锚点必须存在这三条规则确实在生效。找不到 DSH 安装时这一段会**明确跳过**，不会假通过。

## 许可

MIT。上游 `dsh-delete-turn` 的版权与许可声明完整保留，见仓库根 `LICENSE` 与 `NOTICE.md`。
