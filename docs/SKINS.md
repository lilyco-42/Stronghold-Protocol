# 干员皮肤 (Operator skins)

> **本仓的实况（移植时核对，2026-10-06）**：下面这份文档来自上游作者 Paper-Yuan 的分支 `0.1.6-pre-skin`，其中
> **描述了他本地但尚未公开推送的那一半**，本仓**没有**：`tools/install-skins.mjs`、`server/skinInstall.js`、
> 协议动词 `room.skin.install`、`test/skins-protocol.test.js`、`test/ui/skins.e2e.test.js` —— 在他四个分支上全部
> 404，文档依赖的 `fexliModelDef` 在其已推代码里也搜不到。
> 本仓实际有的是：`docs/research/08-skins.json`（174 款 / 115 干员的静态表）、`tools/build-skins.mjs`、
> `tools/fetch-skin-{avatars,spines}.mjs`、`tools/inject-skins-assets.mjs`、`data/skins.json`（目录，无 URL）、
> `public/js/ui/skins.js` + `skinPicker.js`、协议 `room.skins`，以及「Edits to existing files」表里那些改动块
> （逐个按 skin 关键字筛出来、重新落到本仓 `19a8908` 基线上；该表**漏了** `public/js/ui/loadoutModel.js` 的
> `sanitizeSkins`/`mergeSkins` 与分享码扩展，也漏了 `GAME_FILES` 必须加 `'skins'` —— 后者由
> `test/ui/playtest3.test.js` 强制）。
> 装素材的方式因此是**构建期**的：`tools/fetch-skin-*.mjs` + `tools/inject-skins-assets.mjs` 把选中的皮肤写进
> `data/assets.json`；清单就是 `data/skins-installed.json`。**本仓现在预装 12 款 starter 皮肤**（2026-10-06 起，
> 见下节），改成空数组就退回「一个皮肤都不下载」，字节与不装皮肤时一致。
> 想改成像文档那样按需安装，需要自己实现那半（并决定线上服务器允不允许由玩家触发外网下载）。
>
> 移植时另外补的三处（都不在原文档里）：
> - **URL 要按多种布局依次探**：原文按 `<stem>/Front|Back` 拼 URL。2026-10-06 对表里前 121 款逐个 HEAD 了
>   `Spine/` 与 `Front/` 两种布局：**119 款只有 `Front|Back`**（`Spine/` 404），1 款两种都有
>   （`char_373_lionhd@snow#1`），1 款只有 `Spine/`（`char_1012_skadi2@boc#4`）。也就是说以 `Front|Back` 为主、
>   `Spine/` 是少数派 —— 我先前那句「fexli 把布局改成 Spine/ 了，旧地址全 404」是拿一个样本当规律，错的。
>   另外 front 与 back 是**两份不同的骨骼**（`char_199_yak` 的两张 png sha 和字节都不同），不能省一份。
>   `fetch-skin-spines.mjs` 因此对每个文件依次试「jsDelivr → raw」×「Spine → Front/Back」，最后才用研究表里
>   自带的那条，命中即止。
> - **atlas 必须规范化**：fexli 的 atlas 没有 `size:` 页头，pixi-spine 会按 0 除；下完后统一走
>   `tools/assets/atlas.mjs` 的 `normalizeAtlas()`（本仓为同一件事早就写好了），否则
>   `test/assets.test.js` 的「每份 atlas 都要有 size:」直接红。
> - **代理机器上 Node 下不动**：本机 `HTTPS_PROXY=127.0.0.1:7897` 时 `curl` 全 200 而 Node `fetch` 全
>   `ECONNRESET`（Node 的 fetch 默认不理代理变量），看起来像源站失效。要 `NODE_USE_ENV_PROXY=1 node tools/fetch-skin-…`；
>   两个下载工具现在会在失败时打出这句提示（`tools/skin-selection.mjs` 的 `proxyHint()`）。
>
> 顺序问题是**实测过的**（2026-10-06，`node tools/fetch-assets.mjs --offline`）：重建清单时 `fetch-assets.mjs`
> 里没有任何 `skins` 逻辑，它把 12 款皮肤的 84 条引用全列成「会丢的条目」，然后 **shrink 闸门拒绝写盘**
> （输出 `data/assets.json (kept)`）。所以默认情况下皮肤不会被 `npm run assets` 吃掉，但 **`--allow-shrink` 会**
> —— 加这个参数重跑之后必须再执行一次 `node tools/inject-skins-assets.mjs`（幂等，输出只由
> `data/skins-installed.json` 决定）。

## 本仓预装的 starter 皮肤（12 款，12.3 MB）

`data/skins-installed.json` 现在是 12 条，全部落在**商店里买得到的 6★/5★ 干员**上（按 `data/chess.json` 的
`visible && !isHidden` 筛过：174 款里 162 款在可购干员上，涉及 107 个干员）：

能天使 野地秘行 · 斯卡蒂 驭浪 WR04 · 空弦 宣传策略 · 风笛 皇后一号 · 莫斯提马 除魅 · 水月 永恒玩家 ·
歌蕾蒂娅 返航 · 琳琅诗怀雅 律动方格 · 伺夜 叙拉古的彼面 · 瑕光 异月灾裔 · 忍冬 失焦 · 信仰搅拌机 天穹肇始

装它们用的命令就三条（`data/skins-installed.json` 是唯一输入）：

```
NODE_USE_ENV_PROXY=1 node tools/fetch-skin-spines.mjs    # 72 个文件：每款 front/back 各 skel+atlas+png
NODE_USE_ENV_PROXY=1 node tools/fetch-skin-avatars.mjs   # 12 个 180×180 头像 → public/assets/char/skin_avatar/<stem>.png
node tools/inject-skins-assets.mjs                       # 写进 data/assets.json 的 chars[].skins
```

2026-10-06 实测的落地状态：84 个文件全部下到、24 份 atlas 全部规范化（都带 `size:` 页）、24 个朝向的 atlas
引用的 png 都在盘上、12 份 `.skel` 的版本串都是 **3.8.99**（与原皮一致）；`room.skins` 带着 12 条下标发给
本地服务器被接受、无 error，能建能开局；从 HTTP 侧取这 84 个 URL 全部 200，合计 12.3 MB。

**渲染这一件也验了，用的是真 Chrome + 页面自带的 pixi-spine**（`/dev/render-demo.html` 提供全局
`PIXI`/`PIXI.spine`，然后走生产同一条 `assets.js` 的 `loadSpineData(entry)`）：24 个朝向**全部加载成功**
（bone 数 36–145、动画 4–18 条），并且每款的动画名集合与**它自己原皮逐一对齐 —— 丢失 0、多出 0、清单
`anims` 引用而皮肤里没有的 0**；再把「原皮 vs 皮肤」同框渲染成图，12 张都能画出且明显是两套美术。
⚠️ 中间踩过一个假红：我第一版探针写死了 `Idle/Start/Attack/Skill_2` 四个名字去查，报「16 个朝向缺
Skill_2」—— 而能天使的**原皮**本来也没有 `Skill_2`（她的集合是 `Attack,Default,Die,Idle,Start`）。
按固定名单查动画名等于查自己的假设，必须拿同一干员的原皮做对照，只报「相对原皮少了什么」。

An operator's Spine model and avatar can be replaced by one of its official alternative outfits (时装). Written to
be **portable**: nearly everything lives in new files, and the handful of edits to existing ones are listed below
line by line so they can be re-applied after merging an upstream release.

> Line numbers are as of the commit that added this document and will drift. The anchor (the enclosing function or
> section) is the durable part.

## How it works

```
docs/research/08-skins.json        what EXISTS upstream (174 skins / 115 operators) — a static list, like the other
        │                          research tables; never fetched at build time
        ├── tools/build-skins.mjs ──→ data/skins.json          the catalogue the CLIENT reads: id, name, series.
        │                                                      No URLs — an uninstalled skin has no files to point at.
        │
        └── tools/install-skins.mjs  downloads ONE skin on demand (7 files) and splices it into
                 │                   data/assets.json + data/skins-installed.json
                 │
                 └── server/skinInstall.js   the in-game 「安装」 button, queued (the same work, imported)
                                              │
                     data/assets.json ────────┴──→ chars[charId].skins[skinId] = { spine:{front,back?}, avatar, name, group }

player picks a skin ──→ room.skins ──→ PlayerState.skins ──→ Match.publicView().players[].skins   (PUBLIC: teammates see it)
                                              │
                                              └── battleInput() u.skin ──→ snapshot ──→ renderer ──→ spineEntry(m, id, {skin})
```

Three properties are load-bearing:

- **Skins are installed on demand, never wholesale.** All 174 are ~190 MB, and the upstream link measured ~35 KB/s
  from a mainland China line — a full set would be over an hour. `data/skins-installed.json` starts empty and only
  `tools/install-skins.mjs` adds to it, so a fresh clone downloads no skins at all.
- **The skin *choice* is keyed by chess id; the skin *catalogue* and the asset manifest are keyed by operator id.**
  A chess record is `chess_char_1_01_a` and carries `charId: char_498_inside`. Mixing the two is silent: the picker
  renders an empty section and `setSkins` drops every entry.
- **A skin model must go through the build-time spine pipeline.** `resolveRoles()` runs offline in
  `tools/assets/spine.mjs`, and the client's `validSpine()` requires the `anims` it produces. A model that skipped
  that step fails to load and leaves the unit on its placeholder avatar forever — invisible until someone looks at
  the board. `installSkins()` therefore builds its models through the same `fexliModelDef()` the full plan uses.

## New files

| Path | What |
|---|---|
| `docs/research/08-skins.json` | Static research table: `{ meta, skins: { [charId]: [{ skinId, stem, name, group, avatar, battleSpine }] } }` |
| `tools/build-skins.mjs` | `docs/research/08-skins.json` → `data/skins.json` |
| `tools/install-skins.mjs` | Install/uninstall skins on demand; `list` / `add` / `remove` / `add-char`. Also the library `server/skinInstall.js` imports |
| `server/skinInstall.js` | Serialised background install queue: why it is queued, why it is never awaited (8 s client timeout) |
| `data/skins.json` | The client's catalogue (no URLs) |
| `data/skins-installed.json` | Which skin ids are installed — the single source of truth the build reads |
| `public/js/ui/skins.js` | Client store + `room.skins` sync + install requests + manifest reload on `skins.changed` |
| `public/js/ui/skinPicker.js` | The 皮肤 section of 干员调配 (self-contained: `screens/loadout.js` only names it) |
| `test/skins.test.js`, `test/skins-protocol.test.js`, `test/ui/skins.e2e.test.js` | Lookup, wire format, real-browser picker |

## Edits to existing files

| File | Where | What |
|---|---|---|
| `shared/protocol.js` | before `isLoadoutEntries` | `SKIN_LIMITS`, `isSkinId`, `isSkinSelection`. **`isSkinId` cannot be `isId`**: that allows only `[A-Za-z0-9_\-.:]` and skin ids carry `@` and `#` |
| `shared/protocol.js` | `C2S` table | `'room.skins'` and `'room.skin.install'` |
| `server/net.js` | `HEAVY_TYPES` | `'room.skins'`, `'room.skin.install'` |
| `server/net.js` | `Session` ctor | `this.skins = null` |
| `server/lobby.js` | import | `installSkinInBackground` |
| `server/lobby.js` | after `freezeLoadout` | `freezeSkins()` — the same gate as `checkLoadout` (`isGolden` / `visible === false` / `isHidden` / `isDiy` / `baseId !== id`) |
| `server/lobby.js` | `onMessage` | `case 'room.skins'` / `case 'room.skin.install'` |
| `server/lobby.js` | after `loadout()` | `skins()` — no phase gate (unlike the loadout: a skin is cosmetic and public) — and `skinInstall()`, which acknowledges at once and broadcasts `skins.changed` to **every** session on completion |
| `server/lobby.js` | `humanSeat()` & `startMatch()` | passes `skins` from session to seat and from room seats to `new Match()` |
| `server/match/Match.js` | after `setLoadout` | `setSkins()` — any phase, `markPublic()` |
| `server/match/Match.js` | `publicView().players[]` | `...(Object.keys(ps.skins).length ? { skins: ps.skins } : {})` — omitted when empty, so the payload is unchanged for players with no skins |
| `server/match/Match.js` | prep view units | `skin: ps.skins?.[rec?.baseId || piece.id] || ps.skins?.[piece.id]` — supports both base and golden/promoted pieces |
| `server/match/PlayerState.js` | ctor | `this.skins = Object.freeze({})` + restore from `seat.skins` |
| `server/match/PlayerState.js` | after `setLoadout` | `setSkins()` — bots refused, same gate as above, calls `this.dirty()` |
| `server/match/PlayerState.js` | `battleInput()` | `const baseId = (rec && rec.baseId) || piece.id; const skin = this.skins[baseId] || this.skins[piece.id]; if (skin) u.skin = skin;` — preserves skin when upgraded to golden |
| `server/match/PlayerState.js` | `pieceView()` | includes `skin` on prep board/hand/temp piece views |
| `server/sim/snapshot.js` | `unitInfo()` | `skin: u.skin ?? undefined` — **`undefined`, not `null`**: `JSON.stringify` drops it, so the `DESIGN §8.2` wire-format contract test still passes and an install with no skins is byte-identical to before |
| `public/js/assets.js` | `spineEntry()` | `opts.skin` → `chars[id].skins[id].spine`, else the operator's own model |
| `public/js/assets.js` | `avatarUrl()` & `hasBackSpine()` | supports `opts.skin` for avatar; `hasBack(id, skinId)` forwards skin |
| `public/js/render/units.js` | `_loadSpine()` & `_loadPicture()` | passes `skin: this.info.skin` to spine and avatar diamond fallback |
| `public/js/render/units.js` | `_wantsBack()` | asks `hasBack(id, this.info.skin)` |
| `public/js/render/app.js` | `pieceInfo()` and `addInfo()` | `skin: piece.skin ?? skinFor(baseId) ?? null` / `skin: u.skin ?? null`; `sig` includes `skin` to drop cache on switch |
| `public/js/data.js` | `DATA_FILES` | `skins: 'skins.json'` |
| `public/js/ui/gameComponents.js` | `GAME_FILES` | `'skins'` — `test/ui/playtest3.test.js` requires every file the in-match UI reads to be awaited by the match screen, and 干员调配 is reachable during a match |
| `public/js/screens/loadout.js` | imports + `Detail()` | import `SkinSection`, then `<${SkinSection} chess=${chess} />`. **Two lines** — the section itself is entirely in `ui/skinPicker.js` |
| `public/js/main.js` | imports + boot | `installSkinsSync({ net })` |
| `public/css/screens/loadout.css` | end | `.lo-skins` / `.lo-skin` tiles (mirrors `.lo-mods`) |
| `data/assets.json` | — | regenerated; carries `chars[charId].skins` for whatever is installed |

## Regenerating the asset side

```
node tools/build-skins.mjs                                   # docs/research/08-skins.json → data/skins.json
node tools/install-skins.mjs list [text]                     # what exists / what is installed
node tools/install-skins.mjs add <skinId…>                   # install (resumable; safe to interrupt)
node tools/install-skins.mjs add-char <charId…>              # every skin of those operators
node tools/install-skins.mjs remove <skinId…>                # uninstall (files stay on disk)
npm run assets                                               # rebuilds the manifest from the selection file
```

`tools/fetch-assets.mjs` only builds the skins listed in `data/skins-installed.json`, so a full run never
re-downloads one that was uninstalled **and** removes it from the manifest — matching what the installer writes.

Upstream sources: `fexli/ArknightsResource` (`spine/{charId}/{stem}/{Front,Back}/`) for the models,
`yuanyan3060/ArknightsGameResource` (`avatar/{avatarId}.png`) for the 180×180 thumbnails, and Kengxxiao's
`skin_table.json` for the names and series. Two naming rules, both verified:

```
stem   = skinId.replace(/@/g, '_').replace(/#/g, '_')      char_002_amiya@winter#1 → char_002_amiya_winter_1
avatar = 'avatar/' + encodeURIComponent(avatarId) + '.png'  avatarId comes from skin_table, NOT from the skinId
```

The full skin art (`skin/{portraitId}b.png`) is deliberately **not** used: at ~2.5 MB each it would add ~435 MB,
more than the entire rest of the asset set, for a thumbnail.

## Known limitations

- **No skin effects.** The official per-character battle effects are `.ab` particle bundles that the project does
  not extract (`docs/ASSETS.md`); battle FX stay procedural.
- **No operator voices.** A separate piece of work; the files exist (`ArknightsAssets2`, `voice` branch) but there
  is no event→line mapping or playback path yet.
- **Bots always wear the default model** (`setSkins` refuses bots, as `setLoadout` does).
- **Uninstalling leaves the files on disk.** They are shared between skins and a reinstall would only fetch them
  again; `npm run assets --prune` clears the orphans.
- **Docker images cannot install.** The runtime stage of the `Dockerfile` copies `server/`, `shared/`, `data/`,
  `public/` and `docs/research/` but not `tools/`, which `server/skinInstall.js` imports on demand. Add `tools/` to
  that stage if the in-game button should work there.
- **An install is tens of seconds, not instant.** The seven files come from GitHub at the link's speed; the panel
  acknowledges immediately and reports back through `skins.changed`.
