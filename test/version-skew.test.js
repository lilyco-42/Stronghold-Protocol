// 客户端和服务端可能跑在不同 RELEASE 上，而两边共享 PROTOCOL_VERSION（1）—— 线路上没有任何东西会说出来。
// 更要紧的是：客户端自己算战斗。public/js/battle/runner.js 用自己的 /sim/ 与 /data/ 建 Battle，算完把 b.result
// 报给服务端，服务端幂等收下、**不复算**。于是一个比服务端旧的客户端按旧规则算完就报，服务端照收：
// 这就是「客户端和服务端不同步」，而它以前完全静默（runner.js 自己的注释就写着 "a battle simulated without
// part of the data would still produce a plausible result the server accepts"）。
//
// 实测（2026-10-11，已发布的 v0.2.2-c32 客户端 = 游戏 082fc0a8，对线上 0.2.3 服务端）：
//   server/sim  20 个文件 +411 −74     shared  2 个文件 +9 −3     data  10 个文件 +98 763 行
// 而它的 hello 顺利通过版本检查 —— PROTOCOL_VERSION 两边都是 1。
// 同一时刻的 c33…c39 客户端 sim / shared / data 与服务端**逐字节相同**（只有 public/js 里客户端专用的渲染文件
// 不同），所以"release 相同"在已发布的这批里就等于"模拟一致" —— 判据用 release 而不是 build 就是据此定的。
//
// 这个文件钉住修法的两端：客户端认出差异并说出来（Net.versionSkew → ui/connBanner.js），
// 服务端把看到的客户端 release 数出来（Network.countClientApp → /healthz clientApps）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Net, pageNotFromServer, healthUrl } from '../public/js/net.js';
import { versionSkewNotice, bannerVisible } from '../public/js/ui/connBanner.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

/** 打包客户端的页面 origin：Electron / Tauri 在 127.0.0.1:47821，Capacitor 在 https://localhost。 */
const PACKAGED = { protocol: 'https:', host: '127.0.0.1:47821' };
/** 网页版：页面就是游戏服务器自己发的。 */
const WEB = { protocol: 'https:', host: 'sp.lain42.top' };

/** 在假的 `location` 下跑 `fn`，跑完还原（Net 解析地址读的是 globalThis.location）。 */
function asPage(loc, fn) {
  const page = globalThis.location;
  globalThis.location = loc;
  try { return fn(); } finally { globalThis.location = page; }
}

test('versionSkew: 四种情况分得开 —— 判据是 release，因为 PROTOCOL_VERSION 认不出来', () => {
  assert.equal(PROTOCOL_VERSION, 1, '线上两端都是 1；0.2.2 与 0.2.3 在它眼里一模一样，这正是要补的那块');
  asPage(PACKAGED, () => {
    const net = new Net({ url: 'wss://sp.lain42.top/ws' });
    net.serverApp = APP_VERSION;
    assert.deepEqual(net.versionSkew(), { state: 'same', own: APP_VERSION, server: APP_VERSION, local: true });

    // 客户端比服务端旧：payload 还是 0.2.3，服务器已经到 0.2.4 —— 玩家报的就是这一种，它最危险，
    // 因为战斗由客户端按旧规则算完再报，服务端不复算。
    net.serverApp = '0.2.4';
    assert.deepEqual(net.versionSkew(), { state: 'client-older', own: APP_VERSION, server: '0.2.4', local: true });

    // 服务端比客户端旧：fork 的客户端连一台上游 0.2.2 的服。功能会缺，但模拟不会"算错"。
    net.serverApp = '0.2.2';
    assert.deepEqual(net.versionSkew(), { state: 'server-older', own: APP_VERSION, server: '0.2.2', local: true });

    // 读不到版本（自建服 /healthz 没给 CORS）—— 'unknown' 永远不是"不一致"。
    net.serverApp = null;
    assert.deepEqual(net.versionSkew(), { state: 'unknown', own: APP_VERSION, server: null, local: true });
  });
});

test('versionSkew 的方向命名容易读反，单独钉一条', () => {
  asPage(PACKAGED, () => {
    const net = new Net({ url: 'wss://sp.lain42.top/ws' });
    net.serverApp = '0.2.2';   // 服务端 0.2.2 < 客户端 —— 'server-older' 说的是**服务端**旧
    assert.equal(net.versionSkew().state, 'server-older');
    net.serverApp = '0.2.4';   // 服务端更新 —— 于是客户端才是旧的那个
    assert.equal(net.versionSkew().state, 'client-older');
  });
});

test('pageNotFromServer: 页面不是服务器发的才为真 —— 只有那时 reload 修不了', () => {
  assert.equal(healthUrl('wss://sp.lain42.top/ws', WEB), '/healthz', '网页版：同源，相对路径');
  assert.equal(pageNotFromServer('wss://sp.lain42.top/ws', WEB), false);
  assert.equal(healthUrl('wss://sp.lain42.top/ws', PACKAGED), 'https://sp.lain42.top/healthz');
  assert.equal(pageNotFromServer('wss://sp.lain42.top/ws', PACKAGED), true);
  assert.equal(pageNotFromServer('ws://192.168.1.9:3000/ws', PACKAGED), true, '自建服同理');
  // 没有地址时按页面自己的 origin 算 —— 宁可不显示，也不凭空指控。
  assert.equal(pageNotFromServer('', PACKAGED), false);
});

test('versionSkewNotice: 只有"服务器发的页面"之外的页面才出横幅', () => {
  const older = { state: 'server-older', own: APP_VERSION, server: '0.2.2', local: true };
  assert.equal(versionSkewNotice(older), older, '打包客户端 + 服务端旧 → 说');
  assert.equal(versionSkewNotice({ ...older, state: 'client-older' }).state, 'client-older', '另一个方向也说');
  assert.equal(versionSkewNotice({ ...older, state: 'same', server: APP_VERSION }), null, '一致 → 不说');
  assert.equal(versionSkewNotice({ ...older, state: 'unknown', server: null }), null, '读不到 → 不说');
  assert.equal(versionSkewNotice({ ...older, local: false }), null,
    '服务器自己发的页面交给 ui/buildGuard.js —— 它一部署就 reload，横幅只会是重复的噪音');
  assert.equal(versionSkewNotice(null), null);
});

test('bannerVisible: 版本不同步也点亮横幅，和 conn-banner 的其它状态同一形状', () => {
  const skew = { state: 'server-older', own: APP_VERSION, server: '0.2.2', local: true };
  assert.equal(bannerVisible({ status: 'online' }, true, false, false, null), false);
  assert.equal(bannerVisible({ status: 'online' }, true, false, false, skew), true);
  assert.equal(bannerVisible({ status: 'online' }, false, false, false, skew), false, '没进游戏就不显示');
  assert.equal(bannerVisible({ status: 'online' }, true, false, true, skew), true, '和 buildStale 不互斥');
  assert.equal(bannerVisible({ status: 'reconnecting', everOnline: true }, true, false, false, skew), true);
});

test('hello 帧带上 APP_VERSION —— 服务端只有这一条路能知道对面是哪个 release', () => {
  const sent = [];
  asPage(PACKAGED, () => {
    const net = new Net({
      url: 'wss://sp.lain42.top/ws',
      // 假定时器：_sendHello 会挂一个 hello 超时，真定时器会让测试进程多活 8 秒。
      timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} },
    });
    net.name = '博士';
    net.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    net._sendHello();
  });
  assert.equal(sent.length, 1, 'hello 发出去了');
  assert.equal(sent[0].t, 'hello');
  assert.equal(sent[0].app, APP_VERSION, '客户端自己的 release');
  assert.equal(sent[0].version, PROTOCOL_VERSION, '格式号照旧，没被顶掉');
  assert.equal(validateC2S(sent[0]), null, '这一帧必须过协议表');
});

test('协议表：app 可选、可缺、长度与字符集受限 —— 老客户端一个字段都不发也照收', () => {
  assert.equal(validateC2S({ t: 'hello', name: 'x' }), null, '不带 app 的老客户端');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: '0.2.2' }), null);
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: '0.2.3-dev' }), null);
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: 'v0.2.2-32-gabc1234' }), null, 'describe 那种也认');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: '0.2.3-custom' }), null, 'fork 自己的分支版本');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: null }), null);
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: '' }), 'bad field app', '空串不是版本');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: 'x'.repeat(25) }), 'bad field app', '长度上限挡住无界增长');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: 'a b' }), 'bad field app', '它要当键用，空格不收');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: 'a\nb' }), 'bad field app');
  assert.equal(validateC2S({ t: 'hello', name: 'x', app: 42 }), 'bad field app');
});

test('countClientApp 自己挡住线路上的垃圾 —— 服务端对 hello 不走协议表', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    for (const junk of [undefined, null, '', 42, {}, [], 'x'.repeat(25), 'a b', 'a\nb', true]) srv.network.countClientApp(junk);
    assert.deepEqual(srv.network.appVersions(), { unknown: 10 }, '一律记成 unknown，绝不当成键');
    srv.network.countClientApp(APP_VERSION);
    assert.deepEqual(srv.network.appVersions(), { unknown: 10 }, '自己这一版不进表');
    srv.network.countClientApp('0.2.2');
    assert.deepEqual(srv.network.appVersions(), { unknown: 10, '0.2.2': 1 }, '正常版本照收');
  } finally { await srv.close(); }
});

test('服务端数出看到的客户端 release，只留不是自己这一版的（外加 unknown）', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const clients = [];
  const connect = async (name, app) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    await c.hello(name, null, app === undefined ? {} : { app });
    return c;
  };
  try {
    assert.deepEqual(srv.network.appVersions(), {}, '刚开始一个都没有');

    await connect('旧的', '0.2.2');            // 已发布的 v0.2.2-c32 那种客户端
    await connect('也是旧的', '0.2.2');
    await connect('跟得上', APP_VERSION);      // 自己这一版：不进表
    await connect('没这个字段');               // 在这个字段存在之前构建的客户端
    await connect('自建分支', '0.2.3-custom');

    assert.deepEqual(srv.network.appVersions(), { '0.2.2': 2, unknown: 1, '0.2.3-custom': 1 });
    assert.equal(srv.network.appVersions()[APP_VERSION], undefined, '表里全是"不同步的"，自己这一版不占位');
    assert.equal(srv.network.appVersions().unknown, 1, '连自己是什么版本都说不出，这本身就是旧');

    // 改名会在活着的 socket 上重发 hello —— 那不是新客户端。
    await clients[0].hello('改个名', null, { app: '0.2.2' });
    assert.equal(srv.network.appVersions()['0.2.2'], 2, '重发 hello 不重复计数');
  } finally {
    await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  }
});

test('这张表是有界的：release 字符串来自线路，最多留 8 个，多出来的折进 (other)', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const clients = [];
  try {
    for (let i = 0; i < 12; i++) {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      await c.hello(`伪造者${i}`, null, { app: `0.0.${i}` });
    }
    const seen = srv.network.appVersions();
    assert.equal(Object.keys(seen).length, 9, '8 个真实 release + 一个 (other)');
    assert.equal(seen['(other)'], 4);
    assert.equal(seen['0.0.0'], 1);
    assert.equal(seen['0.0.7'], 1);
    assert.equal(seen['0.0.8'], undefined, '第 9 个开始不再单列');
  } finally {
    await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  }
});

test('/healthz 把这张表带出去 —— 主机唯一能看到"多少人在旧客户端上"的地方', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const clients = [];
  try {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    await c.hello('旧客户端', null, { app: '0.2.2' });

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.app, APP_VERSION, '/healthz 照旧报服务端自己的版本');
    assert.equal(body.clientApps['0.2.2'], 1, '客户端 release 也带出去');
    assert.equal(body.clientApps[APP_VERSION], undefined);

    const again = await c.hello('旧客户端改名', null, { app: '0.2.2' });
    assert.equal(typeof again.playerId, 'string', '改名照旧成功 —— 这件事不拒绝任何人');
    const after = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.equal(after.clientApps['0.2.2'], 1, '同一个 session 不重复计数');
  } finally {
    await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  }
});
