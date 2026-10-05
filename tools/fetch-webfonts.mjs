// Mirrors the Google Fonts css2 payload we use (Noto Sans SC for CJK, Oxanium, Rajdhani) into
// public/webfonts/google/ and writes a local @font-face sheet with the exact same unicode-range slices and
// display=swap, so neither the web build nor the packaged clients depend on an external font host.
//
// The bytes are the ones Google serves to a modern Chromium UA — same files, same slicing, same swap timing —
// so rendering is unchanged by construction; test/webfonts-local.test.js pins that no remote URL survives in the
// sheet, that every url() resolves to a real .woff2, and that public/index.html has no fonts.googleapis/gstatic ref.
//
//   node tools/fetch-webfonts.mjs [--check]     --check verifies the mirror without writing (CI-friendly)

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'webfonts', 'google');
const SHEET = path.join(OUT_DIR, 'google.css');

/** A modern UA gets woff2 + unicode-range slicing; an old one gets un-sliced whole families (much bigger). */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SOURCE = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900'
  + '&family=Oxanium:wght@400;500;600;700&family=Rajdhani:wght@500;600;700&display=swap';

const HEADER = `/* Mirrored verbatim from Google Fonts css2 by tools/fetch-webfonts.mjs: same woff2 files, same
 * unicode-range slices, same display=swap. Families/weights: Noto Sans SC 400/500/700/900,
 * Oxanium 400/500/600/700, Rajdhani 500/600/700. Kept in-repo so the web build and the packaged
 * clients render CJK with no external font host. Pinned by test/webfonts-local.test.js.
 * Regenerate: node tools/fetch-webfonts.mjs
 */
`;

/** /s/notosanssc/v41/<hash>.69.woff2 → notosanssc-v41-<hash>-69.woff2 (stable, collision-free enough). */
export function nameFor(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const file = parts[parts.length - 1].replace(/\.woff2$/, '');
  const stem = parts.slice(1, -1).join('-');            // notosanssc / v41
  const digest = createHash('sha1').update(u.pathname).digest('hex').slice(0, 8);
  return `${stem}-${file}-${digest}.woff2`;
}

export function rewrite(css, mapping) {
  return css.replace(/url\((https:\/\/[^)]+\.woff2)\)/g, (_all, url) => `url(/webfonts/google/${mapping(url)})`);
}

const check = process.argv.includes('--check');

/** Everything below runs only as a script: importing this module (the test does, for nameFor) must not fetch. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const css = await (await fetch(SOURCE, { headers: { 'user-agent': UA } })).text();
const urls = [...new Set(css.match(/https:\/\/[^)]+\.woff2/g) || [])];
if (!urls.length) throw new Error('no woff2 urls in the response — wrong UA?');

await mkdir(OUT_DIR, { recursive: true });
for (const url of urls) {
  const name = nameFor(url);
  const p = path.join(OUT_DIR, name);
  let have = null;
  try { have = (await stat(p)).size; } catch { /* not mirrored yet */ }
  if (check) { if (!have) throw new Error(`缺 ${name}`); continue; }
  if (have) continue;
  const bytes = new Uint8Array(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
  if (bytes.length < 100 || String.fromCharCode(...bytes.slice(0, 4)) !== 'wOF2') throw new Error(`${name} 不是 woff2`);
  await writeFile(p, bytes);
}

const sheet = HEADER + rewrite(css, nameFor);
if (check) {
  const current = await readFile(SHEET, 'utf8').catch(() => '');
  if (!current.includes('Mirrored verbatim')) throw new Error('google.css 缺失或不是生成物');
  if (/fonts\.(googleapis|gstatic)\.com/.test(current)) throw new Error('生成物里仍有远程地址');
  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.woff2'));
  const want = new Set(urls.map(nameFor));
  const missing = [...want].filter((n) => !files.includes(n));
  if (missing.length) throw new Error(`${missing.length} 个切片未镜像，例如 ${missing[0]}`);
  console.log(`webfonts OK: ${files.length} woff2, ${urls.length} referenced`);
  process.exit(0);
}
await writeFile(SHEET, sheet);
console.log(`mirrored ${urls.length} files → public/webfonts/google/ (${(Buffer.byteLength(sheet) / 1024).toFixed(0)} KB sheet)`);
}
