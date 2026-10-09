// 一张图失败以后该怎么办（`ui/gameComponents.js` 的 `Img`）。
//
// 为什么要单独钉：旧实现是 `onError` 一次就把这张 URL 永久拉黑，而详情面板里干员立绘的 fallback 正是
// `UnitThumb`（头像）。iOS 上 `onError` 会因为**暂时性**原因触发（内存压力下的解码失败、
// `capacitor://` scheme handler 在并发下丢请求），于是"闪了一下"变成"整个会话只剩头像" —— 2026-10-08
// 那条玩家反馈的形状就是这么来的。现在退避几次、并且换 `?retry=n` 破缓存，跑完才认输。
//
// 带 hook 的组件在这个仓库里按源码断言（见 loadout-stats / playtest4 的写法），真正能跑的纯函数是
// `retrySrc`，所以两边各测各的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/ui/gameComponents.js'), 'utf8');

const { retrySrc, IMG_RETRY_MS } = await import('../../public/js/ui/gameComponents.js');

test('retrySrc 第一次用原 URL，之后带 retry=n；已有 query 的用 & 接', () => {
  assert.equal(retrySrc('/assets/a.png', 0), '/assets/a.png');
  assert.equal(retrySrc('/assets/a.png', 1), '/assets/a.png?retry=1');
  assert.equal(retrySrc('/assets/a.png?x=1', 2), '/assets/a.png?x=1&retry=2');
  assert.equal(retrySrc(null, 3), null, '空 src 不许被拼成 "null?retry=3"');
  assert.equal(retrySrc('', 1), '');
});

test('重试次数与间隔都是有界的，且先试得勤、后试得疏', () => {
  assert.ok(Array.isArray(IMG_RETRY_MS) && IMG_RETRY_MS.length >= 1 && IMG_RETRY_MS.length <= 6,
    `次数要有界：${JSON.stringify(IMG_RETRY_MS)}`);
  assert.ok(IMG_RETRY_MS.every((n) => Number.isFinite(n) && n > 0));
  IMG_RETRY_MS.forEach((n, i) => {
    if (i > 0) assert.ok(n > IMG_RETRY_MS[i - 1], `退避必须递增：${JSON.stringify(IMG_RETRY_MS)}`);
  });
  assert.ok(IMG_RETRY_MS[0] <= 1000, '第一次要快，否则玩家会觉得根本没加载');
  assert.ok(IMG_RETRY_MS.reduce((a, b) => a + b, 0) <= 12000, '全部试完也别超过十二秒，别在列表页里无限重试');
});

test('Img 的结构：先重挂再拉黑，卸载时收回定时器', () => {
  const body = (/export function Img\([\s\S]*?\n\}/.exec(SRC) || [''])[0];
  assert.ok(body.length > 0, '没抓到 Img 的函数体');
  // key=${tries} 让 preact 换掉那个 <img> 元素本身：解码失败时同一个元素不会自己再解一次。
  assert.match(body, /key=\$\{tries\}/, '重试要重挂元素，只改 src 在解码失败这一类上不够');
  assert.match(body, /retrySrc\(src, tries\)/, 'URL 走 retrySrc，别在 JSX 里再拼一份');
  // 拉黑必须发生在"试完"之后，而不是第一次 error。
  assert.match(body, /if \(tries >= IMG_RETRY_MS\.length\) \{[\s\S]{0,60}setGivenUpFor\(src\)/,
    '只有试完才放弃；一次 error 就永久退回 fallback 就是这次的症状');
  assert.match(body, /givenUpFor === src\) return fallback/, '放弃是按这张 src 记的（换图要能重新来）');
  assert.match(body, /useEffect\(\(\) => \(\) => clearTimeout\(timer\.current\), \[\]\)/,
    '卸载要清定时器：一个列表页挂几十上百个 <img>，漏下来的每个定时器都会在某一刻 setState 到已卸载的组件');
  assert.match(body, /loading="lazy"/, '懒加载保留（大图列表靠它）');
});

test('拉黑之后换 src 会重新计数（否则一次失败会连累后面所有图）', () => {
  assert.match(SRC, /useEffect\(\(\) => \{ setTries\(0\); setGivenUpFor\(null\); \}, \[src\]\)/);
});
