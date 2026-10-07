// test/sim/skins-unit.test.js — 时装必须一路走到队友收到的那条 UnitInfo 上。
//
// 玩家报「皮肤选了，战斗时不显示」。客户端那半（本机选择兜底、只画自己的单位）在
// test/ui/skins-battle.test.js。这条钉的是**服务器那半**：`room.skins` 同步上来之后，
// PlayerState.battleInput() 会把 skin 放进单位输入，但 Battle 部署时如果把它丢掉，
// snapshot.js 的 unitInfo 就没有 skin，队友的战场依然全是原皮 —— 同步等于白同步。
// 实测：改之前这条链断在 `_createAllyFromInput`（`u.skin` 从没被赋值）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { unitInfo } from '../../server/sim/snapshot.js';
import { makeBattle, hashOf } from '../helpers/battleHarness.js';

const skip = !hasGeneratedData() && 'no generated data (run node tools/build-data.mjs)';
const ds = getDefaultSource();

const P1 = 'chess_char_1_01_a';
const SKIN = 'char_498_inside@kitchen#2';
const mk = (playerId, seat, colOffset, units) => ({ playerId, seat, side: 'L', colOffset, units, bonds: {}, playerEffects: [] });
const run = (units) => {
  const h = makeBattle({ players: [mk('p1', 0, 0, units)], data: ds, content: 'none' });
  h.step();
  return h.b;
};
const opByUid = (b, uid) => b.allyUnits.find((u) => u.uid === uid) || null;

test('部署时 inp.skin 上了单位，并且出现在队友收到的 UnitInfo 里', { skip }, () => {
  const b = run([{ uid: 1, chessId: P1, row: 10, col: 4, skin: SKIN }]);
  const u = opByUid(b, 1);
  assert.ok(u, '单位没部署出来');
  assert.equal(u.skin, SKIN);
  assert.equal(unitInfo(u).skin, SKIN, 'snapshot 没把 skin 带出去，队友就看不到');
});

test('没选时装的单位不会被安上一个 skin', { skip }, () => {
  const b = run([{ uid: 1, chessId: P1, row: 10, col: 4 }]);
  const u = opByUid(b, 1);
  assert.ok(u);
  assert.equal(u.skin, undefined, '凭空造一个字段出来，客户端就分不清"服务器说没穿"和"服务器没说话"');
  assert.equal(unitInfo(u).skin, undefined);
});

test('时装是纯外观：穿与不穿，战场状态逐字节相同', { skip }, () => {
  const plain = run([{ uid: 1, chessId: P1, row: 10, col: 4 }]);
  const skinned = run([{ uid: 1, chessId: P1, row: 10, col: 4, skin: SKIN }]);
  for (let i = 0; i < 200; i++) { plain.step(); skinned.step(); }
  // 把 skin 这一列剔掉再比：剩下的任何一个字节不同，都说明这个"外观字段"参与了判定，
  // 那么两台客户端就会算出不同的战斗（换件衣服改伤害，是最坏的一种 bug）。
  const view = (b) => b.allyUnits.map((u) => { const i = unitInfo(u); delete i.skin; return i; });
  assert.equal(hashOf(view(skinned)), hashOf(view(plain)), 'skin 影响了战场状态');
  assert.notDeepEqual(
    skinned.allyUnits.map((u) => unitInfo(u).skin),
    plain.allyUnits.map((u) => unitInfo(u).skin),
    '前提：这两场确实只差 skin 这一列（否则上面那条相等没有意义）');
});
