# 服务器目录接口 `/servers.json`（扩展点）

> 这一份是**给实现双方的约定**：服务器作者照它提供，客户端照它消费。上游没有这个接口，也不会有 ——
> 它是我们这条 fork 的扩展点，所以单独成文（与 [SKINS.md](SKINS.md) / [VOICE.md](VOICE.md) 同一类），
> 不动 `docs/design/network.md` 的章节号。

## 1. 为什么要有它

客户端的服务器列表原先只有一种改法：写死在打包仓库 `shell/picker-core.js` 的 `COMMUNITY_SERVERS` 里。
那份文件是**逐字拷进 payload** 的，所以每加一条服就要重切一次包、重出一版客户端（c10→c11、c11→c12 两次都是这么来的）。
网友服随关随开，一周的变动比一个版本周期还多 —— 于是列表永远比现实旧。

改成：客户端在启动时向**一个已知的服务器**要这份列表。以后加服只改服务器上的一份 JSON，不用出包。

## 2. 端点

```
GET  <origin>/servers.json
```

- 只要求支持 `GET`；`HEAD` 可选。**不需要鉴权**（这是公开目录，游玩口令是另一回事）。
- 走 HTTPS（打包客户端的页面在 `http://127.0.0.1:47821`，混合内容规则会拦掉明文的 `http://` 子资源；
  只有本机/局域网开发场景才允许 http）。
- 路径与文件名固定为 `/servers.json`。客户端也接受 `?servers=<绝对 URL>` 覆盖（自建服的人指到自己的目录）。

### 2.1 CORS —— 这条最容易漏，漏了整个接口就是哑的

客户端页面与服务器**不同源**。仓库里的 `server/` 代码**没有**任何地方发 `access-control-allow-origin`
（实测线上只有 `/healthz` 带 `*`，页面与 `data/*.json` 都不带 —— 那条头是 Pingap 那层加的）。所以：

> **提供这个接口的服务器必须自己发 `Access-Control-Allow-Origin: *`**，否则打包客户端读到的就是
> "Failed to fetch"，行为等同于没有这个接口。

`Content-Type: application/json` 是简单请求，不会触发预检，所以不需要处理 `OPTIONS`。
如果将来加了非简单头，才需要 `Access-Control-Allow-Headers`。

### 2.2 缓存

```
Cache-Control: no-cache
```

目录的价值就在于"今天关了的服明天不出现"。要 CDN 缓存的话最多 `max-age=300`，别更长。
（同一层还有一道客户端保护：见 §5 的 `If-None-Match`/`maxAgeMs`。）

## 3. JSON 形状

```json
{
  "version": 1,
  "generated": "2026-10-08T00:00:00Z",
  "servers": [
    {
      "name": "网友服 · simpfun",
      "address": "http://play.simpfun.cn:14517/",
      "note": "14517 端口 · 明文",
      "tags": ["matchmaking", "3d-assets"],
      "language": "zh",
      "app": "0.2.1"
    }
  ]
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `version` | 是 | 目前只有 `1`。客户端见到不认识的大版本就**整份忽略**（见 §6） |
| `servers` | 是 | 数组，最多取前 **40** 条（超出的客户端丢弃） |
| `servers[].name` | 是 | ≤ 32 个字符（客户端再截一次），单行，不含 HTML |
| `servers[].address` | 是 | 必须过客户端的 `addressError()`：`host` / `host:port` / `http(s)://…` / `ws(s)://…` 都行；过不了就整条丢 |
| `note` / `tags` / `language` / `app` | 否 | 见 §4 |
| `generated` | 否 | 仅用于显示"这份目录是什么时候的" |

**`name` 与 `address` 都按纯文本处理**：客户端插入 DOM 前一律转义，因为这两个字段来自远端。

## 4. 能力与多版本兼容：客户端不另起一套

**分工**：这个接口由服务器作者定义与提供；客户端只负责"拿到就合并、拿不到就用旧的"，
不自造协议字段。版本兼容沿用**已经存在的那条链路**，不新增概念：

- 选择页探测 `/ws` 判可达；顺带读 `GET /healthz` 的 `app`（我们的服务器在那条路上带
  `access-control-allow-origin: *`，静态路由不带 —— 实测）；
- `public/js/net.js` 的 `VERB_MIN_APP` + `verbAvailable()` / `verbUnavailableText()` 决定"这台服务器不认这个操作"
  要不要在点之前就灰显（`room.spectate`/`room.kick`/`room.removeSpectator` 钉在 0.1.3，
  `room.ownership`/`room.diy` 钉在 0.2.0）；服务器自己的 `unhandled type` 回答始终是最终依据；
- 所以目录 JSON 里**唯一对客户端有意义的版本字段就是可选的 `app`**，用来在列表行上显示"这台是 0.1.4"，
  让玩家在上车之前就知道哪些功能不会有。`tags` 一类的私有枚举**不要加**：一旦客户端按它做判断，
  就等于在 `shared/protocol.js` 之外另立了一套能力协商，上游加动词时没人记得同步它。

## 5. 客户端行为约定

1. **不阻塞首屏**：列表先到（内置种子 + 玩家自己的 `sp.shell.list`），`/servers.json` 回来后再合并刷新。
2. **合并规则与去重**：按 `toWsUrl(address)` 作 key（与现在种子用的同一个 key 函数），
   玩家已经手输过的地址不会多出第二条。
3. **删除要能永久**：客户端记下"这台已经给过我了"的 key 集合（`sp.shell.seen`）。玩家删掉的条目
   下次拉到目录也不会回来 —— 这是原 `SEED_VERSION` 机制保住的行为，接口化之后必须继续成立。
4. **超时与静默**：默认 6 s 超时；404 / CORS / 超时都**不提示**（拿不到就用上次的缓存 + 内置种子）。
   一次成功的结果写进 `sp.shell.remote` 缓存（含时间戳），离线启动时用不超过 `maxAgeMs`（默认 7 天）的缓存。
5. **绝不自动连接**：接口只往列表里加行，选中与进入仍然只由玩家点。
6. **上限**：一次最多合并 40 条；名字截 32 字符；JSON 超过 64 KB 直接不解析（防一个坏目录把选择页撑爆）。

## 6. 兼容矩阵（老客户端 / 老服务器）

| 组合 | 行为 |
| --- | --- |
| 老客户端 + 有接口的服务器 | 完全无影响：它不发这个请求，也看不懂 `tags`。多一个静态文件不改变任何既有路由 |
| 新客户端 + 老服务器（无接口） | 404 → 静默回落内置种子；这不是错误，**不许**弹提示 |
| 新客户端 + 有接口但没发 CORS 头 | 同上（浏览器拦成 fetch 失败）。所以 §2.1 是实现方的硬要求，不是建议 |
| `version` 不认识 | 整份忽略，按 404 处理；**不许**猜测字段 |
| 服务器被写入恶意地址 | 地址必须过 `addressError()`；玩家仍可删除；列表不自动连；名字按纯文本转义。要收紧的话用 §7 的白名单来源 |

## 7. 目录从哪来

- 我们这台默认指 `https://sp.lain42.top/servers.json`（打包仓库 `shell/picker-core.js` 里的 `SERVERS_URL`）。
- 任何一台 fork 也可以发布自己的目录，客户端通过 `?servers=` 指过去。
- 实现上**不需要写代码**：`public/servers.json` 是静态文件，`public/**` 是读盘服务的（不重启就生效），
  唯一要补的是那行 CORS 头。要它自动更新（比如从各服的 `/healthz` 汇总），就交给一个定时任务重写这个文件。
- 一句话事实留给服务器作者选路：静态文件必须补那行 CORS 头才能被打包客户端读到；
  走 `/ws` 则不受 CORS 约束，但那要在 `shared/protocol.js` 里加动词、并按上游的扩展点规则走。
  客户端两边都能配合，**但一次只实现一种**，别同时给两个真源。

## 8. 实测记录（2026-10-08 复测，只读探测：`/ws` 握手 + `/healthz` 字段）

⚠️ 这张表**改过**。第一版的探测是从打包用的那台机器发的，结论是"只有 2 台能握手，其余 4 台回 403"。
复测时发现那台机器的 DNS 正把这些域名解析到代理的 fake-IP 段（`nslookup play.simpfun.cn` → `198.18.0.177`），
所以它给出的阴性结果不可信。下表换一个视角重测（自己的服务器上做只读 curl，不写不改不重启），
并且每一行都带上可核对的 `/healthz` 字段。至于当初那四条 403 是代理造成的还是那几台当时确实没放开 `/ws`
（其中一台 `uptime 83468 s`，也就是复测前约 23 小时才起），两个来源都给不出解释 —— 不写因果，只把数记下来。

| 地址 | `/ws` | `/healthz` | 结论 |
| --- | --- | --- | --- |
| `http://play.simpfun.cn:14517/` | **101** | `app 0.1.3`，`uptime 83468 s`，`build 516f1c…` | 可列 |
| `http://43.161.201.122:14517/` | **101** | `app 0.2.1`，`uptime 8892 s`，`build bfbee97…` | 可列。**与上一条不是同一台**：版本号与开机时长都对不上，只是同端口 |
| `https://weishuxieyiwangye.cn:8443/` | **101** | `version 0.1.3`，`runtime cloudflare`，`build local` | 可列（第一版记的 403 已推翻） |
| `https://play.nekocraft.net:9888/` | **101** | `version 0.1.3`，`runtime cloudflare`，`build 5e7f8af` | 可列（同上） |
| `https://stronghold.lunar.ag/` | **426** | `version 0.1.4`，`runtime cloudflare`，`build bef482f` | 不列：`/healthz` 通，但 `/ws` 回 426（Upgrade Required），握手不成 |
| `https://ark-proto.stardust.matce.cn/` | **403** | `/healthz` 也是 404 | 不列（两个视角一致） |
| `https://sp.lain42.top/`（我们自己的服） | 环回 `404` | `app 0.2.1`，`sockets 15` | 不是一张对照表：服务器从**本机** curl 自己的 `/ws` 不算 WebSocket 客户端，所以这一行只说明"`/healthz` 活着"。第一版把它当"阳性对照"是错的。握手要从**外部**测（玩家侧或第三方视角） |

⚠️ 还有一个空白要承认：`101` 只证明"这个地址的 `/ws` 完成了 WebSocket 升级"，
它**不等于客户端连上就能玩**（登录、建房、进对局是另一回事）。这张表到此为止只回答"能不能握手"；
"能握手的能不能玩"由 `#47` 那套带阳性对照的探针回答，测完才能把它写进"可列"。

复现命令（在**没有 fake-IP 代理**的机器上跑；`--max-time` 别让卡死的探测拖住你）：

```bash
curl -sS --max-time 10 "$h/healthz"
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$h/ws"
```

`101` 是这里唯一算数的阳性信号（真的完成了 WebSocket 升级），`426` / `403` 都连不上。
另外注意 `runtime: cloudflare` 那几台套了 CDN：`/ws` 从我这儿通，不代表玩家那边也通 ——
CDN 的 WebSocket 开关在服主手上。这也正是别把地址写死进客户端、交给目录接口由服主自己填的理由之一。
