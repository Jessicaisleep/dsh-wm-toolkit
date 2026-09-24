# WM 分叉说明（dsh-message-recall-wm）

上游：`dsh-message-recall` 2.6.1（npm，未改动其源码结构）。
本分叉：`dsh-message-recall-wm` 2.6.1+wm.1，在保留上游全部功能（撤回 / 编辑我的消息 / 版本切换 / 设置卡）的前提下，**新增「编辑我的回复」（助手消息重编辑）**。

改名是为了让上游 npm 更新无法覆盖本分叉：包名、客户端 bundle id、插件行 id 全部改为 `dsh-message-recall-wm`；自更新路由也从"升级上游包"改为指向本分叉包名（上游没有这个包，因此不会被自动覆盖）。

---

## 一、新增能力：编辑我的回复

入口：助手回复底部操作区（复制 / 分支 那一排）新增一个 **✎「编辑这条回复」** 按钮。点击后弹出编辑框，预填这条回复的原文；确定即生效。

机制与「编辑我的消息」**完全同一套**（归档旧会话 + 开新分支），只多一步改写：

| 步骤 | 做什么 | 由谁执行 |
| --- | --- | --- |
| 1 | 解出边界：目标回复所在回合**自己的** `turn/end`（子会话因此**保留**该回合） | 宿主 `POST /bubble/recall-assistant` |
| 2 | 按该边界 fork 出子会话（先铸好子会话 id 并预登记版本关系，子会话一出现就折叠进原条目） | client 官方 `ctx.sessions.fork` |
| 3 | 子会话此刻是**冷态**的：把那条 `assistant/message` 的 `text` 块改写成新文本（原子发布） | 宿主 `POST /bubble/edit-assistant` |
| 4 | 受控切换打开子会话，成功后归档父会话（= 旧版本），两者进同一版本家族（`< 1/2 >` 可来回切） | client |

语义：**该回合之后的内容留在旧会话里**（与编辑自己的消息一致）。不写 resume 记录，所以不会自动重发任何内容，分支打开后就是"改好的回复 + 可以继续对话"。

## 二、改动 / 新增文件

| 文件 | 改动 |
| --- | --- |
| `lib/wm-assistant-edit.js` | **新增**。工件读改写核心（移植自 `dsh-session-manager-wm` 中已验证的会话工件读改写路径）：多帧 zstd 解码、按行改写、header 帧契约、原子发布 + 落盘自检 + 备份、边界解析。 |
| `lib/index.js` | 新增两条路由：`/bubble/recall-assistant`（边界）、`/bubble/edit-assistant`（改写）；**0.2.2 再加 `/bubble/purge-resurrected-queue`（清 fork 复活的排队消息），并让 `resolveBoundary` 用 `targetSeq` 补出 messageId**；自更新路由改为指向 `dsh-message-recall-wm`。 |
| `lib/client.js` | 新增 `findAssistantReplyTarget` / `openAssistantEditDialog`（自绘对话框，Electron 不支持 `prompt`/`confirm`）/ `runAssistantEdit` / `AssistantEditAction`，并注册进 `conversation.chat.assistant-actions` 槽（order 20，排在版本翻页器之后）。**0.2.2 在 `confirmEdit` 的 fork 成功后加了一次清理调用。** |
| `tests/wm-assistant-edit.test.mjs` | **新增**离线单测：在**真实会话日志的副本**上验证"只有目标那一行变、其余逐字节不变"。 |
| `tests/purge-resurrected-queue.test.mjs` | **新增（0.2.2）**：15 项。事件序列逐条照抄真实故障会话，断言 bug 前提、清理判据、误删保护与守卫行为。 |
| `tests/purge-queue-host.test.mjs` | **新增（0.2.2）**：8 项。`/bubble/purge-resurrected-queue` 的宿主集成：调用形状、只删幽灵、保留真实排队、失败降级、参数校验。 |
| `package.json` / `cordis.patch.yml` | 改名与版本号。 |

**没有**改动的上游行为：撤回（`/bubble/recall`）、编辑我的消息、版本翻页器、关系登记、草稿备份、设置卡、日志。路由前缀仍是 `/bubble/*`，localStorage 设置键仍是 `dsh-message-recall:*`（升级过来时用户设置不丢）。

## 三、安装与部署（重要）

已装入活动 profile `story`：

```
D:\Program Files (x86)\DSH_Data\profiles\story\package.json
  dependencies: "dsh-message-recall-wm": "file:D:/DSH工作区/DSH插件/dsh-message-recall-wm"
  dsh.profile.bundles: [ …, "dsh-session-manager-wm", "dsh-message-recall-wm" ]
```

注意：pnpm 对 `file:` 依赖在 Windows 上是**实体副本**（`node_modules\dsh-message-recall-wm`，不是符号链接）。
所以**改了 `D:\DSH工作区\DSH插件\dsh-message-recall-wm` 里的源码后，必须同步到部署副本**，否则运行的是旧代码：

```powershell
$src='D:\DSH工作区\DSH插件\dsh-message-recall-wm'
$dst='D:\Program Files (x86)\DSH_Data\profiles\story\node_modules\dsh-message-recall-wm'
Copy-Item "$src\lib\*" "$dst\lib\" -Force
Copy-Item "$src\cordis.patch.yml","$src\package.json" $dst -Force
```

（或者直接 `dsh plugin --profile story remove dsh-message-recall-wm` 再 `add "file:D:/DSH工作区/DSH插件/dsh-message-recall-wm"`。）

⚠️ DSH Desktop 运行期间，它已打开的插件文件（`lib/client.js`、`cordis.patch.yml` 等）是**被占用的**，Copy-Item 会报"正由另一进程使用"。所以同步前先退出 DSH Desktop，或改用上面的 `remove` + `add` 流程。

宿主半边（`lib/index.js`、`lib/wm-assistant-edit.js`）改动需要**重启 DSH Desktop**；只改客户端半边刷新页面（Ctrl+Shift+R）即可。

## 四、回滚

```powershell
# 1) 卸载分叉
dsh plugin --profile story remove dsh-message-recall-wm
# 2) 装回上游
dsh plugin --profile story add npm:dsh-message-recall
# 3) 或从备份恢复 profile（备份在 profile 目录下）
#    package.json.bak-wm-assistant-<时间戳>
```

## 五、测试

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe" "D:\DSH工作区\DSH插件\dsh-message-recall-wm\tests\wm-assistant-edit.test.mjs"
```

20 项断言，覆盖：行数不变、header 逐字节不变、帧 0 契约、只有目标行变化、`seq/time/type` 保持、非 text 块（reasoning / tool-call）原样保留、往返解码、三条定位路径、`replaceAllTextInMessage` 选项、以及边界解析的 6 种情形（保留目标回合 / 只给 turn / 非助手消息 / 未闭合回合 / 无文本块 / 会话不存在）。

## 六、0.2.2 修复：编辑指令后「原指令被重跑一遍」

**现象**：改完一条指令，原指令没变、又被重跑了一遍，编辑后的文本排在它后面。

**根因**（逐条 dump 真实会话日志后确认，在官方 fork 门面 `dsh-api-session-controller#fork`）：

```
const boundary = source.events.find(e => e.type === "turn/end" && e.seq >= atSeq)  // ① 往后找第一个 turn/end
let cut = boundary.seq + 1
while (cut < events.length && events[cut]?.type !== "turn/start") cut++            // ② 一路吞到下一个 turn/start
```

② 这一步会把「边界之后、下一轮 `turn/start` 之前」的**全部记账事件**吞进子会话 seed，
其中包括 `agent/inbox/spliced` 的**入队记录**；而对应的**出队记录**在那一轮 turn 里、留在源会话。
于是子会话 seed 的队列被整段复活，第一个回合又把源会话早就消费掉的指令认领一次。

**光调 `atSeq` 修不掉**：目标消息之前只有一个 `turn/end`，`atSeq` 取多小都会让 ① 选中它、② 吞到下一轮开始前。

**修法**：fork 成功之后、投递编辑文本之前清理一次。

- 新增宿主路由 `POST /bubble/purge-resurrected-queue { childSessionId, sourceSessionId }`；
- 判据：**源会话此刻仍在排队的队列才是真值**。子会话 **seed 前缀**
  （`events.slice(0, inheritedEventCount)`）里凡源会话队列已经没有的，都是 fork 截断造出来的幽灵；
- 删除走**官方** `sessionController.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })`
  （`dsh-api-session-controller` 的 `updateQueue`，注释明确写着 *without resuming a cold Agent*，正好适合这个时机）；
- **只折叠 seed 前缀**是关键：否则编辑后新入队的文本也会被当成幽灵删掉；
- 源会话里仍排着的（用户真的还等着跑的）消息保留；单条失败只进 `failed`，不阻断编辑投递。

顺带修了 `hasMessageId: false`：客户端读 `node.data.id`，但 dsh 0.1.5-rc.2 的 chat store 里
`kind:"user"` 节点**不带 messageId**（只有 `steering` 带），于是 `message-pending` 守卫静默失效。
现在宿主在 `resolveBoundary` 里用 `targetSeq` 从日志补出 id；补不出来就退回原行为。

## 七、已知边界

- **无文本回复不可编辑**：纯工具调用回合没有 `text` 块 → 不显示 ✎。
- **未闭合回合不可编辑**：回合未结束（没有 `turn/end`）→ 提示"等回复完成后再编辑"。
- **活动会话的可见性**：若子会话已被宿主加载（罕见竞态），改写后返回 `wasLive: true`，插件会 invalidate 宿主的 preparation 并提示"切走再回来"；磁盘内容一定是新文本。
- **备份**：首次改写某会话前会在 `$DSH_HOME\dsh-message-recall-wm\assistant-backups\<会话id>.jsonl` 留一份改写前的解码明文。
- **工件会被重新分帧**：改写后工件由"每批一帧"变为"header 帧 + 单帧正文"。这与已验证的会话预设迁移一致，DSH 按流读取不受影响。
