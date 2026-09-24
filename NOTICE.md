# NOTICE / 归属声明

本包（`dsh-wm-toolkit`）是**组合版**：对外是一个 DSH 插件（一个包、一个插件 id），
内部由三个独立半边构成。三个半边都是各自上游项目的 **MIT 分叉或移植**，前两个已改名（后缀 `-wm`）
以免上游更新覆盖本地改动；第三个是移植进本仓库的新半边。原始版权与许可声明如下，特此保留。

## parts/recall — 派生自 `dsh-message-recall`

- 上游版本：2.6.1
- 许可：MIT（上游 `package.json` 声明；上游未随包提供独立 LICENSE 文件）
- 上游主页：https://github.com/Jipcon/DSH-plugins/tree/main/dsh-message-recall
- 本分叉新增（我们自己写的）：
  - **编辑我的回复**（助手消息重编辑，含思考块，`blockKind` / `blockIndex`）
  - **用原提问重新生成（↻）/ 重试任意回合**（回合原子性 + 复用底座 resume-send 管道）
  - 分支的预设/模型继承、耐久屏障（flush）、挂工作区失败可见化与启动自愈
  - 关系家族自愈（剔除已不存在的版本成员）
- 上游原有：撤回我的消息、编辑我的消息、版本翻页器、草稿备份、设置卡

## parts/manager — 派生自 `dsh-session-manager`

- 上游版本：0.4.11
- 许可：MIT
- 上游版权行：`Copyright (c) 2026 dsh-session-manager contributors`（原文见 `parts/manager/LICENSE`）
- 上游主页：https://github.com/hkkz9522/dsh-session-manager
- 本分叉新增（我们自己写的）：
  - **工作区文件夹真迁移**：移动/改名目录 + 会话工件跟随 + `cwd` 重写 + 事务回滚（`lib/wm-relocate.js`）
  - 工作区 ⋯ 菜单补丁、"未分组会话也能挂进工作区"修复
  - 启动自愈：把"父会话属于某工作区、自己却没记账"的分支会话挂回去
- 上游原有：会话重命名/删除/归档、归档对话入口、工作区菜单项

## parts/delete — 派生自 `dsh-delete-turn`

- 上游版本：0.1.3
- 许可：MIT
- 上游版权行：`Copyright (c) 2026 DDDMUC`（原文见 `parts/delete/LICENSE`，与上游包内一致）
- 上游主页：https://github.com/DDDMUC/dsh-delete-turn
- 移植内容：`src/logic.js`（官方 surface 折叠 + 区间规划器）、`src/index.js`（宿主两条路由）、
  `src/client.js`（槽位按钮 + DOM 增强 + 确认弹窗）
- 我们的改动（相对上游）：
  - `PLUGIN_ID` 改为 `dsh-wm-toolkit`；路由前缀 `/dsh-delete-turn/*` → `/wm-delete/*`；
    槽 id `delete-turn` → `wm-delete-reply` / `wm-delete`（避免与本仓库其它半边或上游插件撞名）
  - 宿主半边只声明 `inject = ['webServer']`，其余服务调用时按 `ctx.get()` 解析；
    路由清理改为与本仓库其它半边一致的 `disposers` 写法
  - `sourceOwnsPlugin` 同时认两代 source 形状（v3 `{kind:'plugin',plugin:X}` /
    v4 `{kind:'plugin:X'}`）**并认上游 `dsh-delete-turn` 留下的删除标记**，
    这样从上游插件迁移过来的会话台账不会错乱
  - 文案改为中文优先（保留中英双语词典）、样式类名 `dshdt-` → `dshwd-`、
    删除确认弹窗补上"不可还原"的说明
  - 新增三套离线测试（逻辑 26 项 / 宿主集成 20 项 / 浏览器半边冒烟 7 项），
    其中宿主集成测试会动态载入**本机 DSH 安装的官方 `foldSurface`** 做契约验收

## 组合层（本包原创）

- `build.mjs`：把三个半边组合成一个插件（宿主：依次 `apply` 且互不牵连；浏览器：一次 `load()`，
  各半边各自 IIFE 包裹，代码逐字节不变）。
- `lib/index.js`、`lib/client.js`：生成物。

## 依赖与致谢

- 设计与实现上参考过社区同类插件 `Moeblack/dsh-message-edit`（MIT）的**公开文档与源码**，
  借鉴的是思路（回合原子性、`effect/inverse` 版本记录、可编辑块分类），**未复制其代码**；
  我们未采纳其 `cascade: preserve`（自动重放后续回合）与 `agents.create + runMaintenance` 事务缝。
- 未使用任何第三方 npm 运行时依赖（仅 Node 内置模块与 DSH 宿主服务）。
