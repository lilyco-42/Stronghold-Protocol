// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// Two different things live here, and keeping them apart is what makes 「按需安装」 work:
//
//   * the CATALOGUE (data/skins.json) — every skin the project knows about, installed or not: ids, names, series.
//     It carries no URLs, because a skin that is not installed has no files to point at.
//   * what is INSTALLED (data/assets.json → chars[charId].skins) — the skins whose models are actually on this
//     server. `availableSkins()` marks which is which, and the picker greys out (or offers to install) the rest.
//
// The choice itself is a plain `{ [chessId]: skinId }` map, persisted per browser in localStorage and mirrored to
// the server through `room.skins` — the same shape and the same wiring as the operator loadout (ui/loadoutSync.js),
// except that this one is PUBLIC: the server puts it in `Match.publicView().players[]`, which is how a teammate
// sees your skin.
//
// …when the server knows the verb. Every fan server and our own box run upstream code, which has no `room.skins`
// at all, so the sync degrades to LOCAL (`skinsStore.sync === 'local'`) instead of failing: skins are pure looks
// (`server/sim/**` mentions `skin` exactly once, in the view snapshot), so the local store is a complete authority
// for the player's own board. What is lost is only that teammates do not see it — and the picker says so.

import { createStore, loadPref, savePref, store } from '../store.js';
import { data } from '../data.js';

export const SKINS_PREF = 'skins';
export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

function readStored() {
  const raw = loadPref(SKINS_PREF, null);
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [chessId, skinId] of Object.entries(raw)) {
      if (typeof chessId === 'string' && typeof skinId === 'string' && skinId) out[chessId] = skinId;
    }
  }
  return out;
}

/**
 * The chosen skins (per browser), the sync state, and the skin currently being installed — kept apart from the
 * app store for the same reason the loadout is.
 */
export const skinsStore = createStore({ entries: readStored(), sync: 'idle' });

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(SKINS_PREF, next);
  skinsStore.set({ entries: next });
}

/** Choose a skin for one operator. */
export function setSkin(chessId, skinId) {
  setSkins({ ...skinsStore.get().entries, [chessId]: skinId });
}

/** Drop one operator's choice (it goes back to its default model). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  setSkins(next);
}

/** The skin this browser picked for an operator, or null. */
export const skinFor = (chessId) => skinsStore.get().entries[chessId] || null;

/**
 * The skin a **battlefield unit** should draw with, when the server did not say (`UnitInfo.skin` absent).
 *
 * Why this exists: `skin` reaches a unit only through the server (`PlayerState.skins` → `snapshot.js`), and
 * `room.skins` is our branch's verb — the live box and every fan server run upstream, where the word does not
 * exist at all (measured on an `upstream/master` worktree: `grep -rn skin server/ shared/protocol.js` → no hit).
 * So on those servers `UnitInfo.skin` is never set and the battlefield drew the default model no matter what the
 * player picked: the picker and the prep board looked right because `pieceInfo` falls back to `skinFor(baseId)`.
 *
 * The fallback therefore mirrors `pieceInfo`, with one addition: **only my own units**. The local store holds my
 * picks, so applying them to a teammate's 能天使 would be inventing a choice nobody made. When the server does
 * send a skin, that value wins (it means the server knows the verb, so teammates see it too).
 *
 * @param {{ side?: string, kind?: string, ownerId?: string|null, defId?: string|null }|null} info a UnitInfo
 * @returns {string|null} the installed skinId to draw, or null for the default model
 */
export function skinForUnit(info) {
  if (!info || info.side !== 'ally' || info.kind !== 'op') return null;
  const me = store.get().me?.playerId ?? null;
  if (me == null || info.ownerId !== me) return null;
  const rec = data.lookup('chess', info.defId);
  // 选择存在基础卡上，战场上可能是精锐 / 模组形态 —— 同 PlayerState.js 的 `skins[baseId] || skins[piece.id]`
  const picked = skinFor(rec?.baseId) || skinFor(info.defId);
  if (!picked) return null;
  // 素材没进包就不递出去：渲染器会静默退回原皮，玩家看不出为什么
  return isInstalled(rec?.charId, picked) ? picked : null;
}

/**
 * Every skin of an operator (built-in full set).
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): both data/skins.json and
 * data/assets.json are grouped per operator, while a skin *choice* is stored per chess — see ui/skinPicker.js.
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, installed: boolean }[]}
 */
export function availableSkins(charId) {
  const list = data.get('skins')?.chars?.[charId];
  if (!Array.isArray(list)) return [];
  // `installed` must come from the manifest, not from a constant: the catalogue (data/skins.json) lists every skin
  // the project KNOWS (174), while data/assets.json only carries the ones whose files are in THIS build (15 today).
  // Hardcoding true here — which is what the source fork could do, since it bundles all 174 — makes the picker offer
  // outfits with no models: the player taps one, the renderer falls back to the default, and it looks exactly like
  // 「换皮肤没效果」.
  const owned = data.get('assets')?.chars?.[charId]?.skins || {};
  return list.map((s) => ({ id: s.id, name: s.name, group: s.group || '', installed: !!owned[s.id] }));
}

/** Whether this install has the files for a skin (all 174 skins are built-in). @param {string} charId */
export function isInstalled(charId, skinId) {
  return !!data.get('assets')?.chars?.[charId]?.skins?.[skinId];
}

/** Load what the picker needs (the catalogue, and the manifest that says what is installed). */
export function loadSkinData() {
  data.load('skins').catch(() => {});
  data.load('assets').catch(() => {});
}

/**
 * Keep the server's copy of this browser's skins current.
 *
 * Mirrors installLoadoutSync, minus the sanitising: the loadout has to be checked against data/chess.json before
 * it is sent (a stale entry would be dropped by the server), whereas a skinId needs no lookup to be sent — the
 * server keeps the entries whose chess it recognises and drops the rest, and an unknown skinId is harmless.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSkinsSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pendingJson = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (skinsStore.get().sync !== sync) skinsStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || net.status !== 'online') { setState('idle'); return; }
    try {
      const skins = skinsStore.get().entries;
      const json = JSON.stringify(skins);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      // 多服务器适配：网友服和线上服都是上游 fork，没有 room.skins 这个动词。皮肤是**纯外观**
      // （整个 server/sim 里 skin 只在视图快照 snapshot.js 出现一次，不参与任何判定），所以本机 store
      // 就是权威：不认这个动词时不再发注定被拒的请求，选择照样存、自己的板子照样换皮，只是不同步给队友。
      if (typeof net.verbAvailable === 'function' && !net.verbAvailable('room.skins').ok) {
        lastSent = json;
        pendingJson = null;
        setState('local');
        return;
      }
      setState('sending');
      try {
        await net.request('room.skins', { skins });
        if (my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
      } catch (err) {
        if (my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { schedule(RETRY_MS); return; }
        console.warn('[skins] room.skins refused', code, err && err.detail);
        // 被拒 = 退回本地模式，不是错误：玩家什么都没做错，下一台支持的服务器会照常同步。
        setState('local');
      }
    } catch (e) {
      console.warn('[skins] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) schedule(); });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
    },
  };
}
