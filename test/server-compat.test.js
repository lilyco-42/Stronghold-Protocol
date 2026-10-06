// test/server-compat.test.js — 探针本身要有对照，否则它报的"没有这个动词"可能只是它自己的 bug。
//
// 这条测试存在的原因是一次真实的假阴性：探测脚本把 `rid` 传成字符串，服务器在**动词查表之前**
// 就用 `bad rid` 挡回来，于是连一台完全支持 room.skins 的本地服务器也被报成"没有"。
// 所以这里同时验三件事：✓ 的判定有效（真服务器）、✗ 的判定有效（假服务器一律 unknown type）、
// 以及对照失败时工具会自己承认结果不可信。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { startServer } from '../server/index.js';
import { clientVerbs, probeVerbs, NEGATIVE_CONTROL } from '../tools/server-compat.mjs';

test('动词清单是从代码里抓的，不是手抄的', () => {
  const v = clientVerbs();
  assert.ok(v.length >= 14, `只抓到 ${v.length} 个动词，抓取的正则大概失效了`);
  assert.ok(v.includes('room.skins'), '清单里没有 room.skins —— 那正是最需要测的一条');
  assert.ok(v.includes('room.create') && v.includes('b.result'), '常用动词缺失，抓取模式有问题');
  assert.deepEqual(v, [...v].sort(), '清单没排序，矩阵每次重跑都会抖');
});

test('阳性对照：我们自己的服务器应该 16 个全认，且阴性对照被正确报成"没有"', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const verbs = clientVerbs();
    const r = await probeVerbs(`ws://127.0.0.1:${srv.port}/ws`, verbs, { greetMs: 1200, perVerbMs: 250 });
    assert.equal(r.connected, true, `连本地服务器都没成：${r.note}`);
    assert.equal(r.controlOk, true, `阴性对照没过：${r.note}`);
    assert.deepEqual(r.unknownAnswer, [], '有动词没等到应答，矩阵会把它当"支持"');
    assert.deepEqual(r.missing, [], `我们自己的分支居然报缺：${r.missing.join(',')}`);
    assert.equal(r.present.length, verbs.length);
  } finally { await srv.close(); }
});

/** 起一台只会说"没这个类型"的假服务器，验 ✗ 那条判定路径本身有效。 */
function fakeServer(replyFor) {
  return new Promise((res) => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'hello') { sock.send(JSON.stringify({ t: 'welcome', playerId: 'p_fake', token: 't', name: '假', version: 1 })); return; }
        sock.send(JSON.stringify(replyFor(m)));
      });
    });
    http.listen(0, '127.0.0.1', () => res({ http, wss, port: http.address().port }));
  });
}

test('阴性对照：一律回 unknown type 的服务器要被报成"全都没有"，而不是报错或漏判', async () => {
  const fake = await fakeServer((m) => ({ t: 'error', rid: m.rid, code: 'BAD_MSG', msg: '无效的请求', detail: `unknown type ${m.t}` }));
  try {
    const r = await probeVerbs(`ws://127.0.0.1:${fake.port}/ws`, ['room.skins', 'room.create'], { greetMs: 600, perVerbMs: 200 });
    assert.deepEqual(r.missing.sort(), ['room.create', 'room.skins'], '✗ 的判定路径没生效');
    assert.equal(r.controlOk, true, '连假服务器都把对照判成失败，说明对照写错了');
    assert.equal(r.present.length, 0);
  } finally { fake.wss.close(); fake.http.close(); }
});

test('对照失败时工具必须自己说"不可信"，不能把假阴性当结论', async () => {
  // 这台"服务器"对所有东西都回 bad rid —— 就是那次骗过我的行为
  const fake = await fakeServer((m) => ({ t: 'error', rid: m.rid, code: 'BAD_MSG', msg: '无效的请求', detail: 'bad rid' }));
  try {
    const r = await probeVerbs(`ws://127.0.0.1:${fake.port}/ws`, ['room.skins'], { greetMs: 600, perVerbMs: 200 });
    assert.equal(r.controlOk, false, `${NEGATIVE_CONTROL} 被当成了支持的动词，对照形同虚设`);
    assert.match(r.note, /不可信/, '对照失败却没说结果不可信');
    assert.deepEqual(r.missing, [], '对照都没过，就不该还敢断言谁缺谁不缺');
  } finally { fake.wss.close(); fake.http.close(); }
});
