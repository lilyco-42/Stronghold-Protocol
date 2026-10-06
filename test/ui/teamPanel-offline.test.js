// 队友掉线时，屏幕上要说清「这段时间谁在打 TA 的阵地」。
//
// 群友原话：「掉线连不回来还要等读条」「连不回来掉线默认似了或者ai接管一下」「为了解决玩家离线 其他玩家
// 也在烧条」。服务器侧其实早就处理好了：`SP_COMBAT=client` 下人一走，`Match._authorityLost()` 就把那块场地
// 交给 `HeadlessJob` 在服务器上接着演算（`f.mode='server'`），座位还保留 10 分钟（`server/net.js` 的
// `reconnectWindowMs`）。缺的只是**看得见的说明** —— 战斗面板原来只有一个断网图标 + 「连接已断开」，
// 队友不知道阵地还在被打，本人也不知道回来还来得及。这条纯客户端，不动协议、不动服务器。
//
// 与 `test/ui/playtest6-unite.test.js` 同一套写法：这个组件没有 DOM 渲染通道，所以按源码断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PANEL = 'public/js/ui/teamPanel.js';

test('掉线队友的提示说明阵地由服务器代打（本人 / 队友两种说法）', () => {
  const src = read(PANEL);
  // 「谁在打」这句是本条的全部目的：只写「连接已断开」不算说过。
  assert.match(src, /这段时间服务器在替你打阵地/, '本人的掉线提示没说明阵地还在被打');
  assert.match(src, /这段时间服务器在替 \$\{p\.name \|\| '队友'\} 打阵地/, '队友的掉线提示没说明阵地还在被打');
  // 两条都得挂在重连上，而不是「TA 已经出局」。
  assert.match(src, /重连回来就能接上/, '提示没告诉玩家重连就能接上');
});

test('代打文案只在真的掉线时出现，且判据是 connected === false', () => {
  const src = read(PANEL);
  const offline = src.match(/const offline = ([^;]+);/);
  assert.ok(offline, '找不到 offline 的定义');
  assert.match(offline[1], /connected === false/, 'offline 不再以 connected 为判据，文案会挂到别的状态上');
  assert.match(offline[1], /!p\.isBot/, 'AI 座位不该被说成掉线');
  // 代打文案必须在 offline 分支里，而不是无条件显示（否则在线队友也被说成服务器代打）。
  const branch = src.match(/text=\$\{offline\s*\?([\s\S]*?):\s*meta\.text\}/);
  assert.ok(branch, '掉线提示不是 offline 的三元分支');
  assert.match(branch[1], /服务器在替/, 'offline 分支里没有代打说明');
  assert.ok(!/\$\{[^}]*服务器在替[^}]*\}/.test(src.replace(branch[0], '')), '代打说明漏到了 offline 分支之外');
});

test('服务器确实会在人走后代打场地（文案不是空话）', () => {
  const match = read('server/match/Match.js');
  assert.match(match, /_authorityLost\(ps, why\)/, '掉线接管入口没了');
  const takeover = match.slice(match.indexOf('_authorityLost(ps, why)'), match.indexOf('_authorityLost(ps, why)') + 900);
  assert.match(takeover, /this\._runOnServer\(f, why\)/, '掉线后不再交给服务器演算');
  assert.match(match, /f\.mode = 'server';/, '_runOnServer 没把场地切到服务器模式');
  const net = read('server/net.js');
  assert.match(net, /reconnectWindowMs:\s*10 \* 60_000/, '座位保留窗口不再是 10 分钟，提示里的时间承诺要改');
});
