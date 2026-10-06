# 配音语言 (Operator voice language)

> 本仓的实况，2026-10-07。上游只有**构建期**的单语言开关（`--voice-lang=cn|jp|en|kr`），跑一遍会把清单里的
> `/voice/cn/…` 整条换成另一种语言，于是中文就没了。本仓做的是**运行期切换**：清单保持中文那一份不动，
> 其它语言靠「同名不同目录」推导，玩家在设置里选，选中的语言立刻作用于之后每一句台词。
> Paper-Yuan 的 `0.1.6-pre-skin` 走的是另一条路（`audio.js` 里 `this.voiceLang='jp'`、清单写成
> `audio.voice={jp:{…},cn:{…}}` 两棵树），本仓没有照抄那份结构。

## 为什么能靠文件名推导（实测）

官方语音仓库按语言分目录，**文件名不体现语言**：同一个 `char_1012_skadi2/cn_019.mp3` 在
`voice_cn/`、`voice/`（日）、`voice_en/`、`voice_kr/` 四个目录里都存在（2026-10-06 抽 11 个不同干员 × 4 个目录
逐个 HEAD，全部 200）。目录名与上游 `tools/assets/audio.mjs` 的 `VOICE_DIRS` 一致：

| 语言 | 包内目录 | 官方源目录 | 本仓现状 |
| --- | --- | --- | --- |
| 中文 `cn` | `public/assets/audio/voice/cn/` | `voice_cn` | 有，`npm run assets` 下的那份，**清单指向这里** |
| 日语 `jp` | `public/assets/audio/voice/jp/` | `voice` | 有，1680 条 / 51.8 MB（2026-10-07 拉） |
| 英语 `en` | `…/voice/en/` | `voice_en` | **没下**，字节数未测 |
| 韩语 `kr` | `…/voice/kr/` | `voice_kr` | **没下**，字节数未测 |

清单里 120 个干员、每人 14 条台词、12 个槽位名 ⇒ 每种语言 1680 个文件。cn 与 jp **逐文件比对 0 缺 0 多**
（`test/ui/voice-lang.test.js` 里那条「每条中文语音都有日语同名兄弟文件」把它钉在 CI 上，见下文「闸门」）。

## 管线

```
data/assets.json  audio.voice[charId][slot] = "/assets/audio/voice/cn/…"   ← 上游那份，只写中文，本功能不改它
        │
        │  tools/fetch-voice-alt-langs.mjs <jp|en|kr>   （从 ArknightsAssets2 的 voice 分支按同名推导）
        ▼
public/assets/audio/voice/<lang>/…            （.gitignore 里的官方素材，只能靠 payload 分发）
        │
        │  tools/voice-langs.mjs --write       （数**盘上真实文件**，不数代码里写了几个选项）
        ▼
data/voice-langs.json                          （登记：这个安装内容到底内置了哪几种配音）
        │
        ▼
public/js/ext/voiceLang.js                     运行期改写路径；public/js/ext/voiceLangUi.js = 设置页那一行
```

```bash
NODE_USE_ENV_PROXY=1 node tools/fetch-voice-alt-langs.mjs jp   # 拉素材（幂等：已存在且 >500B 的跳过）
node tools/voice-langs.mjs --write                            # 重新登记；打包前必跑
node tools/voice-langs.mjs                                    # 只看报告
```

`data/voice-langs.json` **故意进 .gitignore**（与 `data/local-assets.json` 同性质）：它描述的是「这台安装内容里有
什么」。如果它被单独部署到一台没有日语文件的服务器上，客户端就会把台词改写到 `/voice/jp/…` 然后 404 —— 那是
**静音**，比「根本没有这个开关」糟得多。部署时 `data/voice-langs.json` 与 `public/assets/audio/voice/<lang>/`
要么一起搬，要么都不搬。

## 运行期行为（`public/js/ext/voiceLang.js`）

| 情况 | 结果 |
| --- | --- |
| 没有 `data/voice-langs.json`（老包 / 服务器上没这份登记） | 一律放清单原路径（中文），设置页**不出现**这一行 |
| 登记里只有一种语言 | 同上，`availableLangs().length < 2` ⇒ 那一行不出现 |
| 玩家选了登记里有的语言 | 台词路径的语言段被改写，之后每一句都走新目录 |
| 玩家偏好是别的包留下的（如 `kr`），本包登记里没有 | 退回登记的 `default`，路径不改写，`setVoiceLang()` 直接返回 `false` |
| 路径不是 `/assets/audio/voice/<两位语言>/…` 的形状 | 原样返回，绝不猜 |

一句话：**最坏情况是继续放中文，不会没声音**。这就是「时装页摆出来却一款都没有」那个坑的反面写法。

`voice()` 是唯一读 `audio.voice` 清单的地方，所以挂载只有两处、各两行：

| 上游文件 | 挂载 |
| --- | --- |
| `public/js/audio.js` | `import { voiceLangUrl } from './ext/voiceLang.js';` + `const url = voiceLangUrl(…)` 包住原来那条随机取台词 |
| `public/js/ui/settings.js` | `import { VoiceLangRow } …` + 音量滑杆下面一行 `<${VoiceLangRow} />` |

`ext/voiceLang.js` 在 import 时就 `data.load('voice-langs')`（`data.js` 缓存这条请求，重复调用不重发），所以
玩家上次选的语言在**第一句台词之前**就已生效，不用等设置弹窗第一次渲染。

## 闸门

- `test/ui/voice-lang.test.js`（Node，11 条）：无登记退回中文／改写生效／未登记语言被拒／单语言时开关消失／
  非语音路径不碰／**`AudioManager.voice()` 真的请求 `/voice/jp/…` 且不再请求 `/voice/cn/…`**／挂载点还在／
  登记与盘上一致／每条中文语音都有日语兄弟文件。
  后两条问盘上文件，而 `public/assets/` 是 gitignore 的官方素材（CI 永远没有），所以它们**只在打包机上生效**，
  在 CI 里显式 `skip` 并写明怎么补跑。
- 变异验过（2026-10-07）：拆掉 `audio.js` 的改写、把登记表里的条数改谎、藏掉一个日语文件、摘掉设置页那一行
  —— 四种情况都让对应断言变红，不是空跑。
- `tools/ext-surface.mjs` / `docs/EXT-SURFACE.json`：这两处挂载逐行反查，上游合并冲掉时会指名道姓地红。

## 还没决定的事

- **en / kr 要不要进包**：一条命令的距离（`node tools/fetch-voice-alt-langs.mjs en`，登记会自动多出 `en`，
  开关随之出现）。代价是包体：日语已经让 payload 大了 51.8 MB（未压缩），英语/韩语没下过、字节数未测。
  群里玩家要的是日语，先只做 jp。
- **网页版**：给服务器加日语目录＝ 52 MB 磁盘 + 玩家按需下载（一句台词几十 KB，`_buffer` 按需取，不会整包拉）。
  动线上素材要单独拍板，见 `docs/DEPLOY.md`。
