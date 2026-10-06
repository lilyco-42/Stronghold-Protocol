// test/compat-baseline.test.js — 守住 tools/compat-baseline.mjs 的**覆盖面**，不是守住它报的数字。
//
// 为什么不钉 "floor = 108"：那个数会随上游一行 CSS 变化，钉死它只会让人在正常改动后去改测试。
// 真正会骗人的是"扫漏了"—— 本工具第一版就把 `server/sim` 漏在扫描目录外，于是报出一个偏乐观的
// 下限（`??=` 有 16 处正好在 `server/sim/Battle.js` 和 kits 里），而 `minSdkVersion = 24` 会让人
// 以为安卓 7 能跑。所以下面几条都只问一件事：**该看见的有没有看见**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanBaseline } from '../tools/compat-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = scanBaseline(ROOT);

test('扫描确实覆盖到浏览器会加载的三类代码', () => {
  const paths = r.hard.flatMap((f) => f.where.map((w) => w.split('×')[0]));
  assert.ok(r.files > 120, `只扫了 ${r.files} 个文件，扫描目录清单八成漏了东西`);
  // 摊平进产物的服务端演算代码
  assert.ok(paths.some((p) => p.startsWith('server/sim/')), '没扫 server/sim —— 它会被打包成产物里的 sim/，浏览器真的加载');
  // 第三方大库（three.core.js 的 static {} 就在这）
  assert.ok(paths.some((p) => p.startsWith('public/vendor/')), '没扫 public/vendor');
  // 样式表（CSS 特性的唯一来源）
  assert.ok(paths.some((p) => p.endsWith('.css')), '没扫 public/css');
});

test('下限等于最严的那条硬门槛，且 polyfilled 的不参与', () => {
  assert.ok(r.hard.length, '一条硬门槛都没扫到 —— 要么代码变了，要么正则失效了');
  assert.equal(r.floor, Math.max(...r.hard.map((f) => f.min)), 'floor 与最严的硬门槛不一致');
  assert.deepEqual(r.soft.filter((s) => r.hard.some((h) => h.name === s.name)), [], '同一条既算硬门槛又算已兜底');
});

test('标了「已兜底」的每一条，compat.js 里真的有对应的 shim', () => {
  const shim = readFileSync(path.join(ROOT, 'public/js/ui/compat.js'), 'utf8');
  for (const s of r.soft) {
    const needle = s.name === '.at()' ? "'at'" : s.name === 'Object.hasOwn' ? "'hasOwn'"
      : s.name.startsWith('findLast') ? "'findLast'" : s.name;
    assert.ok(shim.includes(needle), `${s.name} 被算作「compat.js 已 shim」，但那个文件里找不到它`);
  }
  assert.match(shim, /installCompat/, 'compat.js 的入口没了，所有「已兜底」的判定都不成立');
});

test('报告里每条硬门槛都指名了文件和出现次数', () => {
  for (const f of r.hard) {
    assert.ok(f.min > 0 && typeof f.why === 'string' && f.why.length > 1, `${f.name} 缺版本号或理由`);
    assert.ok(f.hits > 0 && f.where.length > 0, `${f.name} 说命中 ${f.hits} 处却没有一个文件名`);
    assert.ok(/\.(js|mjs|css)×\d+$/.test(f.where[0]), `${f.name} 的出处没带文件名和次数: ${f.where[0]}`);
  }
});
