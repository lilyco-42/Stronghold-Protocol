// 把日语配音整套拉到 public/assets/audio/voice/jp/ —— **不动 data/assets.json**。
//
// 为什么不直接用现成的 `--voice-lang=jp`：那个参数是上游的构建期开关，跑一遍会把清单里的
// `/voice/cn/…` 整条换成 `/voice/jp/…`，于是中文就没了 —— 而我们要的是**两种语言同时在包里**、
// 玩家在设置里切。清单保持中文一份，日语按"同名不同目录"推出来（已实测：11 个不同干员 × 4 个
// 语言目录全部 200，文件名都是 cn_019.mp3 这种，语言不体现在文件名里）。
//
// 跑法：NODE_USE_ENV_PROXY=1 node tools/fetch-voice-alt-langs.mjs jp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2';
const DIRS = { jp: 'voice', en: 'voice_en', kr: 'voice_kr' };   // 与 tools/assets/audio.mjs 的 VOICE_DIRS 一致

const langs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!langs.length || langs.some((l) => !DIRS[l])) {
  console.error(`用法: node tools/fetch-voice-alt-langs.mjs [${Object.keys(DIRS).join('|')}]…`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
const voice = manifest.audio?.voice || {};
// 清单里存的是默认语言（cn）的路径；文件名与干员号从它上面读，不另建一份表。
const DEFAULT_LANG = 'cn';
const lines = new Set();
for (const [charId, slots] of Object.entries(voice)) {
  for (const p of Object.values(slots || {})) {
    for (const u of Array.isArray(p) ? p : [p]) {
      if (typeof u !== 'string') continue;
      const m = u.match(new RegExp(`^/assets/audio/voice/${DEFAULT_LANG}/(.+?)/([a-z]{2}_\\d+)\\.mp3$`));
      if (m) lines.add(`${m[1]}/${m[2]}.mp3`);
    }
  }
}
const list = [...lines].sort();
console.log(`清单里 ${DEFAULT_LANG} 语音 ${list.length} 条，目标语言：${langs.join(', ')}`);

let cursor = 0; const done = {}; for (const l of langs) done[l] = { ok: 0, exists: 0, fail: [] };
async function worker() {
  while (cursor < list.length) {
    const line = list[cursor++];
    for (const lang of langs) {
      const dest = path.join(ROOT, 'public', 'assets', 'audio', 'voice', lang, line);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 500) { done[lang].exists++; continue; }
      const url = `${BASE}/${DIRS[lang]}/${line}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && buf.length > 500) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); done[lang].ok++; }
        else done[lang].fail.push(`${line} ← ${res.status} ${buf.length}B`);
      } catch (e) { done[lang].fail.push(`${line} ← ${e.name}`); }
    }
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
let bytes = 0;
for (const lang of langs) {
  const dir = path.join(ROOT, 'public', 'assets', 'audio', 'voice', lang);
  const walk = (d) => (fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = fs.existsSync(dir) ? walk(dir) : [];
  bytes += files.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`${lang}: 新下 ${done[lang].ok} · 已存在 ${done[lang].exists} · 失败 ${done[lang].fail.length} · 盘上共 ${files.length} 个文件`);
  for (const f of done[lang].fail.slice(0, 5)) console.log('   ❌', f);
}
console.log(`合计 ${(bytes / 1048576).toFixed(1)} MB（这些文件在 .gitignore 里，只能靠打包进 payload）`);
console.log(`下一步：node tools/voice-langs.mjs --write  把在包里的语言登记成 data/voice-langs.json`);
