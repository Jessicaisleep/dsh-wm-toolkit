# RELEASE.md — 发布清单

包名 `dsh-wm-toolkit`（npm 上未被占用，2026-09 核实），当前版本 `0.1.0`。

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

### 3.1 准备账号（一次性）

1. 浏览器打开 https://www.npmjs.com/ 注册账号（免费）。用户名建议与 GitHub 一致。
2. 登录排障：本机 **没有** `node`/`npm`，但有 `pnpm`（DSH 自带），发布走 `pnpm publish`。
   二选一登录：
   - `pnpm login`（输入用户名 / 密码 / 邮箱 OTP）；或
   - 更稳：npmjs.com → Account → **Access Tokens** → Generate New Token
     （Classic + 勾 **Bypass 2FA**，或 Automation 类型），把 token 写进 `C:\Users\<你>\.npmrc`：

     ```
     //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx
     ```

### 3.2 发布

```powershell
cd "D:\DSH工作区\DSH插件\dsh-wm-toolkit"

# 预演（不真的发；已验证可用）
pnpm publish --dry-run --ignore-scripts

# 正式发布
pnpm publish --ignore-scripts
```

- `--ignore-scripts` 的原因：本机 PATH 里没有 `node`，而包内 `prepublishOnly: node build.mjs` 跑不起来；
  发布前请**先在源码目录用 DSH 自带的 Node 跑一次 `build.mjs`**（见第 1 节），
  或用 `npm publish --ignore-scripts` 前先手动构建。装了 Node 的机器可直接 `pnpm publish`。
- 包名 `dsh-wm-toolkit` **不带作用域**，首次发布默认就是 public，**不需要** `--access public`
  （那是 scoped 包才要求的）。
- 若网络需要代理才能访问 npm：`pnpm config set proxy http://<host>:<port>`（https-proxy 同理）。

### 3.3 发布后验证

```bash
dsh plugin --profile desktop add dsh-wm-toolkit
# 重启 DSH → 插件列表应只多一行
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
