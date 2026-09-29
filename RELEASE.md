# RELEASE.md — 发布清单

包名 `dsh-wm-toolkit`（2026-09-18 首发 `0.1.0`），当前版本 `0.2.10`。

## 0. 发布前的验证状态

**宿主侧已由日志证据通过**：`$DSH_HOME\dsh-wm-toolkit.log` 里每次启动都有

```
{"message":"半边已应用","data":{"half":"recall"}}
{"message":"半边已应用","data":{"half":"manager"}}
{"message":"半边已应用","data":{"half":"delete"}}
```

（已在 6 次重启中连续出现，说明组合层、三半的 import 与 `apply` 都正常。
`半边应用失败（已隔离）` 才会带堆栈 —— 只有三半**全部**失败时插件才会整体抛错。）

发布前仍需**目视确认 UI**（客户端组合只能靠人眼）：

1. 插件列表里我们这套只占**一行**；
2. 点一遍关键功能：撤回 / 编辑我的消息 / 编辑我的回复（含思考块）/ **↻ 重新生成** / `< >` 回版本 /
   **删除**任意一条指令或回复（含"过程壳"是否跟着收起）/ 会话 ⋯ 菜单 / 工作区迁移；
3. 若某项异常，先看上面的日志（`半边应用失败（已隔离）` 会带堆栈），再看浏览器控制台。

> 注意：客户端半边改动后需要**刷新页面**（Ctrl+Shift+R）才生效；宿主半边改动需要**重启 DSH**。

## 1. 构建与自检

```powershell
cd "D:\DSH工作区\DSH插件\dsh-wm-toolkit"

node build.mjs          # 生成 lib/index.js + lib/client.js
node tests/run-all.mjs  # 三半离线测试（当前 12 套：recall + manager + delete）
```

> 本机现在有 node（v24）/ npm（v11）。若哪台机器上没有，退回到 DSH 自带的 Node：
>
> ```powershell
> $env:ELECTRON_RUN_AS_NODE='1'
> $exe='D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe'
> & $exe "D:\DSH工作区\DSH插件\dsh-wm-toolkit\build.mjs"
> ```
>
> `lib/` 是**生成物**，别手改：改完 `parts/` 一定要重跑 `build.mjs`，否则
> 提交的是旧产物（0.2.9 发版前就发现过工作区的 `lib/client.js` 落后于 `parts/`）。

自检要点（发布前手动确认一次）：

- `lib/client.js` 里 `__ModuleLoader__.load(` 恰好 **1** 次；
- `lib/index.js` 能被 `import` 且导出 `name='dsh-wm-toolkit'` / `apply` / `inject`（8 个服务并集）；
- 源码哈希与 `profiles\<profile>\node_modules\dsh-wm-toolkit\` 一致（若你同步过部署副本）。

## 2. 打包内容检查

```bash
cd D:\DSH工作区\DSH插件\dsh-wm-toolkit
npm pack --dry-run
```

应包含：`lib/`、`parts/`、`build.mjs`、`cordis.patch.yml`、`LICENSE`、`NOTICE.md`、`README.md`、
`CHANGELOG.md`、`RELEASE.md`（当前共 50 个文件，约 360 kB）。
`parts/*/package.json`、上游 README/CHANGELOG 会一并打进 `parts/`（保留归属，符合 MIT）。

## 3. 发布

发布走 **GitHub Actions + npm Trusted Publishing（OIDC）**：不需要任何 token、不会过期、自带 provenance 签名。
工作流见 `.github/workflows/publish.yml`；`0.1.0` 是首个版本（用一次性 token 手工发布），之后都用 CI。

> ### ✅ 当前状态（2026-09-28 实测）：CI 全链路已通
>
> `.github/workflows/publish.yml` 的每一步都跑得通（checkout / setup-node / 升级 npm CLI /
> tag 与版本一致性校验 / `build.mjs` / `run-all.mjs` / `npm publish` 全部 ✔），
> §3.1 的 Trusted Publisher 早已绑定，**不需要任何 token**。
>
> 已发布版本：`0.1.0`（手工）、`0.2.5`、`0.2.6`、`0.2.7`、`0.2.9`、`0.2.10`（CI）。
> （`0.2.8` 从未发布；它的修复包含在 `0.2.9` 里，跟 `latest` 的用户无关。）
>
> 所以现在的发版流程就是**一条链**：**升版本 + 打 tag + push**，npm 和 Git 一起更新。
> 无需再动 npm 网站上的任何配置。
>
> 两条实测经验（`0.2.9` 发布时踩到的）：
>
> - **npm 是"先收下、后处理"**：CI 绿了之后 registry 里可能还查不到新版本，
>   `dist-tags.latest` 会先停在旧版本，约 **2 分钟后**才出现。遇到"CI 成功但 npm 没有"
>   先等 2-5 分钟再判断，别急着重发（重发会撞上幂等跳过，见 §3.2）。
> - **排查请读 annotations，不要读 job summary**：`GET /repos/{owner}/{repo}/check-runs/{id}`
>   的 `output.summary` 可能是空的；真正的发布日志（含 `+ dsh-wm-toolkit@X` 与
>   provenance 地址）在 `check-runs/{id}/annotations` 里。

### 3.1 一次性配置：npm 侧绑定本仓库（✅ 已完成，留档备查）

> 这一步**已经做过了**，正常发版不需要再碰。只有在换仓库名 / 换工作流文件名时才需要重做。

在包页面配置 Trusted Publisher（必须先存在该包 —— `0.1.0` 已发布 ✔）：

1. 打开 https://www.npmjs.com/package/dsh-wm-toolkit/access
   （或：包页面 → **Settings** 标签 → **Trusted Publisher**）
2. **Select your publisher** 选 **GitHub Actions**
3. 按下面填写（大小写与文件名必须完全一致）：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `Jessicaisleep` |
   | Repository | `dsh-wm-toolkit` |
   | Workflow filename | `publish.yml` |
   | Environment name | （留空） |
   | Allowed actions | `npm publish` |

4. 保存（按钮字样为 **Set up connection** / **Add**）。
5. 私有仓库无法生成 provenance，那种情况下去掉工作流里的 `--provenance`。

配好之后本机的 token 就不需要了：删掉 `C:\Users\<你>\.npmrc` 里那一行（旧 token 已在 npm 侧 Delete）。

### 3.2 发新版（打 tag 即发）

```powershell
cd "D:\DSH工作区\DSH插件\dsh-wm-toolkit"

# 1) 改代码 / 升版本：package.json 的 version 与 CHANGELOG.md
# 2) 本地构建自检
node build.mjs
node tests/run-all.mjs

# 3) 提交并推送（github.com 抽风时见下方「推不上去时」）
git add -A; git commit -m "0.2.10: ..."; git push

# 4) 打 tag 触发发布（tag 必须与 package.json 版本一致，工作流会强制校验）
git tag v0.2.10; git push origin v0.2.10
```

也可以在 GitHub → **Actions** → “Publish to npm” → **Run workflow** 手动触发（手动触发不做 tag 校验，直接用 package.json 里的版本）。

工作流做的事：升级 npm CLI → 校验 tag/版本 → `node build.mjs` → `node tests/run-all.mjs` → `npm publish --provenance --access public`。

> **幂等**：工作流发现 `npm view dsh-wm-toolkit@<version>` 已存在时会跳过发布（exit 0）。
> 所以重复推同一个 tag 不会变红，也不会重复发布 —— 但也意味着**别指望"重推一次"能补救**：
> 版本号必须是新的。

> **推不上去时**（github.com 时段性抽风）：`D:\DSH工作区\github-helper\push-with-retry.ps1`
> 会自动起本地换 IP 代理并重试到成功：
>
> ```powershell
> pwsh -File "D:\DSH工作区\github-helper\push-with-retry.ps1" `
>   -Repo "D:\DSH工作区\DSH插件\dsh-wm-toolkit" -Minutes 30
> # tag 不在该脚本范围内，代理起着时单独推：
> git -c http.proxy=http://127.0.0.1:8899 push origin v0.2.10
> ```
>
> 用完记得关代理（否则 8899 一直被占）：
> `Get-NetTCPConnection -LocalPort 8899 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

### 3.3 应急/本地发布（不用 CI 时）

备用通道（CI 挂了 / 不想等 CI 时用）。本机现在有 `node`/`npm`，也有 `pnpm`：

```powershell
# 一次性：拿到能发布的凭证（推荐 www.npmjs.com → Access Tokens → Granular，
#   Packages and scopes → Permissions = Read and write (publish and stage)，勾 Bypass 2FA）
# 然后写进用户级 .npmrc（注意 token 要写在同一行）：
pnpm config set "//registry.npmjs.org/:_authToken" "npm_xxxxxxxx" --location=user
pnpm whoami                      # 应输出 jessicaisleep

pnpm publish --dry-run           # 预演（会触发 prepublishOnly → build.mjs）
pnpm publish                     # 正式发布
```

- 只有在一台**没有 node** 的机器上才加 `--ignore-scripts` 跳过 `prepublishOnly`；
  这时必须自己保证 `lib/` 已是最新（照 §1 在别的机器上 build 过再提交）。
- 包名 `dsh-wm-toolkit` **不带作用域**，发布默认 public，**不需要** `--access public`（scoped 包才要）。
- 网络需要代理时：`pnpm config set proxy http://<host>:<port>`（`https-proxy` 同理）。

### 3.4 发布后验证

**先查 registry（不必等安装）**：

```bash
npm view dsh-wm-toolkit version          # 应输出新版本号
npm view dsh-wm-toolkit dist-tags --json # latest 应指向新版本
```

> 刚发完可能还是旧版本 —— npm 是"先收下、后处理"，等 2-5 分钟再查（见 §3）。
> 想立刻确认 CI 到底发没发，读 check-run 的 annotations（§3 有 API 路径）。

**再验安装形态**：

```bash
dsh plugin --profile desktop add dsh-wm-toolkit
# 重启 DSH → 插件列表应只多一行；$DSH_HOME\dsh-wm-toolkit.log 应有「半边已应用」
```

> 想确认**推上去的产物真的含新代码**，按 `sha256` 比对最快：把提交
> `git archive <commit> | tar -x -C <空目录>` 后 `node build.mjs`，与
> `https://registry.npmjs.org/dsh-wm-toolkit/-/dsh-wm-toolkit-<版本>.tgz` 里的
> `package/lib/client.js` 比哈希（`0.2.9` 就是这样验的，两边一致）。

## 4. 版本与文档

- 升版本：改 `package.json` 的 `version`（语义化），并在本包 `CHANGELOG.md` 里记一条
  （只记**面向使用者**的包级变化；半边自身的历史留在 `parts/<半边>/CHANGELOG*.md`）；
- 上游同步：三半若要从上游取新功能，改 `parts/` 下对应文件 → 重跑 `build.mjs` → 重跑测试；
- 归属：新增/合并任何上游代码时，同步更新 `NOTICE.md`。

## 5. 回滚

已发布版本不可覆盖，只能发新版。

本地回滚：卸载即回到干净状态 —— `dsh plugin --profile <profile> remove dsh-wm-toolkit`（重启 DSH）。
卸载不会删除任何会话档案、工作区记录或本插件的设置；各半边拆分出去的独立包形态已不再维护
（切换前的 profile 备份在旧 profile 目录里，若该 profile 已被删除则不再可恢复）。
