# Changelog

本包是**组合版**：对外一个 DSH 插件（一个包、一个插件 id），内部由三个独立半边构成。
半边各自的详细变更史保留在 `parts/recall/CHANGELOG-WM.md` 与 `parts/manager/CHANGELOG.md`；
本文件只记录**面向使用者**的包级版本。

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
