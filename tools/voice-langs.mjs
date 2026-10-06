// tools/voice-langs.mjs — 登记"这个安装包里到底有哪几种配音"，写成 data/voice-langs.json。
//
// 为什么要有这份文件：设置页那个语言开关**不能无条件出现**。清单里写 4 种语言但盘上只有中文时，
// 玩家切到日语会得到静音 —— 那和我昨天刚修的「时装页摆出来却一款都没有」是同一个错误。
// 所以开关的可见性由**盘上真实文件**决定，而不是由代码里写了什么决定。
//
//   node tools/voice-langs.mjs --write    # 打包前跑一次
//   node tools/voice-langs.mjs            # 只看报告
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'voice-langs.json');
/** 与 tools/assets/audio.mjs 的 VOICE_DIRS 对应：包内目录名 → 上游源目录。 */
export const LANGS = Object.freeze({ cn: 'voice_cn', jp: 'voice', en: 'voice_en', kr: 'voice_kr' });
const VOICE_ROOT = path.join(ROOT, 'public', 'assets', 'audio', 'voice');

function countDir(abs) {
  if (!fs.existsSync(abs)) return { files: 0, bytes: 0 };
  let files = 0; let bytes = 0;
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.mp3')) { files++; bytes += fs.statSync(p).size; }
    }
  }
  return { files, bytes };
}

/** 盘上真实存在的语言（有文件才算）。 */
export function scanVoiceLangs(root = ROOT) {
  const out = {};
  for (const lang of Object.keys(LANGS)) {
    const { files, bytes } = countDir(path.join(root, 'public', 'assets', 'audio', 'voice', lang));
    if (files > 0) out[lang] = { files, bytes };
  }
  return out;
}

export function buildDoc(root = ROOT) {
  const langs = scanVoiceLangs(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'assets.json'), 'utf8'));
  const slots = new Set();
  for (const bySlot of Object.values(manifest.audio?.voice || {})) for (const s of Object.keys(bySlot || {})) slots.add(s);
  return { version: 1, default: 'cn', slots: [...slots].sort(), langs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const doc = buildDoc();
  const list = Object.entries(doc.langs);
  console.log(`包内配音语言：${list.map(([l, v]) => `${l}(${v.files} 个 / ${(v.bytes / 1048576).toFixed(1)}MB)`).join('、') || '一种都没有'}`);
  console.log(`槽位 ${doc.slots.length} 个：${doc.slots.join(',')}`);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(doc) + '\n');
    console.log(`写了 data/voice-langs.json（${list.length} 种语言）`);
  } else {
    console.log('（加 --write 才落盘）');
  }
}
