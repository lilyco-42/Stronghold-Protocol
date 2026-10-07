// test/ui/skins-battle.test.js — 玩家报的那条：「皮肤选了，干员调配里看得到，一进战斗就不显示」。
//
// 复现出来的原因（不是渲染器不行，是**战斗那条链根本没把本机选择递给渲染器**）：
// 战场单位的 `skin` 来自服务器 —— `server/match/PlayerState.js` 在自己那份 `skins` 里查到才写进 UnitInfo，
// `server/sim/snapshot.js` 再原样放进视图。而 `room.skins` 是我们分支的动词：线上服与全部网友服跑的是上游
// （实测 `grep -rn skin <upstream-worktree>/{server,shared}` **零命中**，v0.1.4 连这条链都没有），
// 所以 `u.skin` 永远缺席 → `renderInfo` 交出 `skin: null` → 战场上永远是原皮。
// 整备区/干员调配看得到，是因为那条走的是 `pieceInfo` 的 `skinFor(baseId)` 兜底（app.js:893）。
//
// 所以修法是把同一条兜底搬到战斗，但**只对我自己部署的干员**：本机 store 里没有队友的选择，
// 拿我的选择去画队友的单位是在骗人。服务器给了 `skin` 时仍以服务器为准（那说明它会同步，队友也看得见）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const prefs = new Map();
globalThis.localStorage = {
  getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
  setItem: (k, v) => prefs.set(k, String(v)),
  removeItem: (k) => prefs.delete(k),
};
// 浏览器模块在 Node 里跑：data.js 要的清单从盘上读，其余请求一律没有
globalThis.fetch = async (u) => {
  const name = String(u).replace(/^\/data\//, '').replace(/\.json$/, '');
  try { return { ok: true, status: 200, json: async () => readJson(`data/${name}.json`) }; }
  catch { return { ok: false, status: 404 }; }
};

const { store } = await import('../../public/js/store.js');
const { data, loadData } = await import('../../public/js/data.js');
const { setSkins, skinForUnit } = await import('../../public/js/ui/skins.js');
const { renderInfo } = await import('../../public/js/render/app.js');

const ME = 'p-me';
const BASE = 'chess_char_1_01_a';   // 隐现（char_498_inside），包里内置了她的 甜品大奖
const ELITE = 'chess_char_1_01_b';  // 她的精锐形态：baseId 指回 BASE
const SKIN = 'char_498_inside@kitchen#2';

await loadData('chess');
await loadData('assets');
assert.equal(data.status('chess'), 'ready', '前提：data/chess.json 读进来了，baseId 才查得到');
assert.ok(data.get('assets')?.chars?.char_498_inside?.skins?.[SKIN],
  '前提：隐现的这条时装在本包里有素材（没素材的款不该递到渲染器手里）');

/** 服务器给的 ally 单位视图字段（Battle.js `_makeAlly(ps, def, 'op', …)`；没有 room.skins 的服务器上 `skin` 这个键根本不存在）。 */
function unit(over = {}) {
  return { id: 7, kind: 'op', side: 'ally', ownerId: ME, defId: BASE, name: '隐现', tier: 1, golden: false,
    spine: 'char_498_inside', avatar: 'char_498_inside', x: 3, y: 4, facing: 1, dir: 'RIGHT', maxHp: 1000, ...over };
}

function whoami(playerId) { store.patch('me', { playerId }); }
function picked(map) { setSkins(map); }

test('前提：没这个动词的服务器确实不送 skin', () => {
  assert.equal('skin' in unit(), false, 'UnitInfo 里没有 skin 这个键');
  assert.equal(renderInfo(unit()).skin, null, '修之前：renderInfo 交出 null，战场上就是原皮');
});

test('我自己部署的干员，按本机选的时装画', () => {
  whoami(ME);
  picked({ [BASE]: SKIN });
  assert.equal(renderInfo(unit()).skin, SKIN);
});

test('精锐 / 模组形态认 baseId（选择存在基础卡上，部署出来的是变体）', () => {
  whoami(ME);
  picked({ [BASE]: SKIN });
  assert.notEqual(ELITE, BASE, '前提：这是个 baseId 指回基础卡的变体');
  assert.equal(data.lookup('chess', ELITE)?.baseId, BASE);
  assert.equal(renderInfo(unit({ defId: ELITE })).skin, SKIN, '换形态不能把时装换掉');
  assert.equal(renderInfo(unit({ defId: ELITE })).skin, renderInfo(unit({ defId: BASE })).skin);
});

test('队友的单位不套用我的选择（本机 store 里没有他的选择）', () => {
  whoami(ME);
  picked({ [BASE]: SKIN });
  assert.equal(renderInfo(unit({ ownerId: 'p-teammate' })).skin, null);
});

test('服务器给了 skin 时以服务器为准（那台会同步，队友也看得见）', () => {
  whoami(ME);
  picked({ [BASE]: SKIN });
  const other = 'char_498_inside@other#9';
  assert.equal(renderInfo(unit({ skin: other })).skin, other);
  assert.equal(renderInfo(unit({ skin: other, ownerId: 'p-teammate' })).skin, other);
});

test('敌人、召唤物、场地装置、以及还没连上服务器时一律不猜', () => {
  whoami(ME);
  picked({ [BASE]: SKIN });
  assert.equal(renderInfo(unit({ side: 'enemy', ownerId: null })).skin, null);
  assert.equal(renderInfo(unit({ kind: 'token' })).skin, null, '召唤物穿的是它自己的模型');
  assert.equal(renderInfo(unit({ kind: 'device' })).skin, null);
  whoami(null);
  assert.equal(renderInfo(unit()).skin, null, '不知道我是谁的时候不画（否则会把我的选择画到别人身上）');
  whoami(ME);
  picked({});
  assert.equal(renderInfo(unit()).skin, null, '本机没选过就是原皮');
});

test('皮肤没内置时不写进视图字段（交给渲染器兜底，不加载不存在的文件）', () => {
  whoami(ME);
  picked({ [BASE]: 'char_498_inside@没有这个款#1' });
  assert.equal(skinForUnit(unit()), null, '本机 store 里存了但素材没进包 → 不递出去');
});
