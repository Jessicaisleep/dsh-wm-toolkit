# dsh-wm-toolkit

**撤回、编辑指令与回复（连思考过程一起改）、用原提问重新生成、会话归档/删除/跨工作区移动与工作区迁移。**
一个 DSH 插件全都有 —— 装上它，插件列表里只多一行。

> Recall, edit prompts and replies (reasoning included), regenerate with the original prompt,
> session archive/delete, cross-workspace move, and workspace migration — all in one DSH plugin.

## 它能做什么

**消息侧**

- **撤回我的消息**：把对话回退到某条提问之前，可以改完再发，也可以原样重发。
- **编辑我的消息**：改完立刻用新内容重跑（归档旧会话 + 开新分支，旧版本可切回）。
- **编辑我的回复** ✍️：改我（助手）说过的话。正文与**思考块**都能改；改完对话从我这条回复处继续。
- **用原提问重新生成 ↻**：某条答得不满意，一键用它对应的原提问重跑一遍；对任意历史回复点它 = 重试那个回合。
- **版本家族 `< 1 2 >`**：每次编辑/重生成都是一个独立分支，随时切回旧版本，不会丢历史。

**会话 / 工作区侧**

- 会话 **重命名 / 删除 / 归档 / 取消归档**（挂进官方 ⋯ 菜单，不重画侧边栏）。
- **跨工作区移动**、**工作区文件夹真迁移**：文件夹搬家或改名后，一键把工作区记录、每条会话的 `cwd`
  与日志物理位置一起迁过去；有备份与回滚，失败不会留下半个状态。
- **未分组会话归位**与**启动自愈**：父会话在某工作区、子会话却掉进未分组的，自动挂回去。

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

## 为什么是一个插件、内部却是两半

它由两个各自独立维护的半边组合而成，两者都是 MIT 社区插件的分叉（见 [NOTICE.md](./NOTICE.md)）：

| 半边 | 上游 | 我们新增 |
|---|---|---|
| `parts/recall` | `dsh-message-recall` 2.6.1 | 编辑我的回复（含思考块）、用原提问重新生成/重试、分支预设与模型继承、家族自愈 |
| `parts/manager` | `dsh-session-manager` 0.4.11 | 工作区文件夹真迁移（移目录 + 工件跟随 + cwd 重写 + 回滚）、未分组修复、启动自愈 |

DSH 的插件列表按**包 / 插件 id** 逐行列出的，所以"装上去就是一个插件"要求只有一个可解析的包；
而两半各有几百个顶层标识符（`log` / `TEXT` / `apply` …），直接合并源码极易撞名。于是做法是：

- `lib/index.js`（生成物）：导入两半，依次 `apply(ctx)`；**任何一半抛错只记日志、不影响另一半**，
  只有两半都失败才抛出（不让插件"半死不活"）。服务依赖取两半并集。
- `lib/client.js`（生成物）：**一次** `__ModuleLoader__.load()`，工厂内部把两半各自包进 IIFE，
  两半代码**逐字节不变**，作用域天然隔离。
- `build.mjs`：从 `parts/` 生成上面两个文件。改代码请改 `parts/`，然后 `npm run build`。

组合层会把加载结果写进 `$DSH_HOME/dsh-wm-toolkit.log`（`半边已应用` / `半边应用失败（已隔离）` + 堆栈）。

## 兼容性

- 目标：DeepSeek Harness（`dsh`）Web 端，`engines.dsh >= 0.1.5-rc.1`；Node ≥ 22。
- 只使用 DSH 官方扩展点与公开服务（`webServer` / `sessions` / `agents` / `sessionPersistence` /
  `workspaceRegistry` / `agentPresets` / `settings` / `storageDomain`），不修改引擎与官方 UI 包。
- 与侧边栏、皮肤、记忆、导出类插件无冲突；**不要**与另一个跨工作区移动器同时启用。
- 思考块编辑、重生成依赖会话日志里的对应事件；缺失时界面会明确说明，而不是静默失败。

## 已知边界（诚实说明）

- 编辑我的回复只改文本，**保留该回合原有的工具调用**（不重造回合、不丢弃工具链）。
- 重生成/重试用 `truncate` 语义：该回合之后的内容留在旧会话里；**不提供**"自动重放后续输入"。
- 不提供版本对照面板（改了什么你自己知道；需要时用 `< >` 切回旧版本看）。
- 若某条回复没有文本块（纯工具调用），不显示 ✍️；未闭合回合不可编辑。
- 本插件为**本地/组合构建**，设置卡里的"检查更新"只回报当前版本，没有 npm 更新通道。

## 开发

```bash
npm run build      # 由 parts/ 生成 lib/
npm run test       # 两半的离线单测（58 项 + 会话迁移核心）
```

`lib/` 是生成物，请勿手改。发布流程见 [RELEASE.md](./RELEASE.md)。

## 许可

MIT。两半的上游版权与许可声明完整保留，见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
