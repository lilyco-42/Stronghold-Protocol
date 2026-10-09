# TODO · 对标社区服 `play.simpfun.cn:14517`

> 调查日期：2026-10-07
> 对标对象：`http://play.simpfun.cn:14517/`（托管在简幻欢平台，端口 14517）
> 上游基线：`sganggs/Stronghold-Protocol` 的 `master` 分支

## 关于对标对象

那台服务器跑的是**私有定制版**：以上游 `master` 为基底，另写了 7 个模块。
代码**没有公开**（上游 3 个分支、178 个公开 fork、1 个 PR 全都查过，0 个含这些文件；
站点也不暴露仓库地址）。所以本文只对标**功能需求**，不涉及、也不可能涉及他们的代码。

**他们相对上游 `master` 新增的文件**（实测路径与体积）：

| 模块 | 文件 | 体积 |
|---|---|---|
| 自选外援 | `shared/supports.js` · `js/ui/supportPicker.js` · `css/support-picker.css` | 919 B · 8384 B |
| 房间聊天 | `js/ui/roomChat.js` · `js/ui/chatState.js` · `css/room-chat.css` | 10602 B · 2467 B |
| 匹配队列 | `js/screens/matchmaking.js` · `css/screens/matchmaking.css` | 4818 B |
| 服务器公告 | `shared/announcement.js` · `js/ui/serverAnnouncement.js` · `css/server-announcement.css` | 1735 B · 1843 B |
| 更新公告 | `js/ui/releaseNotes.js` · `css/release-notes.css` | 4416 B |

旁证：他们的 `js/main.js` 是 18964 B，上游 `master` 是 17562 B —— 多出的 1.4 KB 就是把上述模块挂进主流程的集成代码。

---

## 一、差距总览

| # | 功能 | 他们 | 我们 | 优先级 | Issue |
|---|---|---|---|---|---|
| 1 | 自选外援（六星支援干员） | ✅ 16 位，可选技能 | ❌ | **P0** | [#1](../../issues/1) |
| 2 | 房间内文字聊天 | ✅ 已上线 | ❌ | **P0** | [#2](../../issues/2) |
| 3 | 匹配队列（含难度） | ✅ 独立屏幕 | ❌ | **P1** | [#3](../../issues/3) |
| 4 | 服务器跑马灯公告 | ✅ 终端命令发布 | ❌ | **P1** | [#4](../../issues/4) |
| 5 | 更新公告弹窗 | ✅ 动态生成 | ❌ | **P2** | [#5](../../issues/5) |
| 6 | 素材 CDN 直出 | ✅ | ✅ 已有（`cdn.lilyco42.top`） | — | — |
| 7 | 干员皮肤 | ❌ | ✅ 已有（`feat/skins`） | — | — |
| 8 | 字体自托管 | ❌（用 Google Fonts） | ✅ 已有（`public/webfonts/`） | — | — |

> 每条 TODO 都已开成 Issue 跟踪（见上表 Issue 列）。
> **建议的实现顺序：`#4 公告` → `#2 聊天` → `#3 匹配` → `#1 外援` → `#5 更新公告`** ——
> 公告最小最独立、不碰上游核心文件；外援最大、改上游文件最多；更新公告依赖外援和皮肤提供动态内容。

**结论**：功能上我们 2 项领先、5 项落后。落后的这 5 项里有 2 项是"社区服刚需"
（外援、聊天），优先级最高。

---

## 二、TODO

### P0-1 · 自选外援系统 · [#1](https://github.com/lilyco-42/Stronghold-Protocol/issues/1)

**他们的设计**（从 `shared/supports.js` + `js/ui/supportPicker.js` 观察所得）：

- **核心思路是 id 重映射，不是新写一套棋子**：外援在数据层被映射成普通棋子的 id ——
  `chess_support_${tier}_${charId}_${golden ? 'b' : 'a'}`。
  这样商店购买、合成精锐、盟约计数、战斗模拟**全部复用现有棋子系统**，`shared/supports.js` 只有 919 B。
- **4 个槽位，阶位固定**：`SUPPORT_TIERS = [5, 5, 6, 6]` —— 前两位五阶解锁、后两位六阶解锁。
- **校验规则**：`picks` 长度必须是 4；元素允许 `null`（= 不携带）；不能重复；必须是 catalog 里
  `ready === true` 的干员。报错文案："请选择四个外援槽位" / "这个外援尚未开放" / "同一位干员只能选择一次"。
- **技能**：每位 3 个技能（一/二/三），开局前选；选择结果写进 loadout entries（复用 `setChoice`），
  所以外援的技能选择跟普通干员的装备是同一套存储。
- **数值档位**：普通 = 精二 1 级 / 技能 4 级；精锐 = 精二 60 级 / 技能 7 级；**暂不携带模组**。
- **盟约联动**：外援参与其对应盟约，房间成员列表显示所选外援；
  **同一角色的不同阶位和精锐版本不重复凑普通盟约人数**（这是个容易踩的坑）。
- **联机同步**：协议 `room.supports`。关键点是 **create / join / queue / start 之前必须先 flush** ——
  否则第 4 个排队成员会用过期的选择开局。服务端返回 `ROOM_STARTED` 时锁定并提示"已保存，下一局生效"。
- **本地持久化**：localStorage key `supports.v1`，刷新后保留上次选择。
- **自动施放**：原作的手动选点 / 切换 / 停止**不做**，改为按自走棋策略自动施放，
  每项技能用 `adaptationNote` 逐条说明网页版的差异（例：予愿安洁莉娜三技能不能自动移动部署到飞行敌人格）。
- **更新公告联动**：`releaseNotes.js` 从 `data.load('supports')` 动态拉取，生成"外援 → 所属盟约"对照表，
  所以加新外援不用改公告代码。

**我们的实现清单**：

- [ ] 数据层：`data/supports.json` 定义 16 位六星外援的 `charId` / `name` / `bonds[]` / `ready`
- [ ] `shared/supports.js`：`SUPPORT_TIERS`、`supportChessId()`、`checkSupports()`、`supportIds()`
- [ ] 棋子数据：为每位外援生成 `chess_support_5_*` / `chess_support_6_*`（含精锐 `_b` 版本）
- [ ] 模拟层：外援棋子能进商店池、能合成精锐、能计入盟约（注意去重规则）
- [ ] 前端：`js/ui/supportPicker.js` + `css/support-picker.css`，4 个槽位下拉 + 技能选择 + 技能描述
- [ ] 协议：`room.supports` 请求 + 服务端校验（**服务端必须复校，不能只信客户端**）
- [ ] 时序：在 create / join / queue / start 前 flush，处理 `ROOM_STARTED` 锁定分支
- [ ] 持久化：`supports.v1` pref
- [ ] 技能自动施放适配 + 逐技能的 `adaptationNote`
- [ ] 盟约联动：成员列表显示外援；确认不同阶位/精锐不重复计数

**风险**：这是最大的一块。他们的 `supportPicker.js` 有 8.4 KB，加上服务端校验、棋子和模拟层改动，
估计是本项目最大的一次功能扩展。建议先做**只读的目录 + 选择 UI**，跑通 `room.supports` 同步，
再逐步接进商店和战斗。

---

### P0-2 · 房间内文字聊天 · [#2](https://github.com/lilyco-42/Stronghold-Protocol/issues/2)

**他们的设计**：`room.chat` 协议；前端 10.6 KB（`roomChat.js`）+ 2.5 KB（`chatState.js`），独立 CSS。
上线时还带着 `?v=20261005-chat-preview2` 的预览版本号，说明是迭代中的功能。

**我们的实现清单**：

- [ ] 协议：`room.chat` 上行（发送）+ 下行（广播），服务端限流 + 长度上限
- [ ] `js/ui/roomChat.js`：消息列表 + 输入框，接进 `screens/room.js` 和 `screens/lobby.js`
- [ ] `js/ui/chatState.js`：未读计数、滚动位置、输入状态
- [ ] 安全：纯文本渲染（不走 HTML）、去除控制字符与 bidi 覆盖字符（U+202A–U+202E、U+2066–U+2069）
- [ ] 房间生命周期：换房清空、断线重连拉历史（或明确不保留历史）

**为什么排 P0**：社区服的核心是社交。没有聊天，玩家开黑只能靠外部 IM，留存会明显吃亏。

---

### P1-1 · 匹配队列 · [#3](https://github.com/lilyco-42/Stronghold-Protocol/issues/3)

**他们的设计**：独立屏幕 `js/screens/matchmaking.js`（4818 B）+ `css/screens/matchmaking.css`。
协议 `room.matchmake`，难度用 `lobby.difficulty`。
失败原因分三类，前端给不同提示：`matchmaking_cancelled` / `matchmaking_disconnected` / `matchmaking_failed`。

**我们的实现清单**：

- [ ] 服务端：匹配队列（按难度分桶），凑够人数开局
- [ ] 协议：`room.matchmake`（入队/退队）、`lobby.difficulty`（难度选择）
- [ ] 前端：`screens/matchmaking.js` + CSS，显示队列人数、等待时长、取消按钮
- [ ] 三类中断原因的处理与文案
- [ ] 边界：队列中掉线、开局瞬间取消、只有 1 人时的超时策略

---

### P1-2 · 服务器跑马灯公告 · [#4](https://github.com/lilyco-42/Stronghold-Protocol/issues/4)

**他们的设计**（`shared/announcement.js` + `js/ui/serverAnnouncement.js`）：

- **发布方式**：服务器终端命令 `/announce <文本>` 或 `公告 <文本>`，
  子命令 `help` / `clear` / `status`（正则 `^(?:\/?announce|公告)(?:\s+([\s\S]*))?$`，大小写不敏感）。
- **时序**：3 遍滚动，每遍 30 秒；遍与遍之间隔 5 分钟。
  总时长 = `3 × 30_000 + 2 × 300_000 = 690_000 ms`（11 分 30 秒）。
- **时钟对齐**：广播 `server.announcement` 时带 `{id, text, startedAt}` 和 `serverNow`，
  客户端算 `clockOffset = serverNow - Date.now()`，用它校正本地时钟 —— 否则各端滚动不同步。
- **中途加入**：新玩家 / 重连玩家只播**剩余遍数**，从头播会让老玩家看到重复内容。
- **文本上限**：服务端 300 字；客户端接收校验放宽到 1200 字符（防伪造大包）。
- **净化**：`parseAnnouncementCommand` 会剔除控制字符 `\u0000-\u001f` `\u007f-\u009f`
  和 bidi 覆盖字符 `\u202a-\u202e` `\u2066-\u2069`，替换为空格 —— 防止公告里塞 ANSI 序列或
  用 RTL 覆盖字符伪造内容。
- **渲染**：Preact 自动转义，公告条 `pointer-events: none` 穿透给下面的游戏。

**我们的实现清单**：

- [ ] `shared/announcement.js`：`ANNOUNCEMENT` 常量、`announcementLifetime()`、
      `announcementPhase(startedAt, now)`、`parseAnnouncementCommand(line)`
- [ ] 服务端：终端命令接入（现有控制台）+ 广播 `server.announcement`（带 `serverNow`）
- [ ] 前端：`js/ui/serverAnnouncement.js` + CSS，按 `phase` 驱动滚动与间隔
- [ ] 时钟对齐：`clockOffset` 校正
- [ ] 文本净化 + 长度上限（服务端 300、客户端 1200）
- [ ] 中途加入只播剩余遍数

**成本低收益高**：`shared/announcement.js` 只有 1.7 KB，纯函数、无外部依赖，是这批功能里最好抄的一块。

---

### P2 · 更新公告弹窗 · [#5](https://github.com/lilyco-42/Stronghold-Protocol/issues/5)

**他们的设计**：`js/ui/releaseNotes.js`（4416 B），每次打开页面弹一次（`installReleaseNotes()` 直接 `open`），
关闭后可通过大厅 / 等待室 / 匹配页的「更新公告」按钮重新打开。
内容里的"外援 → 所属盟约"表格是**从 `data.load('supports')` 动态生成**的，加新外援不用改文案。

**我们的实现清单**：

- [ ] `js/ui/releaseNotes.js`：Modal + 内容区，焦点陷阱 + Esc 关闭
- [ ] 触发：每次打开页面弹一次；提供常驻按钮可重开
- [ ] 内容来源：能动态生成的部分（如皮肤列表、外援列表）从数据层拉，避免写死后过期

---

## 三、我们已经领先的部分（保持）

- **素材 CDN 直出**：`cdn.lilyco42.top`（R2 自定义域名）已切生产，覆盖率验证 5700/5700 = 100%，
  他们还在用站点直出
- **干员皮肤系统**：`feat/skins` 分支（`docs/SKINS.md`、`data/skins.json`、`js/ui/skinPicker.js`），他们没有
- **字体自托管**：`public/webfonts/google/`（Noto Sans SC 自托管），
  他们还在 `preconnect` 到 `fonts.googleapis.com` —— 大陆玩家首屏会卡

---

## 四、维护成本警告

他们的做法是**脱离上游**：基底停在 `master`，自己往上加。
好处是功能全在自己手里、想多快就多快（两天做了聊天 + 外援 + 公告三块）；
代价是上游 `master` 之后的所有修复他们都要自己重放，长期维护成本高。

**我们的原则建议**：

1. **能回上游的就回上游** —— 外援、聊天、匹配这类通用功能，做成干净的 PR 提给 `sganggs`，
   让上游帮我们维护。他们那条路我们没必要重走。
2. **不能回上游的放 feature 分支** —— 像 `feat/skins` 这种带我们特色的，
   保持分支隔离，`master` 继续跟上游（目前我们 `master` 与上游 `master` 在 `public/js` 和
   `shared` 上是 0 差异，这个状态要保住）。
3. **改上游文件要记账** —— 外援和聊天都要改 `js/main.js`、`screens/room.js`、`screens/lobby.js`，
   每次上游更新都会冲突。建议在 `docs/` 下维护一份"我们改过哪些上游文件"的清单。

---

## 五、调查方法留档（可复现）

- 站点无目录列表，只能按已知路径逐个探测（`curl -o /dev/null -w '%{http_code}'`）
- 判定"某文件是自研而非上游"的方法：拿上游 `git/trees/<branch>?recursive=1` 的路径清单
  跟站点探测结果对照，**并且一定要加对照组**（探一个两边都该有的文件，确认探测路径有效）
- 上游三个分支 `master` / `dev` / `feedback3` 的完整路径清单已留存
- ⚠️ `gh search code` 有每分钟 10 次限流，超限返回 403 但**输出为空**，看起来跟"没搜到"一样，
  下"不存在"结论前必须先用已知存在的词跑对照
- ⚠️ `gh api ... -q '.size'` 在 404 时会把 JSON 错误体打到 stdout，`2>/dev/null` 挡不住，
  要用退出码判断
