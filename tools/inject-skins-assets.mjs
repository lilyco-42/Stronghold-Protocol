// tools/inject-skins-assets.mjs — 将 08-skins.json 的 174 款皮肤资产注入到 data/assets.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSkinIds, isInstalled } from './skin-selection.mjs';
import { atlasInfo } from './assets/atlas.mjs';
import { parseSkel } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';

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

/**
 * One side (front/back) of one skin's SpineEntry, computed from **the files on disk**.
 *
 * It used to copy the operator's default model here (`anims: defaultFront.anims`, one texture, `pma: false`).
 * That is a lie for any outfit whose skeleton differs: fexli ships some skins with `Skill` where the base has
 * `Skill_Start` (the client then throws `Animation not found`), and a few with only a 宿舍 model
 * (Default/Sit/Sleep — no attack clip at all). `test/assets.test.js` plays every role animation the manifest
 * names, so the manifest must be derived from the skel, exactly like `tools/assets/spine.mjs` does for base models.
 *
 * @returns {{ entry: object } | { why: string }} why = this side cannot be shipped
 */
function skinSpineSide(charId, stem, side, skillIndices) {
  const dir = `/assets/spine/op/${charId}/${stem}/${side}`;
  const skelRel = `${dir}/${stem}.skel`;
  const atlasRel = `${dir}/${stem}.atlas`;
  if (!fs.existsSync(path.join(ROOT, 'public', skelRel)) || !fs.existsSync(path.join(ROOT, 'public', atlasRel))) {
    return { why: '缺 skel 或 atlas' };
  }
  const info = atlasInfo(fs.readFileSync(path.join(ROOT, 'public', atlasRel), 'utf8'));
  if (!info.pages.length) return { why: 'atlas 没有页' };
  const textures = info.pages.map((p) => `${dir}/${p}`);
  if (!textures.every((t) => fs.existsSync(path.join(ROOT, 'public', t)))) return { why: `atlas 指的 png 不在盘上（${textures.length} 页）` };
  const sk = parseSkel(fs.readFileSync(path.join(ROOT, 'public', skelRel)), info.regions);
  if (sk.missingRegions?.length) missingArt.push(`${skinLabel} ${side}: ${sk.missingRegions.length} 个附件不在 atlas 里`);
  const anims = resolveRoles(sk.animations, { skillIndices, durations: sk.durations });
  // 有两款时装 fexli 给的是**宿舍模型**（只有 Default/Sit/Sleep/Move）。resolveRoles 会把攻击"兜底"到 Default，
  // 于是清单看着齐全、闸门也过，但战场上她攻击时就是在宿舍坐着 —— 比不提供更糟。
  // 判据：攻击动作必须是自己的一段，不是 idle 的别名。
  if (!anims.idle || !anims.attack?.loop || anims.attack.loop === anims.idle) {
    return { why: `没有战斗动作（实有 ${sk.animations.slice(0, 7).join('/') || '无'}）` };
  }
  return { entry: { skel: skelRel, atlas: atlasRel, textures, pma: info.hasPma, anims, animations: sk.durations, events: sk.events, hits: sk.hits, bounds: sk.bounds } };
}

const skipped = [];
const missingArt = [];
let skinLabel = '';

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

    // 头像只认本地文件：研究表里那条 avatar.url 指向 raw.githubusercontent.com，玩家侧在国内取不到，
    // 而且它会变成 assets.json 里的外链，直接踩中客户端的零外链闸门。缺文件就写 null，让选择页退回干员原头像。
    const localAvatar = path.join(ROOT, 'public', 'assets', 'char', 'skin_avatar', `${stem}.png`);
    const avatarUrl = fs.existsSync(localAvatar) ? `/assets/char/skin_avatar/${stem}.png` : null;

    const skinEntry = {
      name: s.name,
      group: s.group || '',
      avatar: avatarUrl,
    };

    // 只有本地磁盘真有该皮肤的 Spine 骨骼时才注入条目。
    // **没有骨骼就不写这条记录**：客户端的 installed 判的是"`chars[charId].skins[skinId]` 在不在"，
    // 写一条只有头像、没有骨骼的条目 = 选择页把它当可穿，玩家点了却什么都没发生 —— 那正是 c17 修掉的那个坑。
    const defaultFront = charRec.spine?.front || {};
    // 这套皮肤有几个技能就按几个解析（清单里基础皮的角色表说了算）
    const skillIndices = Object.keys(defaultFront.anims?.skills || {}).map(Number).filter(Number.isInteger);
    const indices = skillIndices.length ? skillIndices : [0];
    skinLabel = `${charId} ${stem}`;
    const front = skinSpineSide(charId, stem, 'front', indices);
    if (!front.entry) {
      // 素材没下全，或官方给的是**宿舍模型**（只有 Default/Sit/Sleep，没有攻击动作）—— 后者穿上去
      // 就是一个不会攻击的纸片，所以一律不装，选择页会把它标成未内置。
      if (front.why !== '缺 skel 或 atlas') skipped.push(`${skinId}：${front.why}`);
      continue;
    }
    skinEntry.spine = { front: front.entry };
    const back = skinSpineSide(charId, stem, 'back', indices);
    if (!back.entry && charRec.spine?.back) {
      // 原皮有 back 朝向而这套没有（实测 3 款：魔王 追悼、安洁莉娜 质素访客 / 夏卉 FA017）：朝上部署时模型会换回原皮，
      // 玩家看到的是"半件时装"。所以整套都不装。
      skipped.push(`${skinId}：缺 back 朝向（${back.why}）`);
      continue;
    }
    if (back.entry) skinEntry.spine.back = back.entry;

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
if (skipped.length) {
  console.log(`⚠ 清单点了名但没装的 ${skipped.length} 款（选择页会标成「未内置」）：`);
  for (const s of skipped) console.log('   ·', s);
}
if (missingArt.length) {
  console.log(`⚠ ${missingArt.length} 份骨骼有附件不在自己的 atlas 里（渲染时那部分会缺）：`);
  for (const s of missingArt.slice(0, 10)) console.log('   ·', s);
}
