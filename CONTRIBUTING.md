# 贡献指南（本 fork 专属）

> 本文档是 **`lilyco-42/Stronghold-Protocol` 这个 fork** 的开发与贡献约定，
> 补充上游 README 的「[开发与测试](https://github.com/sganggs/Stronghold-Protocol#开发与测试)」
> 与「[贡献](https://github.com/sganggs/Stronghold-Protocol#贡献)」两节。
> **上游通用的构建、测试、许可证等以 README 为准；这里只写我们 fork 自己的规矩。**

## 这个 fork 是什么

- 上游是 [`sganggs/Stronghold-Protocol`](https://github.com/sganggs/Stronghold-Protocol)
  （《卫戍协议：盟约》，明日方舟自走棋同人联机游戏）。
- 我们的生产跑在 `sp.lain42.top`。**自研功能全部隔离在 feature 分支**，master 只用来跟上游同步。
- 与上游的关系：**只取不放**。我们从上游同步，但**不以本 fork 的账号向上游提交 PR**——
  上游的 PR 由仓库 owner 本人决定是否、如何提交。

## 分支模型（最重要）

- **`master` 必须与上游 `master` 保持 0 差异**（trees 级别一一对应）。
  这是能随时 `git merge upstream/master` 跟上的前提，**不要往 `master` 上堆自研改动**。
- 自研放 feature 分支。当前分支：
  - `feat/skins` —— 干员皮肤 + 自托管 Noto Sans SC（摆脱 Google Fonts）。
  - `feat/server-announcement` —— 服务器公告系统。
  - `feat/room-chat` —— 房间聊天。
  - `feat/quick-match` —— 快速匹配队列（Issue #3）。
  - `feat/net-cross-version-capability` —— 跨版本联机。
- **改到上游文件要记账**：上游更新前先确认「我们改过哪些上游文件」，评估冲突面，
  记进 `docs/TODO.md` 的同步纪要。
- 同步上游：从 `upstream/master` `rebase` 各 feature 分支；用 GitHub compare API 核验
  `ahead/behind/files` 再动手（浅克隆下本地 `git log A..B` 不可信）。叠放分支用
  `git rebase --onto <新父> <旧父尖端> <子>`。

## 部署补丁系统（生产专用，不进 git）

生产服务器不直接跑上游代码，部署时用一个脚本重放三个定制补丁
（`cdn-stage/patches-014/apply-patches.py`，带锚点断言、幂等）：

1. `server/index.js` 的 `perMessageDeflate` —— 3 Mbps 出口的命脉（关掉省带宽）。
2. `shared/protocol.js` 的 `hello.z` —— 自定义握手字段。
3. `public/js/assets.js` 的 `validSpine()` —— 接受 CDN 绝对 URL 的素材。

这些补丁**不提交到仓库**，只在部署流水线里重放。改上游对应位置时，先确认锚点是否还成立。

## 运行与部署（我们的环境）

| 用途 | 路径 | 端口 |
|---|---|---|
| 生产 | `/opt/Stronghold-Protocol` | 5150 |
| 开发测试 | `/opt/sp-dev-test` | 5152 |

- 反代是 pingap（`stronghold_backend`=5150，`lobby_backend`=5000）。
- 素材走 `cdn.lilyco42.top`（Cloudflare R2 自定义域名，已切生产、覆盖率 100%）。
- 字体自托管在 `public/webfonts/google/`，不依赖 Google Fonts。
- 本地从源码跑：`npm install && npm run setup && npm start`（详见上游 README「快速开始 / 从源码运行」）。

## 推送与提交权限（硬规矩）

- **只允许推送到 `lilyco-42/*` 名下的仓库。**
- 上游 `sganggs/*`、任何第三方仓库、别人的 fork：**不推、不开 PR、不在其 issue/PR 下发评论。**
  这些动作由仓库 owner 本人执行。
- 本地提交、本地分支、推自己的 fork 不受限。
- 机械兜底（本仓库）：`upstream` 的 push 地址已禁用，且 `.git/hooks/pre-push`
  会拦下所有非 `lilyco-42` 的推送目标。

## 测试

沿用上游的 `node --test` 体系（详见 README「开发与测试」）：

```bash
npm run dev                                      # 改动服务器代码后自动重启
node --test                                      # 单元 + 集成（缺素材/浏览器的用例自动跳过）
SP_REAL_E2E=1 node --test test/ui/real.e2e.test.js   # 需 Chrome + 已下载素材
GOLDEN_FULL=1 node --test test/golden.test.js    # 黄金结果（改玩法时随改动提交）
```

⚠️ 在受限机器（低配 VPS、无本地提取素材）上跑全量，可能出现**与改动无关**的环境性失败，
提交/提交流前请先单独跑相关文件定位，并如实说明：

- `test/local-extract.test.js` 的部分用例——只在 `data/local-assets.json` 存在时跑；
  没有本地提取素材时 CI 会跳过。
- `test/sim/robustness.test.js` 的性能断言——并行跑全量时会抖，单独跑该文件稳定通过。

## 文档与语言

与上游一致：

- 文档用**简体中文**，代码与注释用**英文**。
- 提交的代码以 **GPL-3.0-or-later** 发布（见 `LICENSE`）。
- **不要提交任何游戏素材文件**（`public/assets/` 等已被 `.gitignore` 排除）。
- 本项目**非商业**：不要提交广告、付费、打赏等任何形式的变现功能。

## 给 owner 的提示

- 本仓库的 `master` 刻意与上游保持 0 差异。本文档（及其所在分支）属于 fork 自有内容，
  若想让它出现在默认分支，等于 `master` 会比上游多这一个文件——是否接受由你决定。
- 向上游回馈时：把改动做成干净的单提交补丁、用 compare API 核验、按上游行文风格拟好
  PR 正文与验证数据，**交给你本人提交**。
