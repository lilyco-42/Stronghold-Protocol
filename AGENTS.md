# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).

## Hard rules

- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): node --test, smoke, lint, imports, types
npm run golden                              # golden results
```

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

---

# 本 fork（lilyco-42）的附加说明

上游是 `sganggs/Stronghold-Protocol`（GPL-3.0）。本仓库的 `origin` 是**我的 fork**
`lilyco-42/Stronghold-Protocol`，`upstream` 指向上游；本分支
`feat/net-cross-version-capability` 在最新上游之上多 17 个提交（2026-10-05 合并到 `bd892a4` 之后又走了几个提交；
这个数每提交一次就会变，所以别引用它 —— 现测：`git rev-list --left-right --count upstream/master...HEAD` = `0 17`，
左边为 0 才是要紧的判据：**不落后于上游**）。
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
| `6ea4a0e` | 网页侧也钉"零站外请求"（判据与客户端闸门一致：按引用形式扫，注释里的 URL 不算） | `test/webfonts-local.test.js` |
| `4cef77b` | 网页版这一侧钉住 **node 服务怎么发镜像字体**（mime / 长缓存 / `font-display: swap` / 点路径一律 403），带正控制与变异复验 | `test/webfonts-serve.test.js` |

## 2. 跑测试与已知的非回归红（三条 CPU 阈值闸 + 一条 Windows 定时器脆弱）

```
npm install --ignore-scripts ws        # 服务端只依赖 ws；postinstall 会去拷 vendor，跳过
npm test                                 # 全量：node --test
```

2026-10-06 在 `224eb92`（合并上游 `a9dfd17` 之后）整跑实测：**3707 项 / 3690 过 / 1 失败 / 16 跳过，退出码 1**；
红的正是下面第三条闸（`best 0.688 ms/tick`，三次 0.800/0.688/0.871），**单独复跑 `node --test test/sim/perf.test.js test/sim/robustness.test.js` → 37/37 全过、退出码 0**。
上一次记录：2026-10-05 16:41 在 `3dd1a2c` 整跑 **3643 项 / 3624 过 / 3 失败 / 16 跳过**（条数随负载变，见下）。
那 3 条都是 0.5 ms/tick 的阈值闸，不是回归：`test/sim/perf.test.js:22`、`test/sim/perf.test.js:43`（两条 70 敌 + 10 干员的 benchmark）与
`test/sim/robustness.test.js:739`（双人 BOSS 场）。**同一批文件单独复跑 37/37 全过**（`node --test test/sim/perf.test.js test/sim/robustness.test.js`）。
📌 栈里报的行号是**断言所在行**，不是 `test(...)` 的声明行：合并后 BOSS 场那条的断言落在 `robustness.test.js:765`，
而声明仍在 `:739`。按栈去改文档里的引用会把一个正确值改错 —— 认引用时先 `grep -n "best of 3"` 看声明行。
判负载的依据：这三条闸测的是 `server/sim/**`，而本分支 `git diff upstream/master..HEAD -- server/sim test/sim` **为空**。
⚠️ 整跑红的条数会随本机负载变（同一天里 1→2→3 条都出现过），所以"几条失败"不能当判据 —— 判据是**失败的是不是这几条阈值闸**，
是就单独复跑，不是就是真回归。
**别把它们当回归，也别拿整跑的绿当已验证** —— 要么单独复跑，要么明说没测。

 第四条与上面三条不同：`test/e2e/client-wait.test.js` 的「a wait longer than one slice keeps polling the same
predicate until it holds」在 **Windows 上稳定红**（2026-10-06 合并上游 `9f93096` 后整跑 3781 项 / 3769 过 / 2 失败，
单跑也是 4 过 1 失败，两次一致）。**这是测试脆弱，不是产品缺陷，别去改实现**：它断言"至少 4 片"，而每片是
`setTimeout(30)`；Windows 的定时器粒度让 30 ms 实际 41–47 ms 才触发，于是第 3 片起始时剩余已 ≤ 一片长，
`fakePage` 当场 resolve，永远轮不到第 4 片。实测证据：把同样的比例放大 10×/100× 再跑，切片起始变成
`0,309,618,928` 与 `0,3009,6016,9029`（过冲占比回到 3%），行为就符合断言 —— 也就是差在定时器精度，不在
`waitForFunctionLong` 的循环（它确实一直轮询到 deadline）。上游 CI 跑 Linux 所以看不见。
判据：这条红 + 上面三条阈值闸红 = 整跑最多 4 条红，都不算回归；**但必须先按"是不是这几条"核对**，
新的红名一律当真回归处理。

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
   这条由 `test/webfonts-local.test.js`（扫全树 html/css/js/mjs/json）+ `test/client-static.test.js` 钉住，
   **"发出去的那一份对不对"由 `test/webfonts-serve.test.js` 钉**（对 `createStaticHandler` 起真服务，量到的是
   `text/css` / `font/woff2` / `public, max-age=86400` / 含 `font-display: swap` / 三种点路径写法一律 403）。
   改这一块要跑的三条与实测值（2026-10-05 16:28–16:30 本机）：
   `node tools/fetch-webfonts.mjs --check --verify-bytes` → 112/112 rc=0；
   `node --test test/webfonts-local.test.js test/webfonts-serve.test.js` → 10/10；
   `node ../StrongholdProtocolClient/tools/check-payload-offline.mjs public` → 0 问题。
   同一文件里还有一条更宽的：`public/` 下**任何引用形式**（href/src/url()/fetch/@import/`new WebSocket('http…')`）
   都不许指向站外 —— 只认引用形式，不认裸 URL：vendor 里上百条注释链接和 SVG 的 `xmlns` 标识符不发请求，
   一起禁等于把闸门静音。测试自带一条自校准（裸 URL 计数必须 >20，否则说明扫描没跑到 vendor/）。
   与客户端仓库 `tools/check-payload-offline.mjs` 是同一套判据，两边都要过。加回外链时测试会点名文件。
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
| `lilyco-42/StrongholdProtocolClient` | 桌面(Electron) + 安卓(Capacitor) 打包与 CI | 只从 payload 构建，不本机编译；五道闸门（完整性 / 版本 / **出处** / 暂存离线 / 产物离线）；细节见该仓库 `AGENTS.md` |
| `lilyco-42/lain42-stronghold-ops` | 生产机的事实：带宽、OSS、混合部署事故、核对单 | `docs/13-upgrade-drift-checklist.md` 是换基线后的整套核对 |
| 本仓库 | 游戏代码 + §1 表里那批提交 | **别以为有 CI**：fork 的 Actions 开关是开的（`/actions/permissions` 回 `enabled:true`），但 workflow 从未被注册（`/actions/workflows` 空、runs `total_count:0`），推分支也不会跑，`gh workflow run ci.yml` 报 "not found on the default branch"。所以 §1 那批提交的测试证据只有本机 `npm test`；要 CI 级的绿只能走上游 PR（本任务约定不开） |
