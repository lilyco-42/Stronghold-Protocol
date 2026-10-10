// Client-only, voluntary local training episodes. Never sends telemetry to the game server.
// The user opts in per match. Only server-acknowledged player decisions from a
// complete team victory are persisted; everything else stays in volatile memory.
const FIELDS = Object.freeze({
  'g.band': ['bandId'], 'g.bandSkip': [], 'g.buy': ['slot'], 'g.refresh': [],
  'g.freeze': [], 'g.levelUp': [], 'g.sell': ['uid'],
  'g.move': ['uid', 'to', 'dir'], 'g.equip': ['itemUid', 'targetUid', 'replaceUid'],
  'g.art': ['itemUid', 'row', 'col', 'dir'], 'g.destroy': ['uid'],
  'g.reward': ['idx'], 'g.choice': ['idx', 'choiceId'],
});
export const SCHEMA = 'sp.client-winning-decisions.v1';
export const MAX_DECISIONS = 1200;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function scalar(v) {
  return typeof v === 'string' ? v.slice(0, 80)
    : typeof v === 'number' && Number.isFinite(v) ? v
      : typeof v === 'boolean' ? v : v === null ? null : undefined;
}
function actionOf(msg) {
  if (!isObj(msg) || !Object.hasOwn(FIELDS, msg.t)) return null;
  const action = { type: msg.t };
  for (const key of FIELDS[msg.t]) {
    if (!Object.hasOwn(msg, key)) continue;
    if (key === 'to' && isObj(msg.to)) {
      // Coordinates only; never persist arbitrary client payload objects.
      action.to = Object.fromEntries(['area', 'idx', 'row', 'col'].flatMap(k =>
        scalar(msg.to[k]) === undefined ? [] : [[k, scalar(msg.to[k])]]));
    } else {
      const value = scalar(msg[key]);
      if (value !== undefined) action[key] = value;
    }
  }
  return action;
}
function unit(p) {
  if (!isObj(p)) return null;
  return { id: scalar(p.id) ?? null, kind: scalar(p.kind) ?? null, uid: scalar(p.uid) ?? null,
    row: scalar(p.row) ?? null, col: scalar(p.col) ?? null, dir: scalar(p.dir) ?? null,
    items: Array.isArray(p.items) ? p.items.slice(0, 4).map(x => scalar(x?.id) ?? null) : [] };
}
function shopItem(p) {
  return isObj(p) ? { id: scalar(p.id) ?? null, kind: scalar(p.kind) ?? null,
    price: scalar(p.price) ?? null, sold: !!p.sold, frozen: !!p.frozen } : null;
}
export function trainingSnapshot(pub, priv) {
  if (!isObj(priv) || !isObj(pub)) return null;
  return {
    round: scalar(pub.round) ?? null, phase: scalar(pub.phase) ?? null,
    difficulty: scalar(pub.difficulty) ?? null, modeId: scalar(pub.modeId) ?? null,
    funds: scalar(priv.funds) ?? null, lp: scalar(priv.lp) ?? null,
    bandId: scalar(priv.bandId) ?? null, seat: scalar(priv.seat) ?? null,
    shop: { level: scalar(priv.shop?.level) ?? null, frozen: !!priv.shop?.frozen,
      freeRefreshes: scalar(priv.shop?.freeRefreshes) ?? 0,
      slots: Array.isArray(priv.shop?.slots) ? priv.shop.slots.slice(0, 16).map(shopItem) : [] },
    hand: Array.isArray(priv.hand) ? priv.hand.slice(0, 24).map(unit) : [],
    temp: Array.isArray(priv.temp) ? priv.temp.slice(0, 24).map(unit) : [],
    board: Array.isArray(priv.board) ? priv.board.slice(0, 50).map(unit) : [],
    effects: Array.isArray(priv.effects) ? priv.effects.slice(0, 36).map(p => scalar(p?.id) ?? null) : [],
  };
}

// IndexedDB is available in browser/Electron/WebView. Retain bounded local
// successes; no credentials, room codes, names, IPs or session tokens.
const DB = 'sp-winning-policy-v1';
function database(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) { reject(Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('episodes')) req.result.createObjectStore('episodes', { keyPath: 'episodeId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || Error('IndexedDB open failed'));
  });
}
export async function saveWinningEpisode(episode, indexedDB) {
  const db = await database(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('episodes', 'readwrite');
      const store = tx.objectStore('episodes');
      store.put(episode);
      // Cap the local store to 40 completed games.
      const cursor = store.openCursor();
      const all = [];
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          all.sort((a, b) => a.savedAt - b.savedAt);
          for (const old of all.slice(0, Math.max(0, all.length - 40))) store.delete(old.episodeId);
          return;
        }
        all.push({ episodeId: c.value.episodeId, savedAt: c.value.savedAt });
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || Error('IndexedDB write aborted'));
    });
  } finally { db.close(); }
}
export async function readWinningEpisodes(indexedDB) {
  const db = await database(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('episodes', 'readonly').objectStore('episodes').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || Error('IndexedDB read failed'));
    });
  } finally { db.close(); }
}
export async function exportWinningEpisodes({ indexedDB, document = globalThis.document, URL = globalThis.URL } = {}) {
  const episodes = await readWinningEpisodes(indexedDB);
  if (!episodes.length) return 0;
  const blob = new Blob([episodes.map(e => JSON.stringify(e)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stronghold-winning-decisions.jsonl';
  a.click();
  // Revoking after a tick keeps Firefox/Safari able to finish the download.
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 5000);
  return episodes.length;
}
function uuid() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues !== 'function') throw Error('Secure random UUID unavailable');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
export class ClientWinningRecorder {
  constructor({ save = saveWinningEpisode, maxDecisions = MAX_DECISIONS, randomUUID = uuid } = {}) {
    this.save = save;
    this.maxDecisions = maxDecisions;
    this.randomUUID = randomUUID;
    this.consent = false;
    this.roomKey = null;
    this.match = null;
    this.pending = new Map();
    this.saving = new Set();
  }
  setConsent(on) {
    this.consent = !!on;
    if (!this.consent) this.discard();
    return this.consent;
  }
  discard() { this.pending.clear(); this.match = null; }
  onRoom(room) {
    const key = room?.code || null; // used only in RAM for room transitions
    if (key !== this.roomKey) {
      this.roomKey = key;
      this.setConsent(false);
    }
    if (room?.inMatch && this.consent && !this.match) this.match = {
      episodeId: this.randomUUID(), mode: room.mode, difficulty: room.difficulty,
      samples: [], truncated: false,
    };
  }
  onOutgoing(msg, state) {
    const room = state?.room;
    if (!this.consent || !room?.inMatch) return;
    this.onRoom(room);
    if (!this.match || !Number.isInteger(msg?.rid)) return;
    const action = actionOf(msg);
    if (!action || this.match.truncated) return;
    const snapshot = trainingSnapshot(state?.match?.public, state?.match?.private);
    if (!snapshot) return;
    if (this.match.samples.length + this.pending.size >= this.maxDecisions) {
      this.match.truncated = true;
      this.pending.clear();
      return;
    }
    this.pending.set(msg.rid, { state: snapshot, action });
  }
  onReply(msg) {
    if (!Number.isInteger(msg?.rid)) return;
    const row = this.pending.get(msg.rid);
    if (!row) return;
    this.pending.delete(msg.rid);
    if (msg.t === 'ok' && this.match && !this.match.truncated) this.match.samples.push(row);
  }
  onResult(result, myId) {
    const ep = this.match;
    this.setConsent(false);
    // A result replay after reload cannot generate a fake episode: no memory samples.
    if (!ep || typeof myId !== 'string' || !myId || !result || result.victory !== true || ep.truncated || !ep.samples.length ||
        !Array.isArray(result.players) || !result.players.some(p => p?.playerId === myId && !p.isBot)) return;
    const output = {
      schema: SCHEMA, episodeId: ep.episodeId, savedAt: Date.now(),
      mode: ep.mode, difficulty: ep.difficulty, seed: scalar(result.seed) ?? null,
      outcome: { victory: true, roundsPassed: scalar(result.roundsPassed) ?? null },
      samples: ep.samples,
    };
    const task = Promise.resolve().then(() => this.save(output)).catch(e => console.warn('[training] local save failed', e));
    this.saving.add(task);
    void task.finally(() => this.saving.delete(task));
  }
  async idle() { await Promise.all([...this.saving]); }
}
export const winningRecorder = new ClientWinningRecorder();
