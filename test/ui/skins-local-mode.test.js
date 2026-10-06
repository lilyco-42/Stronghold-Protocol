// 「客户端换皮肤」到底能不能不靠服务器？—— 这条测试把答案钉住：能，而且代价只有"队友看不到"。
//
// 背景（都是实测的）：线上服和网友服跑的都是上游代码，`shared/protocol.js` 里根本没有 `room.skins`
// （0.1.3→0.1.4 的动词表 36 vs 36，一个都没新增；`room.skins` 只存在于我们分支）。而皮肤是**纯外观**：
// 整个 `server/sim/**` 里 `skin` 只出现在 `snapshot.js` 的视图字段一次，不参与任何判定 —— 所以本机
// store 就是完整权威，自己的战场照常换皮，不需要服务器点头。
//
// 要做的是别装死：不认这个动词时不要再发一条注定被拒的请求，也不要报"错误"，而是退回 local 模式，
// 并在选择器上写清楚"仅自己可见"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// 浏览器侧的模块在 Node 里跑：只需要 storage 和 fetch 两件替身（DOM 不用，这条不渲染）。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { skinsStore, setSkins, installSkinsSync } = await import('../../public/js/ui/skins.js');

const CHESS = 'chess_char_1_01_a';
const SKIN = 'char_498_inside@kitchen#2';
const noopTimers = { setTimeout: () => 0, clearTimeout: () => {} };

/** 一台「没有 room.skins 的服务器」：verbAvailable 说不行，request 一旦被调用就记下来。 */
function serverWithoutVerb() {
  const calls = [];
  return {
    calls,
    status: 'online',
    verbAvailable: () => ({ ok: false, reason: 'server-refused' }),
    on: () => () => {},
    request: (t) => { calls.push(t); return Promise.resolve({}); },
  };
}

test('服务器不认 room.skins 时：一次请求都不发，状态记为 local', async () => {
  setSkins({ [CHESS]: SKIN });
  const net = serverWithoutVerb();
  const sync = installSkinsSync({ net, timers: noopTimers });
  await sync.flush();
  assert.deepEqual(net.calls, [], '不支持的服务器上仍然发了 room.skins');
  assert.equal(skinsStore.get().sync, 'local', `期望 local，实际 ${skinsStore.get().sync}`);
});

test('服务器认这个动词时：照常发、照常 synced（这条测试不能是只改不发的借口）', async () => {
  setSkins({ [CHESS]: SKIN });
  const calls = [];
  const net = {
    status: 'online',
    verbAvailable: () => ({ ok: true, reason: null }),
    on: () => () => {},
    request: (t) => { calls.push(t); return Promise.resolve({}); },
  };
  const sync = installSkinsSync({ net, timers: noopTimers });
  await sync.flush();
  assert.deepEqual(calls, ['room.skins'], '支持的服务器反而没收到 room.skins');
  assert.equal(skinsStore.get().sync, 'synced');
});

test('被服务器拒绝（BAD_MSG）时退回 local，不报 error', async () => {
  setSkins({ [CHESS]: SKIN });
  const net = {
    status: 'online',
    verbAvailable: () => ({ ok: true, reason: null }), // 第一次还不知道，靠这一拒来学
    on: () => () => {},
    request: () => Promise.reject(Object.assign(new Error('无效的请求'), { code: 'BAD_MSG', detail: 'unknown type room.skins' })),
  };
  const warn = console.warn; console.warn = () => {};
  const sync = installSkinsSync({ net, timers: noopTimers });
  try { await sync.flush(); } finally { console.warn = warn; }
  assert.equal(skinsStore.get().sync, 'local', '被拒之后应该说"退回本地"，而不是给用户一个错误态');
});

test('选择仍然落盘：local 模式下 localStorage 里就是玩家选的那套', async () => {
  setSkins({ [CHESS]: SKIN });
  const raw = JSON.parse(store.get('sp.pref.skins')); // store.js 给所有 pref 加 `sp.pref.` 前缀
  assert.equal(raw[CHESS], SKIN, '本地模式下选择不落盘 = 换皮肤真的没效果');
});

test('选择器把"仅自己可见"写出来', () => {
  const src = read('public/js/ui/skinPicker.js');
  assert.match(src, /data-testid="skin-local-note"/, '选择器没有本地模式的可见提示');
  assert.match(src, /s\.sync === 'local'/, '提示没有挂在 local 状态上');
  assert.match(src, /仅自己可见/, '提示文案没说明只有看得到的人是自己');
});
