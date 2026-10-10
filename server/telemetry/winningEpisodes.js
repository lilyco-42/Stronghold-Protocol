// Opt-in, server-authoritative winning decisions for offline policy training.
// Only a bounded allowlist of game decisions is captured in volatile memory.
// Losers, rejected intents, player identities, reconnect tokens and chat are never stored.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const compress = promisify(gzip);
const DEFAULT_DIR = fileURLToPath(new URL('../../var/winning-episodes/', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ACTION_FIELDS = Object.freeze({
  'g.band': ['bandId'],
  'g.bandSkip': [],
  'g.buy': ['slot'],
  'g.refresh': [],
  'g.freeze': [],
  'g.levelUp': [],
  'g.sell': ['uid'],
  'g.move': ['uid', 'to', 'dir'],
  'g.equip': ['itemUid', 'targetUid', 'replaceUid'],
  'g.art': ['itemUid', 'row', 'col', 'dir'],
  'g.destroy': ['uid'],
  'g.reward': ['idx'],
  'g.choice': ['idx', 'choiceId'],
});
const MAX_ACTIONS = 1500;

function smallValue(value) {
  if (value === null) return null;
  if (typeof value === 'string') return value.length <= 100 ? value : value.slice(0, 100);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const key of ['row', 'col', 'r', 'c', 'dir', 'field', 'index']) {
      if (Object.hasOwn(value, key)) out[key] = smallValue(value[key]);
    }
    return out;
  }
  return null;
}
function piece(p) {
  return p && typeof p === 'object'
    ? { id: p.id ?? null, kind: p.kind ?? null, uid: p.uid ?? null,
        items: Array.isArray(p.items) ? p.items.slice(0, 5).map(it => it?.id ?? null) : [] }
    : null;
}
function boardEntries(board) {
  if (!(board instanceof Map)) return [];
  return [...board.entries()].slice(0, 48).map(([position, p]) => ({
    position: String(position).slice(0, 16), ...piece(p),
  }));
}
function stateOf(match, ps) {
  const shop = ps.shop || {};
  return {
    round: match.round ?? null,
    phase: match.phase ?? null,
    lp: ps.lp ?? null,
    funds: ps.funds ?? null,
    bandId: ps.bandId ?? null,
    shop: {
      level: shop.level ?? null,
      frozen: !!shop.frozen,
      freeRefreshes: shop.freeRefreshes ?? 0,
      slots: Array.isArray(shop.slots) ? shop.slots.slice(0, 16).map(s =>
        s ? { id: s.id ?? null, kind: s.kind ?? null, sold: !!s.sold,
          price: typeof ps.priceOf === 'function' ? ps.priceOf(s) : s.price ?? null } : null) : [],
    },
    hand: Array.isArray(ps.hand) ? ps.hand.slice(0, 24).map(piece) : [],
    temp: Array.isArray(ps.temp) ? ps.temp.slice(0, 24).map(piece) : [],
    board: boardEntries(ps.board),
    layers: Object.fromEntries(Object.entries(ps.layers || {}).slice(0, 48)
      .filter(([, value]) => Number.isFinite(value))),
    effects: Array.isArray(ps.effects) ? ps.effects.slice(0, 32).map(e => e?.id ?? null) : [],
  };
}

export class WinningEpisodeRecorder {
  constructor({ dir = DEFAULT_DIR, maxActions = MAX_ACTIONS, log = console } = {}) {
    this.dir = resolve(dir);
    this.maxActions = maxActions;
    this.log = log;
    this.pending = new Set();
  }

  start({ mode, difficulty, seed }) {
    return { id: randomUUID(), mode, difficulty, seed, actions: [], truncated: false, finished: false };
  }

  prepare(episode, match, playerId, msg) {
    if (!episode || episode.finished || !Object.hasOwn(ACTION_FIELDS, msg?.t)) return null;
    const ps = match?.players?.get(playerId);
    if (!ps || ps.isBot || ps.left || ps.spectator || ps.autoplay) return null;
    try {
      const action = { type: msg.t };
      for (const key of ACTION_FIELDS[msg.t]) {
        if (Object.hasOwn(msg, key)) action[key] = smallValue(msg[key]);
      }
      return { seat: ps.seat, state: stateOf(match, ps), action };
    } catch (error) {
      this.log.warn?.('[win-episodes] skipped snapshot: ' + error.message);
      return null;
    }
  }

  accept(episode, sample) {
    if (!episode || !sample || episode.finished) return;
    if (episode.actions.length >= this.maxActions) {
      episode.truncated = true;
      return;
    }
    episode.actions.push(sample);
  }

  // Called synchronously by Match.finish(), which may be inside Match.handle().
  // Defer to a microtask so the accepted final decision is included first.
  finish(episode, summary) {
    if (!episode || episode.finished || episode.finishQueued) return;
    episode.finishQueued = true;
    const victory = summary?.victory === true && summary?.reason !== 'error';
    if (!victory) {
      episode.finished = true;
      episode.actions.length = 0;
      return;
    }
    queueMicrotask(() => {
      episode.finished = true;
      if (episode.truncated || episode.actions.length === 0) {
        episode.actions.length = 0;
        return;
      }
      const data = {
        schema: 'sp.winning-decisions.v1',
        gameVersion: VERSION,
        episodeId: episode.id,
        mode: episode.mode,
        difficulty: episode.difficulty,
        seed: episode.seed,
        outcome: { victory: true, roundsPassed: summary.roundsPassed ?? null },
        samples: episode.actions.splice(0),
      };
      const job = this.save(data).catch(err => {
        this.log.error?.('[win-episodes] local spool failed: ' + err.message);
      });
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    });
  }

  async save(data) {
    const compressed = await compress(Buffer.from(JSON.stringify(data)), { level: 6 });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dest = resolve(this.dir, data.episodeId + '.json.gz');
    const temp = dest + '.tmp';
    try {
      await writeFile(temp, compressed, { flag: 'wx', mode: 0o600 });
      await rename(temp, dest);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

export function winningEpisodesFromEnv({ env = process.env, log = console } = {}) {
  if (env.SP_WIN_EPISODES !== '1') return null;
  return new WinningEpisodeRecorder({ dir: env.SP_WIN_EPISODES_DIR || DEFAULT_DIR, log });
}
