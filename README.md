# dsh-wm-toolkit

**撤回、编辑指令与回复（连思考过程一起改）、用原提问重新生成、删除任意一条指令或回复、
会话归档/删除/跨工作区移动与工作区迁移。**
一个 DSH 插件全都有 —— 装上它，插件列表里只多一行。

> Recall, edit prompts and replies (reasoning included), regenerate with the original prompt,
> delete any single prompt or reply, session archive/delete, cross-workspace move, and
> workspace migration — all in one DSH plugin.

## 它能做什么

**消息侧**

- **撤回我的消息**：把对话回退到某条提问之前，可以改完再发，也可以原样重发。
- **编辑我的消息**：改完立刻用新内容重跑（归档旧会话 + 开新分支，旧版本可切回）。
- **编辑我的回复** ✍️：改我（助手）说过的话。正文与**思考块**都能改；改完对话从我这条回复处继续。
- **用原提问重新生成 ↻**：某条答得不满意，一键用它对应的原提问重跑一遍；对任意历史回复点它 = 重试那个回合。
- **删除任意一条指令或回复** 🗑️：按条删指令、按步骤删思考与工具调用、按整条删 AI 回复。
  删掉的内容**离开模型上下文**并从转录隐藏（后面每一轮都看不到它），原始只追加日志一个字节都不改写。
  与上面的「编辑 / 重生成」是**互补**关系：那两个是"改完重来"，这个是"当作没说过"。
- **版本家族 `< 1 2 >`**：每次编辑/重生成都是一个独立分支，随时切回旧版本，不会丢历史。

**会话 / 工作区侧**

- 会话 **重命名 / 删除 / 归档 / 取消归档**（挂进官方 ⋯ 菜单，不重画侧边栏）。
- **跨工作区移动**、**工作区文件夹真迁移**：文件夹搬家或改名后，一键把工作区记录、每条会话的 `cwd`
  与日志物理位置一起迁过去；有备份与回滚，失败不会留下半个状态。
- **未分组会话归位**与**启动自愈**：父会话在某工作区、子会话却掉进未分组的，自动挂回去。

## 删除任意一条指令或回复 🗑️

**点哪里 → 删掉什么**

| 点哪里 | 删掉什么 |
|---|---|
| 用户消息行上的垃圾桶（排在「撤回 / 复制」后面） | **就这一条**：真人提问或注入上下文行；助手回复留在原地 |
| 思考卡 / 工具调用卡上的垃圾桶 | **就这一步**：该步的 `assistant/message` + 它请求的 `tool/result`（工具配对不会悬空），同回合其它步骤保留 |
| 助手回复操作条（复制 / 分支那一排）上的垃圾桶 | **整条回复**：连思考、工具调用与注入上下文一起走；**你的提问保留** |

过程行、失败行、重试行上的垃圾桶按「整条回复」处理。

**它和「编辑 / 重生成」的分工**

| 你想干的事 | 用哪个 |
|---|---|
| 改一句话然后**重发** | 撤回 / 编辑我的消息 |
| 改**我说过的话**（含思考块） | 编辑我的回复 ✍️ |
| 让这条回复**重新生成** | 用原提问重新生成 ↻ |
| 发错了、答偏了，想让**后面每一轮都别再看到它** | **删除** 🗑️ |

**机制**：确认后追加一个官方 `surfaceOp: { op: 'replace', startSeq, endSeq }` 替换事件
（与官方 `/compact` 同一套契约），被遮蔽的内容从此不再进入 `deriveMessages()`，转录里也一并隐藏。
**原始 append-only 日志一个字节都不改写。** 隐藏台账直接从日志里的替换事件重建
（source 标记 `plugin:dsh-wm-toolkit`），不依赖 localStorage，刷新/重启后依旧隐藏。

**边界（诚实说明）**

- 这是**软删除**：内容离开模型上下文并从转录隐藏，但原始日志仍在、**不可反删除**。
  要"改完重来"请用编辑 / 重生成。
- 回合进行中不能删（等回复结束）；系统提示词头（surface 节点 0）不可删。
- 已被官方 `/compact` 移出上下文的内容**不再显示删除入口**——它已经不在上下文里了。
- 助手操作条上的删除是**整条回复**；只想删某一步请用思考卡 / 工具卡上的垃圾桶。
- 路由：`GET /wm-delete/state?sessionId=`、`POST /wm-delete/delete`，仅回环 + 同源 + Host 本机。
  落地与拒绝都写进 `$DSH_HOME/dsh-wm-delete.log`（删除不可逆，必须留痕）。

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-wm-toolkit
# 重启 DSH
```

本地源码安装：

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-wm-toolkit"
```

卸载：`dsh plugin --profile <profile> remove dsh-wm-toolkit`。
本插件不改写 DSH 自身文件（除一处可回滚的工作区菜单补丁，带 `.dsh-wm-orig` 备份与原生命令检测）；
插件数据写在独立目录，卸载不会动你的会话档案。

> ⚠️ **装完 / 改完必须重启 DSH**：宿主半边（路由）只在启动时读取。只改浏览器半边刷新页面即可。

## 为什么是一个插件、内部却是三半

它由三个各自独立维护的半边组合而成，三者都是 MIT 社区插件的分叉或移植（见 [NOTICE.md](./NOTICE.md)）：

| 半边 | 上游 | 我们新增 |
|---|---|---|
| `parts/recall` | `dsh-message-recall` 2.6.1 | 编辑我的回复（含思考块）、用原提问重新生成/重试、分支预设与模型继承、家族自愈 |
| `parts/manager` | `dsh-session-manager` 0.4.11 | 工作区文件夹真迁移（移目录 + 工件跟随 + cwd 重写 + 回滚）、未分组修复、启动自愈 |
| `parts/delete` | `dsh-delete-turn` 0.1.3 | 改名与路由前缀、守卫与清理写法对齐本仓库、认两代 source 形状的台账、官方契约回归测试 |

DSH 的插件列表按**包 / 插件 id** 逐行列出的，所以"装上去就是一个插件"要求只有一个可解析的包；
而三个半边各有几百个顶层标识符（`log` / `TEXT` / `apply` …），直接合并源码极易撞名。于是做法是：

- `lib/index.js`（生成物）：导入各半边，依次 `apply(ctx)`；**任何一半抛错只记日志、不影响另一半**，
  只有全部半边都失败才抛出（不让插件"半死不活"）。服务依赖取各半边并集。
- `lib/client.js`（生成物）：**一次** `__ModuleLoader__.load()`，工厂内部把各半边各自包进 IIFE，
  半边代码**逐字节不变**，作用域天然隔离。
- `build.mjs`：从 `parts/` 生成上面两个文件。改代码请改 `parts/`，然后 `npm run build`。

组合层会把加载结果写进 `$DSH_HOME/dsh-wm-toolkit.log`（`半边已应用` / `半边应用失败（已隔离）` + 堆栈），
消息删除半边另写一份 `$DSH_HOME/dsh-wm-delete.log`（删除是不可逆操作，落地与拒绝都要留痕）。

## 兼容性

- 目标：DeepSeek Harness（`dsh`）Web 端，`engines.dsh >= 0.1.5-rc.1`；Node ≥ 22。
- 只使用 DSH 官方扩展点与公开服务（`webServer` / `sessions` / `agents` / `sessionPersistence` /
  `workspaceRegistry` / `agentPresets` / `settings` / `storageDomain` / `sessionQuery`），
  不修改引擎与官方 UI 包。
- 删除功能走官方 `surfaceOp: { op: 'replace' }` 契约（与 `/compact` 同一套机制），
  已在 DSH `0.1.5-rc.2` 上用官方 `foldSurface` 做过契约回归。
- 与侧边栏、皮肤、记忆、导出类插件无冲突；**不要**与另一个跨工作区移动器或另一个消息删除插件同时启用。

## 已知边界（诚实说明）

- **删除是「软删除」**：内容离开模型上下文并从转录隐藏，但原始日志仍在（append-only 语义下
  没有真正的反删除）。需要"改完重来"请用编辑 / 重生成。
- 删除只在**回合已闭合**时可用；系统提示词头不可删；已被 `/compact` 移出上下文的内容不再显示删除入口。
- 编辑我的回复只改文本，**保留该回合原有的工具调用**（不重造回合、不丢弃工具链）。
- 重生成/重试用 `truncate` 语义：该回合之后的内容留在旧会话里；**不提供**"自动重放后续输入"。
- 不提供版本对照面板（改了什么你自己知道；需要时用 `< >` 切回旧版本看）。
- 若某条回复没有文本块（纯工具调用），不显示 ✍️；未闭合回合不可编辑。
- 本插件为**本地/组合构建**，设置卡里的"检查更新"只回报当前版本，没有 npm 更新通道。

## 开发

```bash
npm run build      # 由 parts/ 生成 lib/
npm run test       # 各半边的离线单测（11 套）
```

`lib/` 是生成物，请勿手改。发布流程见 [RELEASE.md](./RELEASE.md)。
各半边的细节见 `parts/recall/README.md`、`parts/manager/README.md`、`parts/delete/README.md`。

测试构成（`tests/run-all.mjs` 依次执行并汇总）：

| 套 | 覆盖 |
|---|---|
| `parts/recall/tests/wm-assistant-edit.test.mjs` | 编辑我的回复 / 重生成核心（58 项） |
| `parts/recall/tests/purge-resurrected-queue.test.mjs` | fork 复活队列清理·纯逻辑（15 项） |
| `parts/recall/tests/purge-queue-host.test.mjs` | fork 复活队列清理·宿主集成（8 项） |
| `parts/manager/tests/wm-relocate.test.mjs` | 会话迁移核心 |
| `parts/manager/tests/purge-orphan-projcache.test.mjs` | 孤儿投影缓存清理（11 项） |
| `parts/manager/tests/reconcile-projcache-identity.test.mjs` | 投影缓存 identity 对账（12 项） |
| `parts/delete/tests/wm-delete-logic.test.mjs` | 删除逻辑：折叠 / 规划 / 台账 / 安全拒绝（26 项） |
| `parts/delete/tests/wm-delete-host.test.mjs` | 删除宿主集成 + **官方 `foldSurface` 契约验收**（20 项） |
| `parts/delete/tests/wm-delete-client.smoke.mjs` | 浏览器半边冒烟（7 项） |
| `parts/delete/tests/wm-delete-placement.test.mjs` | 删除按钮位置回归·迷你 DOM（9 项） |

`wm-delete-host.test.mjs` 会动态载入**本机 DSH 安装的官方 `foldSurface`**（`@deepseek-ai/dsh-session`）
做 surface 契约验收，找不到时明确跳过而不是假通过。

## 许可

MIT。三个半边的上游版权与许可声明完整保留，见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
