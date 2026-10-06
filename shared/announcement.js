// Server announcements (community feature): one operator-issued marquee line, broadcast to every connected client.
//
// ▸ Timing (ANNOUNCEMENT): the strip plays the text three times, 30 s per pass, with a 5 min pause after each finished
//   pass — lifetime = 3 × 30_000 + 2 × 300_000 = 690_000 ms (11 min 30 s). The server broadcasts ONE frame per
//   announcement ({ id, text, startedAt }) and never re-broadcasts: every client derives its own position from
//   announcementPhase(startedAt, now), so a player who connects (or reconnects) mid-way plays only the REMAINING
//   passes instead of the line from the top — nobody sees the same line twice because they reloaded.
//
// ▸ Clock: the frame carries the server's `startedAt`, and the client evaluates the phase against `serverNow()`
//   (store.js, fed by the pong/`welcome.serverNow` offset in net.js). All clients therefore scroll in step even when
//   their own clocks disagree — a client that trusted `Date.now()` would drift by its clock skew, up to a whole pass.
//
// ▸ Text: plain terminal text, never HTML, shell or a client command. The operator's line is stripped of control
//   characters (ANSI escapes would otherwise reach the terminal it is echoed to) and of bidi overrides (which could
//   visually rewrite the strip) by sanitizeAnnouncementText before it is stored or broadcast; the client renders it as
//   a Preact text child (escaped). The server rejects anything over ANNOUNCEMENT.maxChars; a client additionally
//   refuses an inbound frame over ANNOUNCEMENT.maxReceived, so a forged frame cannot make it lay out an essay.

/** Timing and size limits of an announcement. */
export const ANNOUNCEMENT = Object.freeze({
  passes: 3,           // how many times the text scrolls
  scrollMs: 30_000,    // one pass, left to right
  gapMs: 300_000,      // pause after each finished pass (5 min)
  maxChars: 300,       // what an operator may publish
  maxReceived: 1200,   // what a client accepts in a frame (defence in depth, not a UI limit)
});

/** Total lifetime of an announcement in ms: 3 passes + the 2 gaps between them (690_000 ms). */
export const announcementLifetime = () =>
  ANNOUNCEMENT.passes * ANNOUNCEMENT.scrollMs + (ANNOUNCEMENT.passes - 1) * ANNOUNCEMENT.gapMs;

/**
 * Where an announcement is at `now`, relative to its `startedAt`.
 *
 * @param {number} startedAt server-clock ms of the broadcast
 * @param {number} now server-clock ms (`serverNow()` on the client)
 * @returns {{ phase: 'scroll'|'gap'|'done', pass: number, waitMs: number, offsetMs?: number }}
 *   `pass` is 1-based; `waitMs` is how long until the next phase (0 when done); `offsetMs` is how far into the
 *   current pass we already are (scroll only) — it seeds the CSS animation's negative delay, so a late joiner's
 *   strip starts mid-scroll exactly where the others are.
 */
export function announcementPhase(startedAt, now) {
  const elapsed = Math.max(0, Number(now) - Number(startedAt));
  if (!Number.isFinite(elapsed) || elapsed >= announcementLifetime()) {
    return { phase: 'done', pass: ANNOUNCEMENT.passes, waitMs: 0 };
  }
  const span = ANNOUNCEMENT.scrollMs + ANNOUNCEMENT.gapMs;
  const pass = Math.floor(elapsed / span);            // 0-based
  const offsetMs = elapsed - pass * span;
  if (offsetMs < ANNOUNCEMENT.scrollMs) {
    return { phase: 'scroll', pass: pass + 1, offsetMs, waitMs: ANNOUNCEMENT.scrollMs - offsetMs };
  }
  return { phase: 'gap', pass: pass + 1, waitMs: span - offsetMs };
}

/**
 * Make terminal text safe to broadcast and render: drop control characters and bidi overrides, fold whitespace
 * (the strip is a single line), trim.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeAnnouncementText(raw) {
  return String(raw ?? '')
    // C0/C1 controls (ESC included: an ANSI sequence would otherwise run in the operator's own terminal and in any
    // log that echoes it) and the bidi formatting characters (LRO/RLO/PDF/LRI…PDI), which could reorder the strip.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `/announce …` or `公告 …` (case-insensitive); the text is everything after the first whitespace run. */
const COMMAND = /^(?:\/?announce|公告)(?:\s+([\s\S]*))?$/i;

/**
 * Parse one operator console line.
 *
 * @param {unknown} line
 * @returns {null | { action: 'help' } | { action: 'clear' } | { action: 'status' }
 *   | { action: 'publish', text: string } | { action: 'error', error: string }}
 *   `null` when the line is not an announcement command at all (the console keeps reading it as something else).
 */
export function parseAnnouncementCommand(line) {
  const raw = String(line ?? '').trim();
  const match = COMMAND.exec(raw);
  if (!match) return null;
  const text = sanitizeAnnouncementText(match[1] || '');
  if (!text || /^help$/i.test(text)) return { action: 'help' };
  if (/^clear$/i.test(text)) return { action: 'clear' };
  if (/^status$/i.test(text)) return { action: 'status' };
  // Count code points, not UTF-16 units: an emoji is one character to the operator, two to `.length`.
  if ([...text].length > ANNOUNCEMENT.maxChars) {
    return { action: 'error', error: `公告最多 ${ANNOUNCEMENT.maxChars} 个字，请缩短内容。` };
  }
  return { action: 'publish', text };
}

/** The console's usage text (`/announce help`). */
export const ANNOUNCEMENT_HELP = [
  '公告用法：',
  `  /announce <文本>   发布跑马灯公告（最多 ${ANNOUNCEMENT.maxChars} 字，${ANNOUNCEMENT.passes} 遍 × ${ANNOUNCEMENT.scrollMs / 1000} 秒，遍间隔 ${ANNOUNCEMENT.gapMs / 60_000} 分钟）`,
  '  /announce status   查看当前公告',
  '  /announce clear    清除当前公告',
  '  /announce help     显示这段帮助',
  '  公告 …             与 /announce 等价',
].join('\n');
