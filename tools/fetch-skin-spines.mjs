// tools/fetch-skin-spines.mjs — 离线下载皮肤 Spine 战斗骨骼（包含 Front/Back skel, atlas, png）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSkinIds, isInstalled, proxyHint } from './skin-selection.mjs';
import { normalizeAtlas, atlasInfo } from './assets/atlas.mjs';
import { pngSize } from './assets/formats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_PATH = path.join(ROOT, 'docs', 'research', '08-skins.json');
const TARGET_BASE = path.join(ROOT, 'public', 'assets', 'spine', 'op');

const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
const installed = installedSkinIds();

// 收集所有需要下载的骨骼文件任务（只收 data/skins-installed.json 点名的；空表 = 一个都不下载）
const tasks = [];

for (const [charId, skinList] of Object.entries(research.skins || {})) {
  for (const s of skinList) {
    if (!isInstalled(installed, s.skinId)) continue;
    const stem = s.stem;
    const bs = s.battleSpine;
    if (!bs) continue;

    // 一个骨骼文件的候选地址：fexli 仓现在把皮肤骨骼放在 spine/<charId>/<stem>/Spine/（一份，前后朝向共用），
    // 而这里原本按 <stem>/Front|Back 拼 —— 那是它更早的布局，实测 2026-10-06 六个地址全 404。
    // 所以每个文件给出「新布局 → 旧布局」×「jsDelivr → raw」，最后才是研究表里自带的那条 URL。
    const spineUrls = (side, ext) => {
      const at = (host, dir) => `${host}/spine/${charId}/${stem}/${dir}/${stem}.${ext}`;
      const js = (dir) => at('https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@main', dir);
      const raw = (dir) => at('https://raw.githubusercontent.com/fexli/ArknightsResource/main', dir);
      const old = side === 'front' ? 'Front' : 'Back';
      return [js('Spine'), js(old), raw('Spine'), raw(old)];
    };

    const addSide = (side, rec, dir) => {
      for (const ext of ['skel', 'atlas', 'png']) {
        const tableUrl = rec[ext]?.url;
        tasks.push({
          charId, stem, side, file: `${stem}.${ext}`, dir,
          urls: tableUrl ? [...spineUrls(side, ext), tableUrl] : spineUrls(side, ext),
        });
      }
    };

    if (bs.front) addSide('front', bs.front, path.join(TARGET_BASE, charId, stem, 'front'));
    if (bs.back) addSide('back', bs.back, path.join(TARGET_BASE, charId, stem, 'back'));
  }
}

console.log(`[skin-spines] 待处理 Spine 文件总数: ${tasks.length}`);

// 支持参数过滤，例如 node tools/fetch-skin-spines.mjs --all 或者指定干员
const args = process.argv.slice(2);
const limitOp = args.find(a => !a.startsWith('--'));

let activeTasks = tasks;
if (limitOp) {
  activeTasks = tasks.filter(t => t.charId === limitOp || t.stem.includes(limitOp));
  console.log(`[skin-spines] 按干员/皮肤过滤: ${limitOp}, 剩余任务: ${activeTasks.length}`);
}

async function downloadOne(t) {
  fs.mkdirSync(t.dir, { recursive: true });
  const dest = path.join(t.dir, t.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    return 'skipped';
  }

  const urls = t.urls || [t.url, t.fallback].filter(Boolean);
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'Stronghold-Spine-Sync/1.0' } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 50) {
          fs.writeFileSync(dest, buf);
          return 'downloaded';
        }
      }
    } catch {
      // 试下一个
    }
  }
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
  for (const dir of new Set(activeTasks.map((t) => t.dir))) {
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
  const CONCURRENCY = 12;
  let cursor = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  async function worker() {
    while (cursor < activeTasks.length) {
      const t = activeTasks[cursor++];
      const res = await downloadOne(t);
      if (res === 'downloaded') downloaded++;
      else if (res === 'skipped') skipped++;
      else failed++;
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const normalized = normalizeDownloadedAtlases();
  console.log(`[skin-spines] 完成: 新下载 ${downloaded}, 已存在 ${skipped}, 失败 ${failed}${normalized ? `，规范化 atlas ${normalized} 份` : ''}`);
  if (failed) { const hint = proxyHint(); if (hint) console.error('提示：' + hint); }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
