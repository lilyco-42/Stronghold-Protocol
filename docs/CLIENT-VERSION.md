# 客户端与服务端的版本落差

> 与 [SERVERS.md](SERVERS.md) 同一类：**我们这条 fork 的扩展点**，上游没有也不会有，所以单独成文，
> 不动 `docs/design/network.md` 的章节号。约定的一端在 `shared/protocol.js`（`hello.app`），
> 另一端在 `public/js/net.js` 与 `server/net.js`。

## 1. 为什么要有它

**战斗是客户端自己算的。** `public/js/battle/runner.js` 用自己的 `/sim/` 与 `/data/` 建 `Battle`，
算完把 `b.result` 报给服务端，服务端**幂等收下、不复算**（`runner.js` 自己的注释：
"a battle simulated without part of the data would still produce a plausible result the server accepts"）。

于是：**一个比服务端旧的客户端，按旧规则算完就报，服务端照收。** 这就是玩家说的
「客户端和服务端不同步」—— 而它以前完全静默。

`PROTOCOL_VERSION` 挡不住这件事，因为它在**每个 release 上都是 1**（`shared/constants.js` 的注释写得很清楚：
"the separate wire-format number"）。它只在协议真的改了线格式时才动，不随 release 走。

### 1.1 实测（2026-10-11）

已发布的客户端 payload 对当时的线上服务端（`origin/deploy/prod`），只比会决定战斗结果的那几棵树：

| 客户端 | 游戏提交 | `server/sim` | `shared` | `data` | 结论 |
| --- | --- | --- | --- | --- | --- |
| `v0.2.2-c32` | `082fc0a8` | **20 文件 +411 −74** | **2 文件 +9 −3** | **10 文件 +98 763 行** | 真的不同步 |
| `c33` … `c39` | 各自的分支提交 | 相同 | 相同 | 相同 | 只有 `public/js` 的客户端专用渲染文件不同，模拟一致 |

两边的 `APP_VERSION` 分别是 `0.2.2` 与 `0.2.3`，而 `PROTOCOL_VERSION` 都是 1 —— 所以那台 `c32` 客户端
的 `hello` 顺利通过版本检查，进去照常玩，按 0.2.2 的规则算完每一场。

`c33`…`c39` 那几行是**判据选 release 而不是 build 的依据**：它们的 `public/js` 与服务端并不逐字节相同
（客户端专用的渲染修复），但模拟与数据相同 —— 拿 build 比会误报，拿 release 比正好。

## 2. 线路上多了什么

| 位置 | 字段 | 谁发 | 说明 |
| --- | --- | --- | --- |
| `hello` | `app` | 客户端 | **新增**。客户端自己的 release（`shared/constants.js` APP_VERSION）。可选；不带的老客户端照收 |
| `welcome` | `app` | 服务端 | 早已存在（0.2.1 起）。不依赖 CORS 的那条通道 |
| `/healthz` | `app` | 服务端 | 早已存在 |
| `/healthz` | `clientApps` | 服务端 | **新增**。开机以来见过的、**不是自己这一版**的客户端 release 计数（外加 `unknown`） |

`app` 是**加在既有 `hello` 上的一个字段**，不是新动词 —— 走 `shared/protocol.js` 的扩展点规则，
按 `validateC2S` 的表校验（`isAppVersion`：≤ 24 字符、`[A-Za-z0-9._-]`）。
注意 `hello` 在 `server/net.js` 里**在查表之前**就被分派给 `onHelloMsg`，所以服务端侧的唯一防线是
`Network.countClientApp` 里的同一个谓词。

## 3. 两端各自做什么

**服务端**（`server/net.js`）：每建立一个 **session** 记一次 `countClientApp(msg.app)` ——
改名会在活着的 socket 上重发 `hello`、重连会 resume 同一个 session，两者都不算新客户端。
只留**不是自己这一版**的（自己这一版不占位），最多 8 个，多出来的折进 `(other)`（键来自线路，必须有界）。

**客户端**（`public/js/net.js` → `ui/connBanner.js`）：`versionSkew()` 把 `serverApp` 和自己的
`APP_VERSION` 比出 `same` / `client-older` / `server-older` / `unknown`，横幅只说 **`local`** 的那一种 ——
即**页面不是这台服务器发的**（打包客户端：Electron / Tauri 在 `127.0.0.1:47821`，Capacitor 在
`https://localhost`）。理由：服务器自己发的页面一部署就会被 `ui/buildGuard.js` reload 掉，
再说一遍只是噪音；而打包客户端 reload 读回的是**同一份固定的 payload**，reload 永远修不了它，
所以只能说出来。

**两边都不拒绝任何人。** 旧客户端照常玩 —— 与 `docs/AUTO-UPDATE.md` 那条"自动更新绝不能变成
有人打不开游戏"同一条底线。这个功能只把一件静默的事变成可见的事。

## 4. 兼容矩阵

| 组合 | 行为 |
| --- | --- |
| 老客户端 + 新服务端 | `hello` 没有 `app` → 记成 `unknown`（**这本身就是"它很旧"的信号**）；照常玩 |
| 新客户端 + 老服务端 | 老服务端不认识 `app`，`onHelloMsg` 不看未知字段，照常 `welcome` |
| 新客户端 + 老服务端（连 `welcome.app` 都没有） | 客户端读 `/healthz` 的 `app`；读不到 → `unknown` → **不显示任何提示**（自建服没给 CORS 是常态，不能当成"版本不一致"） |
| 打包客户端 + 更旧的服务端 | 横幅：「这台服务器比客户端旧，部分功能可能不可用」（与 `VERB_MIN_APP` 的灰显互补） |
| 打包客户端 + 更新的服务端 | 横幅：「客户端比服务器旧，本局战斗由客户端计算，结果可能与服务器不一致」 |
| 网页版 | 不出这个横幅 —— 交给 `ui/buildGuard.js`（`build` 标签一动就 reload） |
| 上游客户端连我们 | 不认识 `app` 就不发；我们不因此拒绝任何东西 |

## 5. 主机怎么看

```bash
curl -sS https://<host>/healthz | python -m json.tool
```

`clientApps` 空 = 所有连上来的客户端都是这一版；`{"0.2.2": 12, "unknown": 3}` = 12 个旧客户端、
3 个旧到连自己是什么版本都报不出来。它是**开机以来的累计值**（进程重启归零），
够用来回答"群里说的那个问题影响多少人"，不是实时在线数 —— 实时在线看 `sockets` / `sessions`。

## 6. 这份约定不做什么

- **不做版本协商**：不因为版本不同就禁用功能、降级玩法或拒绝连接。灰显仍然只由
  `VERB_MIN_APP` + 服务器自己的 `unhandled type` 回答决定（[SERVERS.md](SERVERS.md) §4）。
- **不用 build 标签判**：`/healthz.build` 是**同一台服务器自己前后**的比较（`ui/buildGuard.js`），
  它算的是"这台服务器换没换"，不是"我和它是不是同一版"。
- **不替代自动更新**：这个功能让落差可见，让它消失是 `docs/AUTO-UPDATE.md` 的事。
