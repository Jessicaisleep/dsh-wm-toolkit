# RELEASE.md — 发布清单

包名 `dsh-wm-toolkit`（npm 上未被占用，2026-09 核实），当前版本 `0.2.5`。

## 0. 发布前的验证状态

**宿主侧已由日志证据通过**：`$DSH_HOME\dsh-wm-toolkit.log` 里每次启动都有

```
{"message":"半边已应用","data":{"half":"recall"}}
{"message":"半边已应用","data":{"half":"manager"}}
```

（已在 6 次重启中连续出现，说明组合层、两半的 import 与 `apply` 都正常。）

发布前仍需**目视确认 UI**（客户端组合只能靠人眼）：

1. 插件列表里我们这套只占**一行**；
2. 点一遍关键功能：撤回 / 编辑我的消息 / 编辑我的回复（含思考块）/ **↻ 重新生成** / `< >` 回版本 /
   会话 ⋯ 菜单 / 工作区迁移；
3. 若某项异常，先看上面的日志（`半边应用失败（已隔离）` 会带堆栈），再看浏览器控制台。

> 注意：客户端半边改动后需要**刷新页面**（Ctrl+Shift+R）才生效；宿主半边改动需要**重启 DSH**。

## 1. 构建与自检

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$exe='D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe'
$p='D:\DSH工作区\DSH插件\dsh-wm-toolkit'

& $exe "$p\build.mjs"          # 生成 lib/index.js + lib/client.js
& $exe "$p\tests\run-all.mjs"  # 两半离线测试（recall 58 项 + manager 迁移核心）
```

自检要点（发布前手动确认一次）：

- `lib/client.js` 里 `__ModuleLoader__.load(` 恰好 **1** 次；
- `lib/index.js` 能被 `import` 且导出 `name='dsh-wm-toolkit'` / `apply` / `inject`（8 个服务并集）；
- 源码哈希与 `profiles\<profile>\node_modules\dsh-wm-toolkit\` 一致（若你同步过部署副本）。

## 2. 打包内容检查

```bash
cd D:\DSH工作区\DSH插件\dsh-wm-toolkit
npm pack --dry-run
```

应包含：`lib/`、`parts/`、`build.mjs`、`cordis.patch.yml`、`LICENSE`、`NOTICE.md`、`README.md`。
`parts/*/package.json`、上游 README/CHANGELOG 会一并打进 `parts/`（保留归属，符合 MIT）。

## 3. 发布

发布走 **GitHub Actions + npm Trusted Publishing（OIDC）**：不需要任何 token、不会过期、自带 provenance 签名。
工作流见 `.github/workflows/publish.yml`；`0.1.0` 是首个版本（用一次性 token 手工发布），之后都用 CI。

> ### ⚠️ 当前状态（2026-09-24 实测）
>
> GitHub 侧的自动发布**已经跑通了前 7 步**（checkout / setup-node / 升级 npm CLI /
> tag 与版本一致性校验 / `build.mjs` / `run-all.mjs` 测试 全部 ✔），
> **只卡在最后一步 `npm publish`**。
>
> 原因是 §3.1 的 **npm 侧 Trusted Publisher 还没绑定** —— 那是一次性手工操作，
> 没绑定之前 CI 永远发不出去（本地一个 tag 都没有，也从侧面印证 CI 从没成功过）。
>
> npm 上目前只有 **`0.1.0`**（2026-09-18 用一次性 token 手工发的），`0.2.x` 全部还没发布。
>
> **绑定之后不需要重新打 tag**：GitHub → **Actions** → “Publish to npm” → **Run workflow**
> （手动触发不校验 tag，直接用 `package.json` 里的版本）就能补发当前版本。
>
> 也就是说：**绑定完成之后，以后发版只需「升版本 + 打 tag + push」一条链**，
> npm 和 Git 一起更新，不用发两次。

### 3.1 一次性配置：npm 侧绑定本仓库

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
# 2) 本地构建自检（本机没有 node，用 DSH 自带的 Node）
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe" build.mjs
& "D:\Program Files (x86)\DSH Desktop\DSH Desktop.exe" tests\run-all.mjs

# 3) 提交并推送
git add -A; git commit -m "release: 0.1.1"; git push

# 4) 打 tag 触发发布（tag 必须与 package.json 版本一致，工作流会强制校验）
git tag v0.1.1; git push origin v0.1.1
```

也可以在 GitHub → **Actions** → “Publish to npm” → **Run workflow** 手动触发（手动触发不做 tag 校验，直接用 package.json 里的版本）。

工作流做的事：升级 npm CLI → 校验 tag/版本 → `node build.mjs` → `node tests/run-all.mjs` → `npm publish --provenance --access public`。

### 3.3 应急/本地发布（不用 CI 时）

本机 **没有** `node`/`npm`，但有 `pnpm`：

```powershell
# 一次性：拿到能发布的凭证（推荐 www.npmjs.com → Access Tokens → Granular，
#   Packages and scopes → Permissions = Read and write (publish and stage)，勾 Bypass 2FA）
# 然后写进用户级 .npmrc（注意 token 要写在同一行）：
pnpm config set "//registry.npmjs.org/:_authToken" "npm_xxxxxxxx" --location=user
pnpm whoami                      # 应输出 jessicaisleep

pnpm publish --dry-run --ignore-scripts   # 预演
pnpm publish --ignore-scripts             # 正式发布（跳过 prepublishOnly，因为本机无 node）
```

- 包名 `dsh-wm-toolkit` **不带作用域**，发布默认 public，**不需要** `--access public`（scoped 包才要）。
- 网络需要代理时：`pnpm config set proxy http://<host>:<port>`（`https-proxy` 同理）。

### 3.4 发布后验证

```bash
dsh plugin --profile desktop add dsh-wm-toolkit
# 重启 DSH → 插件列表应只多一行；$DSH_HOME\dsh-wm-toolkit.log 应有两条「半边已应用」
```

## 4. 版本与文档

- 升版本：改 `package.json` 的 `version`（语义化），并在 `parts/recall/CHANGELOG-WM.md`
  或本包 CHANGELOG（如需新建）里记一条；
- 上游同步：两半若要从上游取新功能，改 `parts/` 下对应文件 → 重跑 `build.mjs` → 重跑测试；
- 归属：新增/合并任何上游代码时，同步更新 `NOTICE.md`。

## 5. 回滚

已发布版本不可覆盖，只能发新版。

本地回滚：卸载即回到干净状态 —— `dsh plugin --profile <profile> remove dsh-wm-toolkit`（重启 DSH）。
卸载不会删除任何会话档案、工作区记录或本插件的设置；两半的独立包形态已不再维护
（切换前的 profile 备份在旧 profile 目录里，若该 profile 已被删除则不再可恢复）。
