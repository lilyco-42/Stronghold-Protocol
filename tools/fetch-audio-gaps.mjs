#!/usr/bin/env node
// 补 fetch-assets **补不到的那一小撮**：清单里点名了、盘上没有、而 plan 根本不为它生成 leaf 的文件。
//
// 为什么需要这个：0.3.1 的 4 个新攻击音效（p_atk_richfan_s / p_atk_javelinthrow_s /
// p_imp_brightensword_s / p_atk_staplegun_s）在 `data/assets.json` 里有条目，但 fetch-assets 的
// plan（由音频索引反推 units[].attackPools 得到）不会为它们排下载 —— 实测 `--dry-run` 的计划里
// 没有这 4 条，跑三遍也不会补上，于是切包的"存在性闸门"永远红。
//
// 而 `--allow-shrink` 不是解法：它会把 941 个音效池砍到 933，test/audio-pools-data.test.js 立刻红。
//
// 所以这里只做一件很窄的事：把清单里**现在缺的** `/assets/audio/sfx/**` 直接按官方镜像取回来。
// 音效在 ArknightsAssets2 的 **voice** 分支（`cn` 分支没有 sfx 的 mp3，同一路径在 cn 上 404、
// 在 voice 上 200）。其余类别（美术 / 骨骼）不走这里 —— 它们由 fetch-assets 正常下载。
//
// 用法：node tools/fetch-audio-gaps.mjs [--dry-run]
// 退出码：0 = 盘上齐了；1 = 还有缺的（会把缺的逐个打出来）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WWW = path.join(ROOT, 'public');
const MANIFEST = path.join(ROOT, 'data', 'assets.json');
const AUDIO_PREFIX = '/assets/audio/sfx/';
const REMOTE_BASE = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/';
const PROXY_BASE = 'https://gh-proxy.com/' + REMOTE_BASE; // raw 对 CI runner 会限流，镜像作为备选
const RETRIES = 3;
const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(MANIFEST)) {
  console.error(`没有 ${MANIFEST} —— 先在游戏树里跑 fetch-assets`);
  process.exit(1);
}

/** 清单里所有以 / 开头的资源 URL（去重）。 */
function manifestUrls(value, out = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('/assets/')) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) manifestUrls(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) manifestUrls(v, out);
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const missing = [...manifestUrls(manifest)].filter((u) => !fs.existsSync(path.join(WWW, u)));

const audioGaps = missing.filter((u) => u.startsWith(AUDIO_PREFIX));
const others = missing.filter((u) => !u.startsWith(AUDIO_PREFIX));

console.log(`清单缺 ${missing.length} 个：音效 ${audioGaps.length} 个（本脚本负责），其它 ${others.length} 个（不归这里管）`);
for (const u of others.slice(0, 10)) console.log(`  · 非音效缺口：${u}`);
if (dryRun) {
  for (const u of audioGaps) console.log(`  · would fetch ${u}`);
  process.exit(audioGaps.length ? 1 : 0);
}

async function grab(url) {
  for (let i = 1; i <= RETRIES; i++) {
    for (const base of [REMOTE_BASE, PROXY_BASE]) {
      try {
        const res = await fetch(base + url.slice(AUDIO_PREFIX.length), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) continue;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        /* 换下一个候选 / 下一次重试 */
      }
    }
    if (i < RETRIES) await new Promise((r) => setTimeout(r, 1_500 * i));
  }
  return null;
}

let failed = 0;
for (const u of audioGaps) {
  const dest = path.join(WWW, u);
  const body = await grab(u);
  if (!body || !body.length) {
    console.error(`  ✗ ${u}（三次重试都失败）`);
    failed++;
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`  ✓ ${u} (${body.length} B)`);
}

if (failed) {
  console.error(`音效补漏后仍缺 ${failed} 个 —— 切包的离线闸门会因此判红`);
  process.exit(1);
}
console.log(`音效补漏完成：${audioGaps.length} 个`);
