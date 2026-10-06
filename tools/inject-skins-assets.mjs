// tools/inject-skins-assets.mjs — 将 08-skins.json 的 174 款皮肤资产注入到 data/assets.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSkinIds, isInstalled } from './skin-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_PATH = path.join(ROOT, 'docs', 'research', '08-skins.json');
const ASSETS_PATH = path.join(ROOT, 'data', 'assets.json');

const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
const assets = JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'));
const installed = installedSkinIds();

if (!assets.chars) {
  console.error('✘ assets.json 缺少 chars 字段');
  process.exit(1);
}

// 先清掉上一次注入的结果：本工具的输出必须只由 data/skins-installed.json 决定，重跑不累积、卸载后条目消失。
for (const rec of Object.values(assets.chars)) delete rec.skins;

let injectedCount = 0;
let charsCount = 0;

for (const [charId, skinList] of Object.entries(research.skins || {})) {
  const charRec = assets.chars[charId];
  if (!charRec) continue;

  const mine = {};
  charRec.skins = mine;
  charsCount++;

  for (const s of skinList) {
    const skinId = s.skinId;
    if (!isInstalled(installed, skinId)) continue;
    const stem = s.stem;

    // 提取 avatar：优先使用本地离线内置头像路径
    const localAvatar = path.join(ROOT, 'public', 'assets', 'char', 'skin_avatar', `${stem}.png`);
    const avatarUrl = fs.existsSync(localAvatar)
      ? `/assets/char/skin_avatar/${stem}.png`
      : (s.avatar?.url || null);

    const skinEntry = {
      name: s.name,
      group: s.group || '',
      avatar: avatarUrl,
    };

    // 只有在本地磁盘确实存在该皮肤的 Spine 骨骼时才注入 spine 字段，否则留空由渲染器平滑使用干员原皮骨骼
    const localFrontSkel = path.join(ROOT, 'public', 'assets', 'spine', 'op', charId, stem, 'front', `${stem}.skel`);
    if (fs.existsSync(localFrontSkel)) {
      const defaultFront = charRec.spine?.front || {};
      const defaultBack = charRec.spine?.back || {};

      skinEntry.spine = {
        front: {
          skel: `/assets/spine/op/${charId}/${stem}/front/${stem}.skel`,
          atlas: `/assets/spine/op/${charId}/${stem}/front/${stem}.atlas`,
          textures: [`/assets/spine/op/${charId}/${stem}/front/${stem}.png`],
          pma: false,
          anims: defaultFront.anims || {},
          animations: defaultFront.animations || {},
          events: defaultFront.events || ['OnAttack', 'OnStart'],
          hits: defaultFront.hits || {},
          bounds: defaultFront.bounds || null,
        },
      };

      const localBackSkel = path.join(ROOT, 'public', 'assets', 'spine', 'op', charId, stem, 'back', `${stem}.skel`);
      if (fs.existsSync(localBackSkel)) {
        skinEntry.spine.back = {
          skel: `/assets/spine/op/${charId}/${stem}/back/${stem}.skel`,
          atlas: `/assets/spine/op/${charId}/${stem}/back/${stem}.atlas`,
          textures: [`/assets/spine/op/${charId}/${stem}/back/${stem}.png`],
          pma: false,
          anims: defaultBack.anims || defaultFront.anims || {},
          animations: defaultBack.animations || defaultFront.animations || {},
          events: defaultBack.events || ['OnAttack', 'OnStart'],
          hits: defaultBack.hits || {},
          bounds: defaultBack.bounds || null,
        };
      }
    }

    mine[skinId] = skinEntry;
    injectedCount++;
  }
  if (!Object.keys(mine).length) { delete charRec.skins; charsCount--; }
}

// 更新 stats
assets.stats = assets.stats || {};
// 一套都没装时不写这两个键：清单必须和没跑过本工具时逐字节相同（和 snapshot.js 对 u.skin 用 undefined 同理）
if (injectedCount) {
  assets.stats.skins = injectedCount;
  assets.stats.charsWithSkins = charsCount;
} else {
  delete assets.stats.skins;
  delete assets.stats.charsWithSkins;
}

// 安全写入，保持原有排版
fs.writeFileSync(ASSETS_PATH, JSON.stringify(assets) + '\n', 'utf8');
console.log(`✔ 成功向 data/assets.json 注入 ${charsCount} 名干员的共 ${injectedCount} 套皮肤资产条目。`);
