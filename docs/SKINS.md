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
> `data/assets.json`；`data/skins-installed.json` 在本仓默认是空数组，也就是**一个皮肤都不下载**。
> 想改成像文档那样按需安装，需要自己实现那半（并决定线上服务器允不允许由玩家触发外网下载）。
>
> 移植时另外补的三处（都不在原文档里）：
> - **fexli 的目录布局变了**：皮肤骨骼现在在 `spine/<charId>/<stem>/Spine/`（一份，前后朝向共用），原文按
>   `<stem>/Front|Back` 拼 URL，实测六个地址全 404。`fetch-skin-spines.mjs` 现在对每个文件依次试
>   「新布局 → 旧布局」×「jsDelivr → raw」，最后才用研究表里自带的那条。
> - **atlas 必须规范化**：fexli 的 atlas 没有 `size:` 页头，pixi-spine 会按 0 除；下完后统一走
>   `tools/assets/atlas.mjs` 的 `normalizeAtlas()`（本仓为同一件事早就写好了），否则
>   `test/assets.test.js` 的「每份 atlas 都要有 size:」直接红。
> - **代理机器上 Node 下不动**：本机 `HTTPS_PROXY=127.0.0.1:7897` 时 `curl` 全 200 而 Node `fetch` 全
>   `ECONNRESET`（Node 的 fetch 默认不理代理变量），看起来像源站失效。要 `NODE_USE_ENV_PROXY=1 node tools/fetch-skin-…`；
>   两个下载工具现在会在失败时打出这句提示（`tools/skin-selection.mjs` 的 `proxyHint()`）。
>
> 一个**未验证**的顺序问题，别当成已知：`npm run assets` 成功重写 `data/assets.json` 时会不会保留 `chars[].skins`
> 没测出来（那次被 shrink 闸门挡下、根本没写盘）。保险做法是 `npm run assets` 之后重跑一次
> `node tools/inject-skins-assets.mjs`（幂等，输出只由 `data/skins-installed.json` 决定）。

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
