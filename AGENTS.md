# AGENTS.md — 在这个 fork 分支上干活该知道的

上游是 `sganggs/Stronghold-Protocol`（GPL-3.0）。本仓库的 `origin` 是**我的 fork**
`lilyco-42/Stronghold-Protocol`，`upstream` 指向上游；本分支
`feat/net-cross-version-capability` 在最新上游之上多 9 个提交（2026-10-05 合并到 `bd892a4`，
`git rev-list --left-right --count upstream/master...HEAD` = `0 9`）。
**约定：改动只推到自己 fork 的分支，不主动开上游 PR。**

## 1. 这个分支加了什么（`git log --oneline upstream/master..HEAD`）

| 提交 | 干什么 | 落地在哪 |
|---|---|---|
| `64ac69e` + `f853c1a` | 客户端从服务器的**回答**里学"这台服务器不支持哪个动词"，并把它用到界面上 | `public/js/net.js`（`serverLacks`/`verbAvailable`/`NetError`）、`screens/lobby.js`、`screens/room.js` |
| `80e912b` | 认出旧服务器的真回答是 `unknown type <verb>`（不只是 `unhandled type`） | `net.js` 的 `UNHANDLED_RE`；实测依据见运维仓库 `docs/09` |
| `22deb2d` | 能力记账按**将要拨号的地址**，不是 `net.url`（导出的单例上 `url` 是空的） | `net.js` 的 `serverKey()`；`test/net-unsupported.test.js` 里有专门一条防回归 |
| `a2ccc3a` | `mediaUrl` 按宿主能力决定要不要改写成 `/media/…` 无扩展名别名（Capacitor 解不了它，安卓会静音） | `public/js/media.js` + `globalThis.__SP_MEDIA_ALIAS__` |
| `5aa4405` | 把 Google Fonts **逐字节镜像**进仓库，网页版与打包客户端不再依赖外部字体主机 | `public/webfonts/google/`（112 woff2 + `google.css`）、`public/index.html`、`tools/fetch-webfonts.mjs` |
| `75fb8eb` | `--check --verify-bytes`：把镜像与 Google 当前提供的字节逐个比 sha256 | `tools/fetch-webfonts.mjs` |
| `86719d1` | `dev/uikit.html` 也改用它；再加一条**全树**检查 | 同上 + `test/webfonts-local.test.js` |
| `11f9c5c` | 钉住"版本号说 0.1.3、线级却拒收"时客户端仍会自纠 | `test/net-unsupported.test.js` |

## 2. 跑测试与已知的那条 CPU 闸

```
npm install --ignore-scripts ws        # 服务端只依赖 ws；postinstall 会去拷 vendor，跳过
npm test                                 # 全量：node --test
```

2026-10-05 实测：**3638 项 / 3621 过 / 1 失败 / 16 跳过**。唯一那条失败是
`test/sim/robustness.test.js` 的阈值闸（best-of-3 实测 0.52 ms/tick，限 0.5）—— 并行整跑时因本机负载才红，
单独跑该文件 35/35 通过（878–2024 ms）。判它是负载不是回归的依据：这条闸测的是 `server/sim/**`，
而本分支 `git diff upstream/master..HEAD -- server/sim test/sim` **为空**。
**别把这条 flake 当回归，也别拿整跑的绿当已验证** —— 要么单独复跑，要么明说没测。

## 3. 这个仓库的硬约定（改错了会静默出事）

1. **`public/assets|fonts|vendor` 与 `data/local-assets.json` 不在 git 里**（`npm run assets` 现抓）。
   干净 clone 一张美术都没有 → 打包 payload 必须找有机器的素材那份树。
2. `tools/fetch-assets.mjs` 会把 `data/assets.json` 的 `stats.bytes` 改掉（`hash`/`files` 不变）。
   那是**无内容差异**：提交它或带着它打包，会让下游 payload 的 `build.json` 标 `dirty:true`。
   跑完素材就 `git checkout -- data/assets.json`，除非你真的改了素材集合。
3. 字体镜像的再生成与验证：
   ```
   node tools/fetch-webfonts.mjs                 # 重抓（务必带 Chrome UA，见下）
   node tools/fetch-webfonts.mjs --check                          # 不写盘，只查完整性
   node tools/fetch-webfonts.mjs --check --verify-bytes           # 再逐个比 sha256（112/112 才算"同一套字形"）
   ```
   ⚠️ 必须用**现代 UA** 取 `css2`：不带 UA 拿到的是未切片老格式（11 个 / 43.3 MB），
   带 Chrome UA 才是浏览器真正用的 421 个 `@font-face` / 112 个 woff2 / 4.84 MB。用错量级会做出错误的方案决策。
   上游若升字体版本，`--verify-bytes` 会红 —— 那是提示重跑生成器并重新提交，不是坏了。
4. `public/index.html` 与 `public/dev/uikit.html` 都不得再出现 `fonts.googleapis.com` / `fonts.gstatic.com`；
   这条由 `test/webfonts-local.test.js`（扫全树 html/css/js/mjs/json）+ `test/client-static.test.js` 钉住。
   加回外链时测试会点名文件。
5. `/media/<track>`（无扩展名，躲下载管理器）只有 **node 服务器**与 Electron 壳的 `serve.mjs` 解得了；
   Capacitor 是纯静态宿主 → APK 必须设 `__SP_MEDIA_ALIAS__ = false`，否则全场静音。别在 `media.js` 里去掉这个开关。

## 4. 版本与能力是两件事（今天的实测教训）

- 线路格式号 `PROTOCOL_VERSION` 上游一直不升（0.1.1/0.1.2/0.1.3 都是 `1`），**不能**用来协商版本。
- 唯一的版本信号是 `GET /healthz` 的 `app`；跨源能读靠生产侧 pingap 的 `sp_healthz_cors` 插件。
- 但 `app` 不等于能力：2026-10-05 线上 `app:"0.1.3"`，而 `room.spectate` 实际回 `BAD_MSG unknown type`
  （那次部署换了 `server/` 没换 `shared/protocol.js`，`server/net.js:587` 判类型只看后者的 `C2S` 表）。
  所以客户端的策略是**回复优先**：版本号可以点亮入口，但服务器一旦回 `unknown type <verb>`，
  该动词就按"这台服务器没有"处理（按 `serverKey()` 分机记账）。别把它改成只信版本号。
- 复现/核对命令在运维仓库：`lain42-stronghold-ops/scripts/probe-server-capability.mjs`（自带正控制；
  `hello` 的 `name` 要用短名字，长名字服务器不回 welcome）。

## 5. 相邻仓库（谁负责什么）

| 仓库 | 职责 | 备注 |
|---|---|---|
| `lilyco-42/StrongholdProtocolClient` | 桌面(Electron) + 安卓(Capacitor) 打包与 CI | 只从 payload 构建，不本机编译；四道闸门（版本 / 完整性 / 暂存离线 / 产物离线）；细节见该仓库 `AGENTS.md` |
| `lilyco-42/lain42-stronghold-ops` | 生产机的事实：带宽、OSS、混合部署事故、核对单 | `docs/13-upgrade-drift-checklist.md` 是换基线后的整套核对 |
| 本仓库 | 游戏代码 + 上面那 9 个提交 | **别以为有 CI**：fork 的 Actions 开关是开的（`/actions/permissions` 回 `enabled:true`），但 workflow 从未被注册（`/actions/workflows` 空、runs `total_count:0`），推分支也不会跑，`gh workflow run ci.yml` 报 "not found on the default branch"。所以上面那 9 个提交的测试证据只有本机 `npm test`；要 CI 级的绿只能走上游 PR（本任务约定不开） |
