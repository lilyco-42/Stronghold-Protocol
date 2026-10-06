// test/lobby-skins-share.test.js — 「队友看得到我的时装」这句话得有测试，不能只写在注释里。
//
// 实测出来的边界（2026-10-06，两个真 WebSocket 客户端）：
//   · 大厅阶段的 `room.state.seats[]` **不带** skins —— 等待界面里看不到别人穿了什么
//   · 开局之后 `m.public.players[]` 才带 `skins`，而且**同房每个人都收到**
// 也就是说换装是"进对局才生效"的共享。这条测试把这两半都钉住：少了任何一半，说明有人
// 改了 lobby.js / Match.publicView 而没意识到皮肤依赖它。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const SKINS = { chess_char_1_01_a: 'char_498_inside@kitchen#2' };

describe('room.skins 的共享边界', () => {
  let srv;
  const clients = [];
  const connect = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    return c;
  };
  const ok = async (c, msg) => {
    const r = await c.request(msg);
    assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
    return r;
  };

  before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true }); });
  after(async () => {
    for (const c of clients) await c.terminate().catch(() => {});
    await srv?.close();
  });

  test('大厅里不共享，开局后每个座位都收到 players[].skins', async () => {
    const host = await connect('甲');
    const guest = await connect('乙');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const st1 = await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(guest, { t: 'room.join', code: st1.code });
    const st2 = await guest.waitFor('room.state', (s) => s.code === st1.code && s.seats.some((x) => x && x.playerId === guest.id));

    // ① 大厅：seat 序列化里没有 skins（lobby.js 的 room.state 只给 connected/ready/isBot…）
    const hostSeat = st2.seats.find((s) => s.playerId === host.id);
    assert.ok(hostSeat, '乙没看到甲的座位');
    assert.equal(hostSeat.skins, undefined, '大厅 room.state 里冒出了 skins —— 边界变了，检查 lobby.js 的座位序列化');

    // ② 换装：房主发 room.skins，服务器接受（协议层校验在 shared/protocol.js）
    await ok(host, { t: 'room.skins', skins: SKINS });

    // ③ 开局：m.public 的 players[] 必须带上它，而且**乙**也收到
    await ok(guest, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.start' });
    for (const [who, c] of [['甲', host], ['乙', guest]]) {
      const pub = await c.waitFor('m.public', (m) => Array.isArray(m.players) && m.players.length >= 2);
      const mine = pub.players.find((p) => p.playerId === host.id);
      assert.deepEqual(mine?.skins, SKINS, `${who}收到的 m.public 里没有甲的 skins —— 队友就看不到这件时装`);
      const other = pub.players.find((p) => p.playerId === guest.id);
      assert.ok(other && (other.skins === undefined || other.skins === null), '没换过装的座位不该带 skins 字段');
    }
  });
});
