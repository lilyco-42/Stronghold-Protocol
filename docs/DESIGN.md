# 卫戍协议：盟约 — Web Remake · Architecture & Contracts (DESIGN.md)

This is the **single source of truth** for every implementer. Research lives in `docs/research/` (start with `00-INDEX.md`; where a research file's body and its "Addendum (critic)" disagree, the addendum wins). When this document and research disagree, **this document wins**; when this document is silent, follow research; when both are silent, choose the simplest faithful behaviour and write it down in the module's header comment.

Language: player-facing text is **Simplified Chinese** by default, with an English switch since 0.2.0 (§25.2, docs/I18N.md: UI strings through `t('中文')`, game texts from the official Chinese data or the official EN client's). Code, comments and identifiers are English.

Versions: the first public release was **0.1.0** (2026-10-02, the state of §0–§20.15); the releases after it add the player feedback and GitHub reports — 0.1.1 §21, 0.1.2 §22, 0.1.3 §23, 0.1.4 §24 — and **0.2.0** (2026-10-07; `CHANGELOG.md`) the maintainability refactor, two languages, 补位, 自选编队 and their fidelity work — §25 — and **0.2.1** (2026-10-07; `package.json`, `shared/constants.js APP_VERSION`) the 联防 battlefield restored, full potential and the GitHub fixes after it — §26 — and is the state described by this document. The labels v1 / v2 / v2.1–v2.5.2 in §0, §14–§20 and in the BALANCE / SIM comparisons name the design generations and the private playtest builds that came before it; they are kept as history.

---

## Where each section lives

Section numbers are global and never change: code, tests and the other documents cite them as "DESIGN §N". The
current rules by area are in `docs/design/`, the per-release revisions (the evidence behind each rule) in
`docs/history/`. When a revision changes a rule, the rule in `docs/design/` is rewritten too (the revision lists the
normative lines it rewrote).

| sections | file | content |
|---|---|---|
| §0, §1, §2, §11, §12 | [design/overview.md](design/overview.md) | Scope, stack, repository layout, quality bar |
| §3, §4 | [design/geometry-time.md](design/geometry-time.md) | Coordinates, fields, geometry and time |
| §5, §7 | [design/engine.md](design/engine.md) | The battle engine (server/sim) and content modules |
| §6, §16 | [design/match.md](design/match.md) | The match and meta engine (server/match), operator loadouts |
| §8, §14 | [design/network.md](design/network.md) | The network protocol and client-side combat |
| §9, §10, §13, §15 | [design/client.md](design/client.md) | Rendering, UI, local-client art, the 3D board |
| §17 | [history/v2.2-playtest3.md](history/v2.2-playtest3.md) | User playtest #3 (v2.2) |
| §18 | [history/v2.3-playtest4.md](history/v2.3-playtest4.md) | User playtest #4 (v2.3) |
| §19 | [history/v2.4-playtest5.md](history/v2.4-playtest5.md) | User playtest #5 (v2.4) |
| §20 | [history/v2.5-playtest6.md](history/v2.5-playtest6.md) | User playtest #6 (v2.5) and its follow-ups, up to 0.1.0 |
| §21 | [history/0.1.1.md](history/0.1.1.md) | 0.1.1 — player feedback after 0.1.0 |
| §22 | [history/0.1.2.md](history/0.1.2.md) | 0.1.2 — GitHub issues after 0.1.1 |
| §23 | [history/0.1.3.md](history/0.1.3.md) | 0.1.3 — community reports after 0.1.2 |
| §24 | [history/0.1.4.md](history/0.1.4.md) | 0.1.4 — community reports after 0.1.3 |
| §25 | [history/0.2.0.md](history/0.2.0.md) | 0.2.0 |
| §26 | [history/0.2.1.md](history/0.2.1.md) | 0.2.1 — after the 0.2.0 release |

---

## Fork features (lilyco-42)

The sections below are additions maintained in this fork (not in the upstream design index). They describe fork-only
features tracked in [docs/TODO.md](docs/TODO.md).

### 服务器跑马灯公告 (feat/server-announcement, 对标清单 #4)

- **Seen**: 对标社区服 `play.simpfun.cn:14517` 有一条开服的人自己发的全服公告：文字在顶栏滚动 3 遍，每遍 30 秒、遍间隔 5 分钟（`shared/announcement.js`，前后端共用）。我们没有这个功能。
- **Official**: 无。官方没有这个界面，这条完全是运维侧的设施，所以数值（3 遍 / 30 秒 / 5 分钟 / 300 字）按对标对象取齐，不改。
- **Now**: 四个模块，前后端共用一套纯函数规则。
  - `shared/announcement.js`：`ANNOUNCEMENT`（passes 3 / scrollMs 30_000 / gapMs 300_000 / maxChars 300 / maxReceived 1200）、`announcementLifetime()`（690_000 ms）、`announcementPhase(startedAt, now)` → `{phase: 'scroll'|'gap'|'done', pass, waitMs, offsetMs?}`（`pass` 1-based；`now < startedAt` 夹到 0，非有限值读作 done）、`sanitizeAnnouncementText()`（去掉 C0/C1 与 bidi 覆写字符、折叠空白、trim）、`parseAnnouncementCommand(line)`（`^(?:\/?announce|公告)(?:\s+([\s\S]*))?$`，`help`/`clear`/`status` 子命令，长度按**码点**算）。
  - `server/announcement.js`：`AnnouncementBoard` 持有**一条**公告 `{id, text, startedAt}`（不持久化：重启不该把过期公告翻出来）。`publish` 净化 + 长度校验 + **广播一帧** `server.announcement {announcement, serverNow}`；`clear` 广播 `announcement: null`；`current` 在读取时判过期并就地丢弃（过期不广播 —— 客户端自己会停）。
  - 发布入口两条，都汇到同一个板：`server/console.js`（前台 TTY 操作台，`/announce …`；stdin 不是 TTY 时不接，`SP_CONSOLE=1` 强制）与 `server/http/admin.js` 的 `POST /admin/announce`（`SP_ADMIN_TOKEN` 未设置时该路径 404；Bearer 令牌两侧 trim 后做 **sha256 + timingSafeEqual** 固定时间比较；体 `{text}|{action}|{command}` 或纯文本；8 KB 上限）。
  - `public/js/ui/serverAnnouncement.js` + `public/css/server-announcement.css`：`announcementStore` 只存当前帧；`readAnnouncement` 校验 id ≤64 / text / 有限 startedAt 并净化，超过 `maxReceived` 直接读作「无公告」；`ServerAnnouncementHost` 按 `announcementPhase(notice.startedAt, serverNow())` 决定挂载，**只在 phase 变化时重渲染一次**（用 `waitMs` 定时唤醒），滚动交给一条 CSS keyframes。
- **One frame, no re-broadcasts**: 各端自己算位置，所以没有每遍的流量，也没有「停止」帧可丢。
- **Clock**: 用既有的 `store.serverNow()`（`net.js` 的 pong 采样 + `welcome.serverNow` bootstrap），**不新增 `clockOffset` 状态** —— 各端因此同步；信本地 `Date.now()` 会差到一整遍。
- **Late joiner**: `lobby.onHello` 调 `announcements.sendTo(session)` 补发**同一 `startedAt`** 的帧；客户端用负的 `--sann-delay: -<offsetMs>ms` 让 CSS 动画从中途开始，所以中途进来的人接着播剩余遍数，不从头重播。**没有公告时 `sendTo` 不发帧**。
- **Chrome**: 公告条 `pointer-events: none`（点击穿透到游戏）、`z-index: var(--z-banner)`（40，空闲档）、`role="status" aria-live="polite"`、Preact 文本子节点（不解析 HTML）。`sp-ann` 类（`ui/device.js useDocClass`，与连接横幅的 `sp-conn` 同一套办法）把 `.toast-host` 从 `.22rem` 让到 `.52rem`；对局内按 `.sp-in-match` / `.sp-conn` 三段让位。
- **Reduced motion**: `prefers-reduced-motion: reduce` 下 `animation: none` + 居中省略行，**时间表不变**（组件照旧在 scroll 阶段挂载）。

### 房间聊天 (feat/room-chat, 对标清单 #2)

- **Seen**: 对标社区服有房间内聊天；我们没有。属于 fork 在 `lilyco-42/Stronghold-Protocol` 上自研、上游没有的功能。
- **Official**: 无。
- **Now**: 纯文本、按会话限流的房间内聊天，前后端共用 `shared/chat.js` 的纯函数规则。
  - `shared/chat.js`：`CHAT`（maxLen 200 码点 / maxInput 400 UTF-16 / historyLimit 50 / intervalMs 1000 / maxReceived 400 / maxNameLen 24）、`chatLength()`（按码点计数）、`sanitizeChat()`（NFC + 所有行分隔符折叠成一个空格 + 剥掉 C0/C1、软连字符、零宽、bidi 覆写、BOM，但**保留** `\u200c`/`\u200d` 以免破坏合法 emoji 序列与波斯/阿拉伯/天城体拼写）、`parseChatCommand()`（`/chat on|off|clear|status|help`）、`CHAT_HELP`、`mergeChat()`（按 id 去重、按 room code 过滤，历史重推不会重复、别的房间帧不会串）。
  - `server/lobby.js`：`Room.chat[]` + `Room.chatSeq`（单调递增，房间销毁即清空）；`Lobby.chat(session,{text})` 校验 `chatEnabled` → 席位 → 净化 → 长度 → `session.lastChatAt` 限流 → `broadcastRoom({t:'room.chat',code,message})`；`sendChatHistory(room,session)` 在 join / spectate / onHello / reconnect 时补发 `room.chatHistory`；`handleCommand(line)` 接 `/chat` 操作台命令（`off` 时遍历广播 `room.state`）。
  - `server/net.js` 的 `Session` 加 `lastChatAt`（按会话限流，离开重进房间不刷新预算）；`shared/protocol.js` 加 `room.chat`（C2S）与 `room.chat` / `room.chatHistory` / `server.announcement`（S2C）。
  - 开关：`SP_CHAT=0` 启动关；运行中 `/chat off|on|clear|status|help` 经 `server/console.js` 的 `installConsole({ handlers: [srv.lobby] })`。
  - 前端：`public/js/ui/roomChat.js` 的 `RoomChatHost` + `installChat({ net })`；客户端只在 `room.state.chatEnabled === true` 且多人好友房时渲染输入框，单人独立模拟不显示面板。
- **Security**: 消息以纯文本渲染（Preact 转义，无 HTML 注入）；限流按会话、长度按码点；所有不可见字符与 bidi 覆写被剥掉（防「Trojan Source」`\u202e` 翻行）；`maxReceived` 是客户端对 rogue/老服务器的兜底，不是发布上限。
