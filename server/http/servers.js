// server/http/servers.js — GET /servers.json: the servers THIS server recommends to a client's picker.
//
// WHY: the picker's "more servers" list used to be a constant compiled into the client shell (shell/picker-core.js
// COMMUNITY_SERVERS), so every time a fan server opened or died we had to ship a new client build AND bump
// SEED_VERSION to reach installs that were already out. A server that went dark stayed on the old clients' list for
// good. This endpoint moves that list to runtime: a client asks whichever server it is already talking to for
// "what else is there", and appends what comes back to the player's own editable list.
//
// Contract: docs/SERVER-LIST.md (this fork). The three rules it cannot break:
//   P1 — "not implemented" is NORMAL, not an error. No data/servers.json → 404, exactly like any absent static path,
//        and the client falls back to its built-in list. Every other server (the private community forks) will 404.
//   P2 — the response is third-party data the client must not trust; the client re-validates every entry. This side
//        only promises to emit well-formed JSON, never that an address is reachable.
//   P3 — purely additive: with no data/servers.json this server behaves exactly as before.
//
// The file is data/servers.json, next to the other JSON this repository reads from disk:
//   { "v": 1, "name": "lilyco", "servers": [ { "name": "...", "address": "...", "note?": "...", "caps?": [...] } ] }
// Absent, unreadable or malformed → 404 (never 500, never an empty object: the client can tell "no list" from
// "an empty list", and a half-parsed list would be worse than none).
//
// CORS: the response MUST carry `Access-Control-Allow-Origin: *`. A packaged client (exe / apk / ipa) renders from
// file:// or http://127.0.0.1, so this is a cross-origin read — and the picker's existing /healthz probe is a
// `no-cors` fetch that proves liveness but cannot read a body. Without this header the whole feature is silently
// dead on every packaged build (the only clue being a console CORS line). Scope it to THIS path only: /healthz and
// the static files stay as they are.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Where the list lives: data/servers.json (a file nobody has to create — absent is a valid state). */
export const SERVERS_FILE = 'servers.json';
/** The only format version this build understands (docs/SERVER-LIST.md §2). A different `v` is not served. */
export const SERVERS_FORMAT_VERSION = 1;
/** Hard cap on entries served. A client keeps at most this many too; a short list is a feature, not a bug. */
export const SERVERS_MAX = 50;
/** A name / note longer than the picker's own limits is truncated here rather than shipped and truncated 3 times. */
const NAME_MAX = 32;
const NOTE_MAX = 40;

/**
 * Validate and normalise one on-disk entry, or null when it cannot be used.
 * `address` is taken verbatim (the client re-validates it with the picker's own `addressError()`); only obvious
 * breakage — a missing or non-string field — is refused here, so a typo in one entry never hides the other 19.
 * @param {unknown} e
 */
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const r = /** @type {{ name?: unknown, address?: unknown, note?: unknown, caps?: unknown }} */ (e);
  if (typeof r.name !== 'string' || typeof r.address !== 'string') return null;
  const name = r.name.trim();
  const address = r.address.trim();
  if (!name || !address) return null;
  /** @type {{ name: string, address: string, note?: string, caps?: string[] }} */
  const out = { name: name.slice(0, NAME_MAX), address };
  if (typeof r.note === 'string' && r.note.trim()) out.note = r.note.trim().slice(0, NOTE_MAX);
  if (Array.isArray(r.caps)) {
    // Capability strings are opaque to this side: pass through the well-formed ones and drop the rest.
    // An unknown capability is the client's business to ignore (docs/SERVER-LIST.md §4.2), not an error here.
    const caps = r.caps.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 32);
    if (caps.length) out.caps = [...new Set(caps)];
  }
  return out;
}

/**
 * Parse the on-disk body. Returns the payload to serve, or null for "no usable list" (→ 404).
 * @param {string} text
 */
export function parseServers(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = /** @type {{ v?: unknown, name?: unknown, servers?: unknown }} */ (raw);
  // An unknown format version is refused outright: guessing at a shape we do not know is how old and new clients
  // start reading each other's data wrong (docs/SERVER-LIST.md §10).
  if (doc.v !== SERVERS_FORMAT_VERSION) return null;
  if (!Array.isArray(doc.servers)) return null;
  const servers = doc.servers.slice(0, SERVERS_MAX).map(cleanEntry).filter(Boolean);
  /** @type {{ v: number, servers: any[], name?: string }} */
  const out = { v: SERVERS_FORMAT_VERSION, servers };
  if (typeof doc.name === 'string' && doc.name.trim()) out.name = doc.name.trim().slice(0, NAME_MAX);
  return out;
}

/**
 * Serve GET /servers.json when `rawPath` is exactly it, else return false so the caller carries on with static files.
 * The file is read on every request (like data/, this repository reads from disk): editing data/servers.json takes
 * effect with no restart, which is the whole point of not compiling the list into the client.
 *
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawPath: string,
 *           dataDir: string, sendJson: Function, sendError: Function, log?: object }} a
 * @returns {Promise<boolean>} true when this request was answered here
 */
export async function serveServers({ req, res, rawPath, dataDir, sendJson, sendError, log }) {
  if (rawPath !== `/${SERVERS_FILE}`) return false;
  const abs = path.join(path.resolve(dataDir), SERVERS_FILE);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    // P1: no list configured is the normal case for almost every server on the network.
    sendError(req, res, 404, '页面不存在 · Not found', `/${SERVERS_FILE}`);
    return true;
  }
  const text = await fsp.readFile(abs, 'utf8').catch((e) => {
    log?.warn?.(`[servers] cannot read ${SERVERS_FILE}`, e?.message || e);
    return null;
  });
  const body = text == null ? null : parseServers(text);
  if (!body) {
    log?.warn?.(`[servers] ${SERVERS_FILE} is not a usable v${SERVERS_FORMAT_VERSION} list; answering 404`);
    sendError(req, res, 404, '页面不存在 · Not found', `/${SERVERS_FILE}`);
    return true;
  }
  // sendJson sets the body and Cache-Control: no-store; the CORS header has to be added before it writes.
  res.setHeader('Access-Control-Allow-Origin', '*');
  // The list is public and identical for everyone: let a cache hold it briefly, but no-store from sendJson wins —
  // override deliberately, because a stale server list is a support burden ("it still shows the dead server").
  sendJson(req, res, 200, body);
  return true;
}
