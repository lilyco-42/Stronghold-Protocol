// tools/compat-baseline.mjs — 扫一遍**客户端真正会加载**的 js/css，报出「最低要多少版本的内核」。
//
// 为什么要个工具而不是一句"我们支持安卓 7 以上"：`minSdkVersion = 24` 只说明 APK 装得上，
// 不说明 WebView 解析得了。语法级的东西（`??=`、`static {}`）polyfill 救不了 —— 模块在解析阶段就
// SyntaxError，`ui/compat.js` 那种能力探测根本没机会跑。所以必须区分两类：
//   · 可以兜底的（API 缺失）→ ui/compat.js 已经处理，不计入下限
//   · 兜不了的（语法/CSS 特性）→ 计入下限，要降就得在打包前转译
//
//   node tools/compat-baseline.mjs            # 人看的报告
//   node tools/compat-baseline.mjs --json     # 给 test/compat-baseline.test.js 断言用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 会被浏览器加载的目录/文件。`server/sim` 看着像服务端，其实**会进页面**：打包时
 `package-client.mjs` 把它摊平成产物里的 `sim/`，浏览器端的战斗预演就跑在这份代码上 ——
 漏扫它会得出偏乐观的下限（实测 `??=` 就在 `server/sim/Battle.js` 里）。 */
const SCAN = ['public/js', 'public/css', 'public/vendor', 'shared', 'server/sim'];

/**
 * Chromium 起版本支持某写法的表。`polyfilled: true` 的条目由 ui/compat.js 兜底，所以不抬下限。
 * 每条都写清"为什么是这一版"，别把猜的数字当结论。
 */
const FEATURES = [
  { name: '??=', re: /\?\?=/g, min: 85, why: '逻辑赋值 ES2021' },
  { name: '||= / &&=', re: /(?:\|\|=|&&=)/g, min: 85, why: '逻辑赋值 ES2021' },
  { name: 'static {}', re: /(?:^|[\s;{])static\s*\{/g, min: 94, why: 'class 静态初始化块' },
  { name: 'CSS :is()/:where()', re: /:(?:is|where)\(/g, min: 88, why: 'CSS 选择器函数', files: /\.css$/ },
  { name: 'CSS *vh 相对视口单位', re: /\d+(?:dvh|svh|lvh)\b/g, min: 108, why: '动态/小/大视口单位', files: /\.css$/ },
  { name: 'CSS aspect-ratio', re: /(?:^|[\s{;])aspect-ratio\s*:/g, min: 88, why: '盒模型宽高比', files: /\.css$/ },
  // 下面这几条 ui/compat.js 已经按能力探测兜过，报出来但不计入下限
  { name: 'Object.hasOwn', re: /Object\.hasOwn\s*\(/g, min: 93, polyfilled: true, why: 'compat.js 已 shim' },
  { name: '.at()', re: /\.at\(/g, min: 92, polyfilled: true, why: 'compat.js 已 shim' },
  { name: 'findLast/findLastIndex', re: /\.findLast(?:Index)?\s*\(/g, min: 97, polyfilled: true, why: 'compat.js 已 shim' },
  { name: 'structuredClone', re: /\bstructuredClone\s*\(/g, min: 106, polyfilled: true, why: 'compat.js 已 shim' },
];

function* walk(abs) {
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    const p = path.join(abs, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|css)$/.test(d.name)) yield p;
  }
}

export function scanBaseline(root = ROOT) {
  const found = new Map();
  let files = 0;
  for (const rel of SCAN) for (const file of walk(path.join(root, rel))) {
    files++;
    const src = fs.readFileSync(file, 'utf8');
    for (const f of FEATURES) {
      if (f.files && !f.files.test(file)) continue;
      const n = (src.match(f.re) || []).length;
      if (!n) continue;
      const rec = found.get(f.name) || { ...f, hits: 0, where: [] };
      rec.hits += n;
      rec.where.push(`${path.relative(root, file).replace(/\\/g, '/')}×${n}`);
      found.set(f.name, rec);
    }
  }
  const hard = [...found.values()].filter((f) => !f.polyfilled);
  const soft = [...found.values()].filter((f) => f.polyfilled);
  return {
    files,
    hard, soft,
    floor: hard.length ? Math.max(...hard.map((f) => f.min)) : 80,
    drivers: hard.filter((f) => f.min === (hard.length ? Math.max(...hard.map((x) => x.min)) : 80)).map((f) => f.name),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = scanBaseline();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  console.log(`扫了 ${r.files} 个会进页面的 js/css（目录：${SCAN.join(', ')}）`);
  console.log(`\n最低内核要求：Chromium ${r.floor} —— 由 ${r.drivers.join(' + ') || '（无硬门槛）'} 决定`);
  for (const f of r.hard.sort((a, b) => b.min - a.min)) console.log(`  ✋ ${f.name}: ${f.min}+ · ${f.hits} 处 · ${f.why}\n      ${f.where.slice(0, 5).join(' ')}`);
  if (r.soft.length) console.log('\n已兜底（不计入下限，ui/compat.js 按能力探测装）：');
  for (const f of r.soft.sort((a, b) => b.min - a.min)) console.log(`  ✓ ${f.name}: ${f.min}+ · ${f.hits} 处 · ${f.why}`);
  console.log('\n注：装得上 APK（minSdk 24 / 安卓 7）≠ 解析得了上面的语法。要覆盖更低内核，得在打包前转译，不是再加 polyfill。');
}
