// tools/fetch-skin-spines.mjs — 离线下载皮肤 Spine 战斗骨骼（front/back 各 skel, atlas, png）
//
// 关键设计：**选哪份骨骼由内容决定，不由目录顺序决定。**
// fexli 仓里同一款皮肤可能同时存在 `Spine/` 与 `Front|Back/` 两份，而 2026-10-07 实测发现
// `char_253_greyy_epoque_8` / `char_373_lionhd_snow_3` 的 `Spine/` 那份是**宿舍/交互模型**
// （Default/Interact/Move/Relax/Sit/Sleep/Special），`Front|Back` 才是战斗模型
// （Attack/Default/Die/Idle/Start[/Skill]）。原先按「Spine 优先」直接拼 URL，就把宿舍模型当战斗模型装了下来。
// 现在每个朝向先取候选的 skel+atlas、解析动作集、过 `isBattleSkeleton()`，合格才用；盘上已有的那份
// 也重新校验，不合格就换目录重下（自愈、幂等）。png 另外按 atlas 声明的页尺寸验，防止骨骼与贴图来自两份模型。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSkinIds, isInstalled, proxyHint, isBattleSkeleton } from './skin-selection.mjs';
import { normalizeAtlas, atlasInfo } from './assets/atlas.mjs';
import { pngSize } from './assets/formats.mjs';
import { parseSkel } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_PATH = path.join(ROOT, 'docs', 'research', '08-skins.json');
const TARGET_BASE = path.join(ROOT, 'public', 'assets', 'spine', 'op');
const HOSTS = ['https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@main',
  'https://raw.githubusercontent.com/fexli/ArknightsResource/main'];

const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
const installed = installedSkinIds();

/** 一个朝向的候选目录。顺序只是尝试顺序，不是判据 —— 判据是动作集。 */
const sideDirs = (side) => ['Spine', side === 'front' ? 'Front' : 'Back'];
const at = (host, charId, stem, dir, ext) => `${host}/spine/${charId}/${stem}/${dir}/${stem}.${ext}`;

async function get(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Stronghold-Spine-Sync/1.0' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 50 ? buf : null;
  } catch { return null; }
}

/** 这份 skel+atlas 是不是能上阵的战斗骨骼？ */
function battleRoles(skelBuf, atlasText) {
  const info = atlasInfo(atlasText);
  if (!info.pages.length) return null;
  const sk = parseSkel(skelBuf, info.regions);
  const roles = resolveRoles(sk.animations, { skillIndices: [0], durations: sk.durations });
  return isBattleSkeleton(sk.animations, roles) ? roles : null;
}

/** 盘上那份（也许是上次按错误顺序下的）现在还合格吗？ */
function localRoles(absSkel, absAtlas) {
  try {
    if (!fs.existsSync(absSkel) || !fs.existsSync(absAtlas)) return null;
    return battleRoles(fs.readFileSync(absSkel), fs.readFileSync(absAtlas, 'utf8'));
  } catch { return null; }
}

/** 换目录时把这款的旧文件清掉：留着会把宿舍模型的贴图拼到战斗骨骼上。 */
function cleanSideDir(dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  for (const stale of fs.readdirSync(dir)) if (stale.startsWith(stem)) fs.rmSync(path.join(dir, stale));
}

/**
 * 定下一个朝向该用哪个目录，并把 skel + atlas 落到本地（png 交给常规任务流）。
 * @returns {{dir: string|null, why?: string}} `dir === 'LOCAL'` = 盘上那份已经合格
 */
async function resolveSide(side) {
  const { charId, stem, sideName, dir } = side;
  const absSkel = path.join(dir, `${stem}.skel`);
  const absAtlas = path.join(dir, `${stem}.atlas`);
  if (localRoles(absSkel, absAtlas)) return { dir: 'LOCAL' };

  let firstUsable = null;
  for (const d of sideDirs(sideName)) {
    let skel = null; let atlas = null;
    for (const h of HOSTS) {
      skel = await get(at(h, charId, stem, d, 'skel'));
      if (!skel) continue;
      atlas = await get(at(h, charId, stem, d, 'atlas'));
      if (atlas) break;
    }
    if (!skel || !atlas) continue;
    firstUsable = firstUsable || { d, skel, atlas };
    if (battleRoles(skel, atlas.toString('utf8'))) {
      cleanSideDir(dir, stem);
      fs.writeFileSync(absSkel, skel);
      fs.writeFileSync(absAtlas, atlas);
      return { dir: d };
    }
  }
  if (firstUsable) {
    // 没有一份过得了战斗判据：仍收下第一份并报告，让注入器去判死 ——
    // 「源仓只给了宿舍模型」和「我们下错了目录」在两处报告里都要看得见。
    cleanSideDir(dir, stem);
    fs.writeFileSync(absSkel, firstUsable.skel);
    fs.writeFileSync(absAtlas, firstUsable.atlas);
    return { dir: firstUsable.d, why: '没有一份含战斗动作' };
  }
  return { dir: null, why: '所有候选地址都没有这份骨骼' };
}

// ---- 收集任务 ---------------------------------------------------------------------------------------------

const sides = [];
for (const [charId, skinList] of Object.entries(research.skins || {})) {
  for (const s of skinList) {
    if (!isInstalled(installed, s.skinId)) continue;
    const bs = s.battleSpine;
    if (!bs) continue;
    for (const sideName of ['front', 'back']) {
      if (!bs[sideName]) continue;
      sides.push({
        charId, stem: s.stem, sideName, rec: bs[sideName], skinId: s.skinId,
        dir: path.join(TARGET_BASE, charId, s.stem, sideName),
      });
    }
  }
}

const args = process.argv.slice(2);
const limitOp = args.find((a) => !a.startsWith('--'));
const activeSides = limitOp ? sides.filter((x) => x.charId === limitOp || x.stem.includes(limitOp)) : sides;
if (limitOp) console.log(`[skin-spines] 按干员/皮肤过滤: ${limitOp}, 剩余朝向: ${activeSides.length}`);

const chosen = new Map();
const notes = [];
const queue = [...activeSides];
async function resolveWorker() {
  while (queue.length) {
    const side = queue.pop();
    const r = await resolveSide(side);
    chosen.set(side.key, r.dir);
    if (r.why) notes.push(`${side.skinId} ${side.sideName}: ${r.why}（用了 ${r.dir ?? '无'}）`);
  }
}
sides.forEach((s) => { s.key = `${s.charId}|${s.stem}|${s.sideName}`; });
await Promise.all(Array.from({ length: 8 }, resolveWorker));

/** atlas 声明的页 → 期望尺寸（用来验 png 是不是来自同一份模型）。 */
function pageSizes(atlasAbs) {
  try {
    const text = fs.readFileSync(atlasAbs, 'utf8');
    const sizes = new Map();
    for (const p of atlasInfo(text).pages) sizes.set(p, true);
    return sizes;
  } catch { return null; }
}

// 骨骼来自选定目录时 png 也只认那个目录；'LOCAL'（盘上骨骼已合格）时按候选顺序试，但每张贴图都要
// 对得上本地 atlas 声明的页，否则宁可不下 —— 骨骼与贴图来自两份模型是最难查的一种坏包。
const tasks = [];
for (const side of activeSides) {
  const d = chosen.get(side.key);
  const dirs = d && d !== 'LOCAL' ? [d] : sideDirs(side.sideName);
  const pages = pageSizes(path.join(side.dir, `${side.stem}.atlas`));
  for (const ext of ['skel', 'atlas', 'png']) {
    const urls = [];
    for (const dirName of dirs) for (const h of HOSTS) urls.push(at(h, side.charId, side.stem, dirName, ext));
    if (side.rec[ext]?.url) urls.push(side.rec[ext].url);
    const t = { file: `${side.stem}.${ext}`, dir: side.dir, urls };
    if (ext === 'png' && pages) t.pages = pages;
    tasks.push(t);
  }
}
console.log(`[skin-spines] 待处理 Spine 文件总数: ${tasks.length}（${activeSides.length} 个朝向）`);

async function downloadOne(t) {
  fs.mkdirSync(t.dir, { recursive: true });
  const dest = path.join(t.dir, t.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100 && !t.pages) return 'skipped';
  for (const u of t.urls) {
    const buf = await get(u);
    if (!buf) continue;
    if (t.pages) {
      // 贴图必须能对上 atlas 里那些页的名字；尺寸本身由 normalizeAtlas 那一步统一校验
      const name = path.basename(u).split('/').pop();
      const want = decodeURIComponent(name);
      const page = [...t.pages.keys()].find((p) => p.toLowerCase() === want.toLowerCase()
        || want.toLowerCase().endsWith(`/${p.toLowerCase()}`) || p.toLowerCase() === want.toLowerCase().split('/').pop());
      if (!page) continue;
      if (!pngSize(buf)) continue;
    }
    fs.writeFileSync(dest, buf);
    return 'downloaded';
  }
  // 一张都没配上：留着上一次的错贴图比没有更糟，但删掉会让 atlas 指空页 —— 交给规范化那步报缺尺寸
  return 'failed';
}

/**
 * Normalize every downloaded atlas: fexli ships them without a `size:` page header, which pixi-spine divides by
 * (see tools/assets/atlas.mjs, written for exactly this). Done after all downloads because the atlas and its PNG
 * are separate concurrent tasks, so their order is not guaranteed. normalizeAtlas() is idempotent.
 */
function normalizeDownloadedAtlases() {
  let fixed = 0;
  const unsized = [];
  for (const dir of new Set(tasks.map((t) => t.dir))) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.atlas'))) {
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      const sizes = new Map();
      for (const p of atlasInfo(text).pages) {
        const pageFile = path.join(dir, p);
        if (!fs.existsSync(pageFile)) continue;
        const sz = pngSize(fs.readFileSync(pageFile));
        if (sz) sizes.set(p, sz);
      }
      const norm = normalizeAtlas(text, { pageSize: (p) => sizes.get(p) || null, pma: false });
      if (norm.missingSize.length) unsized.push(`${name}(${norm.missingSize.join(',')})`);
      if (norm.changed) { fs.writeFileSync(file, norm.text); fixed++; }
    }
  }
  for (const w of unsized) console.error(`[skin-spines] ⚠ atlas 页缺尺寸、未规范化: ${w}（对应 png 没下下来，渲染会按 0 除）`);
  return fixed;
}

async function main() {
  let cursor = 0; let downloaded = 0; let skipped = 0; let failed = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const res = await downloadOne(tasks[cursor++]);
      if (res === 'downloaded') downloaded++; else if (res === 'skipped') skipped++; else failed++;
    }
  }
  await Promise.all(Array.from({ length: 12 }, () => worker()));
  const normalized = normalizeDownloadedAtlases();
  console.log(`[skin-spines] 完成: 新下载 ${downloaded}, 已存在 ${skipped}, 失败 ${failed}${normalized ? `，规范化 atlas ${normalized} 份` : ''}`);
  for (const n of notes) console.log('  ⚠', n);
  if (failed) { const hint = proxyHint(); if (hint) console.error('提示：' + hint); }
}

main().catch((e) => { console.error(e); process.exit(1); });
