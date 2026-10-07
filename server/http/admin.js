// server/http/admin.js — operator endpoint for the server-wide marquee announcement.
//
// Ported from feat/server-announcement / feat/room-chat: the 0.2.0 branch inlined this in server/index.js, but 0.2.1
// split the HTTP layer into server/http/*.js, so the endpoint now lives here and is mounted by http/routes.js.
//
// Enabled only when SP_ADMIN_TOKEN is set (unset ⇒ 404: a server with no operator interface is not a broken one),
// then `Authorization: Bearer <token>` is required (compared in constant time). Body: JSON `{ text }` to publish,
// `{ action: 'clear' }` / `{ action: 'status' }`, or `{ command: '/announce …' }` — the same lines the operator
// console takes. Plain text bodies are published as-is. This is the interface a systemd deployment uses, because a
// service has no interactive stdin (server/console.js covers a foreground run).

import { createHash, timingSafeEqual } from 'node:crypto';
import { sendJson } from './common.js';

/** Where the operator posts an announcement (server/announcement.js). */
export const ADMIN_ANNOUNCE_PATH = '/admin/announce';
/** Env var holding the bearer token; the endpoint does not exist while it is unset. */
export const ADMIN_TOKEN_ENV = 'SP_ADMIN_TOKEN';
/** An announcement is at most 300 characters — 8 KB is room for a JSON envelope and a mistake. */
const ADMIN_MAX_BODY = 8 * 1024;

/**
 * Constant-time token comparison. Both sides are hashed first so the comparison runs on fixed-length buffers: a
 * length check would otherwise leak the token's length through timing.
 * @param {unknown} given @param {string} expected @returns {boolean}
 */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

/** The bearer token of a request, or null. Surrounding whitespace is not part of a credential (RFC 6750). */
function bearerOf(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Read at most `max` bytes of a request body. @returns {Promise<string>} */
async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new RangeError('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `POST /admin/announce` — publish / clear / inspect the marquee announcement.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 * @param {import('../announcement.js').AnnouncementBoard | null} board
 */
async function handleAdminAnnounce(req, res, board) {
  // Trimmed, so a stray space or newline from a hand-written EnvironmentFile does not lock the operator out — and a
  // whitespace-only value counts as unset (404), never as an endpoint nobody can reach.
  const token = (process.env[ADMIN_TOKEN_ENV] || '').trim();
  if (!token) { sendJson(req, res, 404, { ok: false, error: 'not found' }); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(req, res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  if (!tokenMatches(bearerOf(req), token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(req, res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (!board) { sendJson(req, res, 404, { ok: false, error: 'not found' }); return; }
  let body;
  try {
    body = await readBody(req, ADMIN_MAX_BODY);
  } catch {
    sendJson(req, res, 413, { ok: false, error: 'body too large' });
    return;
  }
  // A JSON envelope ({ text } / { action } / { command }), or a bare text body published as-is.
  let parsed = null;
  if (body.trim().startsWith('{')) {
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    if (parsed === null) { sendJson(req, res, 400, { ok: false, error: 'invalid json' }); return; }
  }
  // A JSON body must say what it wants; without this an empty object would fall through to a bare `/announce` (which
  // is the help text) and answer 200 to a typo.
  let command;
  if (parsed !== null) {
    if (typeof parsed.command === 'string') command = parsed.command;
    else if (parsed.action === 'clear') command = '/announce clear';
    else if (parsed.action === 'status') command = '/announce status';
    else if (typeof parsed.text === 'string') command = `/announce ${parsed.text}`;
    else {
      sendJson(req, res, 400, { ok: false, error: 'expected { text } | { action } | { command }' });
      return;
    }
  } else {
    if (!body.trim()) { sendJson(req, res, 400, { ok: false, error: 'empty body' }); return; }
    command = `/announce ${body}`;
  }
  const result = board.handleCommand(command);
  if (!result.handled) { sendJson(req, res, 400, { ok: false, error: 'unknown command' }); return; }
  if (result.error) { sendJson(req, res, 400, { ok: false, error: result.error }); return; }
  const a = board.current;
  sendJson(req, res, 200, {
    ok: true,
    announcement: a ? { id: a.id, text: a.text, startedAt: a.startAt } : null,
    message: (result.lines || []).join(' '),
  });
}

export { handleAdminAnnounce };
