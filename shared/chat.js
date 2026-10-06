// shared/chat.js — friend-room chat: one bounded plain-text line per player per second, with a short in-memory history
// per room (server/lobby.js `Room.chat`). Pure ESM, no Node APIs: the server and the browser share it.
//
// ▸ Length is counted in CODE POINTS, not UTF-16 units. "最多 200 字" has to mean the same thing to the counter under
//   the input, to the check that refuses the send and to the server that stores it — and an emoji is one 字. `maxInput`
//   is the UTF-16 bound (`<input maxlength>` counts units, so it must be 2× `maxLen`), `maxLen` the code-point one.
//
// ▸ Invisible characters are the whole security story here. A message is rendered as TEXT (Preact escapes it), so there
//   is no HTML to inject — but a raw control character still wrecks a terminal or a log line, a bidi override makes a
//   line read as something else entirely (the "Trojan Source" trick: `\u202e` flips the rest of the line), and
//   zero-width characters let two messages look identical while being different. All of them go, and every line-ish
//   break becomes one space, so a message is always a single line.
//
// ▸ `\u200c` / `\u200d` (ZWNJ / ZWJ) are deliberately KEPT: they are part of legitimate emoji sequences (👨‍👩‍👧) and of
//   Persian / Arabic / Indic spelling. Removing them would corrupt text that is perfectly fine.
//
// ▸ A message carries its sender's NAME as a snapshot. That is what keeps the log readable after a player leaves, and
//   what stops a rename from rewriting history (the wire value is still re-guarded on read: it is untrusted input).
//
// ▸ `mergeChat` is the single reducer for both inbound frames (`room.chat`, `room.chatHistory`). It dedupes by id, so a
//   re-pushed history after a reconnect cannot double a line, and it keys on the room code, so a frame from another room
//   is dropped instead of bleeding into this one.

/** Tunables. The defaults mirror the benchmark's (`CHAT_MAX_LEN` 200 / `CHAT_HISTORY_LIMIT` 50 / `CHAT_INTERVAL_MS` 1000). */
export const CHAT = Object.freeze({
  /** Code points of one message (what "200 字" means). */
  maxLen: 200,
  /** UTF-16 units one message may occupy on the wire / in the input (`<input maxlength>` counts units). */
  maxInput: 400,
  /** Messages a room keeps in memory and re-sends to a late joiner. */
  historyLimit: 50,
  /** Minimum gap between two messages of the same session (ms). */
  intervalMs: 1000,
  /** Code points a client will render — a guard against a rogue/old server, not a publishing limit. */
  maxReceived: 400,
  /** UTF-16 units of a message's name snapshot. */
  maxNameLen: 24,
});

/** Code points of a value (0 for anything that is not a string). */
export const chatLength = (value) => (typeof value === 'string' ? [...value].length : 0);

/** Line-ish breaks (`\t \n \v \f \r`, NEL, U+2028/9) collapse to one space. */
const BREAK_RE = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
/** Everything invisible: control characters, soft hyphen, zero-widths, bidi controls, the `\u2060-\u206f` format
 *  characters and the BOM. `\u200c` / `\u200d` are NOT here (see the header). */
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
/** Same set, applied to a name (which additionally has no reason to hold a bidi override). */
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Drop unpaired surrogates (a half-written emoji from a truncated paste, or a lone half on purpose). Written as a scan
 * rather than the usual regex: the regex needs a lookbehind, and lookbehind is a SyntaxError in Safari < 16.4, which
 * would take the whole module down for those browsers (test/client-static.test.js enforces this).
 * @param {string} s
 * @returns {string}
 */
function stripLoneSurrogates(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += s[i] + s[i + 1]; i++; } // a valid pair: one character, kept
      continue; // a high surrogate with nothing to pair with
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // a low surrogate with nothing in front of it
    out += s[i];
  }
  return out;
}

/**
 * Normalise a chat line: NFC, one space for every break, no invisible characters, no unpaired surrogates, single
 * spaces, trimmed. Returns '' for anything that is not a usable string — including one longer than `maxInput`, which is
 * refused rather than silently truncated (a 300-字 paste is a mistake to show, not to cut in half).
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeChat(value) {
  if (typeof value !== 'string' || value.length > CHAT.maxInput) return '';
  return stripLoneSurrogates(value.normalize('NFC'))
    .replace(BREAK_RE, ' ')
    .replace(STRIP_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Whether a draft may be sent: a string within both length bounds whose sanitised form still says something.
 * @param {unknown} value
 * @returns {boolean}
 */
export function validChat(value) {
  return typeof value === 'string' && value.length <= CHAT.maxInput
    && chatLength(value) <= CHAT.maxLen && sanitizeChat(value).length > 0;
}

/**
 * The display name of a message: the server's already-sanitised nickname, re-guarded because the wire is untrusted.
 * Falls back to 博士 (what the UI shows for a nameless player) when nothing printable is left.
 * @param {unknown} raw
 * @returns {string}
 */
export function readChatName(raw) {
  if (typeof raw !== 'string') return '博士';
  const s = stripLoneSurrogates(raw.normalize('NFC')).replace(NAME_STRIP_RE, '').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, CHAT.maxNameLen).join('') : '博士';
}

/**
 * Validate one message record of a `room.chat` / `room.chatHistory` frame, or null.
 * @param {any} raw
 * @returns {{ id: number, playerId: string, name: string, text: string, at: number|null } | null}
 */
export function readChatMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = raw.id;
  if (!Number.isSafeInteger(id) || id < 1) return null;
  if (typeof raw.playerId !== 'string' || raw.playerId.length === 0 || raw.playerId.length > 64) return null;
  if (typeof raw.text !== 'string') return null;
  const text = sanitizeChat(raw.text);
  if (!text || chatLength(text) > CHAT.maxReceived) return null;
  return Object.freeze({
    id,
    playerId: raw.playerId,
    name: readChatName(raw.name),
    text,
    at: Number.isFinite(raw.at) ? raw.at : null,
  });
}

/**
 * A fresh chat log for a room (or none yet).
 * @param {string|null} [code]
 * @returns {{ code: string|null, messages: { id: number, playerId: string, name: string, text: string, at: number|null }[], liveSeq: number }}
 */
export const emptyChat = (code = null) => ({ code, messages: [], liveSeq: 0 });

/**
 * Fold a `room.chat` (one message) or `room.chatHistory` (the log) frame into a chat log.
 *
 * `liveSeq` counts messages from OTHER players that were not in the log yet — what the collapsed pill badges as unread.
 * A history frame never bumps it: a log restored after a reconnect is not news, and neither is one a late joiner reads
 * for the first time.
 *
 * @param {any} prev the current log (anything else reads as empty)
 * @param {any} frame the inbound frame
 * @param {{ myId?: string|null, roomCode?: string|null }} [ctx] `roomCode` (when known) drops frames of another room
 * @returns {{ code: string|null, messages: any[], liveSeq: number }}
 */
export function mergeChat(prev, frame, { myId = null, roomCode = null } = {}) {
  const base = prev && typeof prev === 'object' && Array.isArray(prev.messages) ? prev : emptyChat();
  const code = frame && typeof frame === 'object' && typeof frame.code === 'string' ? frame.code : null;
  if (!code) return base;
  if (roomCode != null && code !== roomCode) return base; // a frame of a room we are not in: ignore it
  const same = base.code === code;
  const history = frame.t === 'room.chatHistory';
  const incoming = history ? frame.messages : [frame.message];
  if (!Array.isArray(incoming)) return same ? base : emptyChat(code);
  /** @type {Map<number, any>} */
  const byId = new Map();
  if (same) for (const m of base.messages) if (m && Number.isSafeInteger(m.id)) byId.set(m.id, m);
  let added = 0;
  for (const raw of incoming) {
    const m = readChatMessage(raw);
    if (!m) continue;
    if (!byId.has(m.id) && m.playerId !== myId) added++;
    byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort((a, b) => a.id - b.id);
  if (messages.length > CHAT.historyLimit) messages.splice(0, messages.length - CHAT.historyLimit);
  return { code, messages, liveSeq: (same ? base.liveSeq : 0) + (history ? 0 : added) };
}

/**
 * The line the collapsed pill previews: the newest message from a teammate, or our own newest one when nobody else has
 * spoken (a one-player room with a couple of own lines still shows a preview instead of an empty box).
 * @param {any[]} messages
 * @param {string|null} myId
 * @returns {any|null}
 */
export function latestChatPreview(messages, myId) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.playerId !== myId) return m;
  }
  return list.length ? list[list.length - 1] : null;
}

// ---- operator console commands (server/lobby.js handleCommand) -------------------------------------
//
// ▸ Why an operator command at all, when the benchmark has none: `SP_CHAT=0` only decides at boot, and the moment an
//   operator actually needs the switch is the moment a room is being spammed. `/chat off` takes effect immediately
//   (the next `room.state` broadcast hides the panel in every open client), `/chat clear` wipes the logs without
//   touching the players. Both end up in the same Lobby the game uses, so there is no second source of truth.

const CHAT_COMMAND = /^(?:\/?chat|聊天)(?:\s+([\s\S]*))?$/i;

/** The `/chat` subcommands, as the console prints them. */
export const CHAT_HELP = [
  '/chat            查看聊天开关与各房间的消息数',
  '/chat off        关闭聊天：已在房间的客户端立即收起聊天框，新消息被拒绝',
  '/chat on         重新开启聊天',
  '/chat clear      清空所有房间的聊天记录（不通知客户端，重连后自然为空）',
  '/chat help       显示本帮助',
].join('\n');

/**
 * Parse one operator console line.
 * @param {unknown} line
 * @returns {{ action: 'status'|'help'|'on'|'off'|'clear' } | { action: 'error', error: string } | null}
 *   null when the line is not a chat command at all (the console may offer it to something else).
 */
export function parseChatCommand(line) {
  const m = CHAT_COMMAND.exec(String(line ?? '').trim());
  if (!m) return null;
  const arg = String(m[1] ?? '').trim().toLowerCase();
  if (!arg || arg === 'status' || arg === '状态') return { action: 'status' };
  if (arg === 'help' || arg === '帮助' || arg === '?' || arg === '-h' || arg === '--help') return { action: 'help' };
  if (arg === 'on' || arg === '开') return { action: 'on' };
  if (arg === 'off' || arg === '关') return { action: 'off' };
  if (arg === 'clear' || arg === '清空') return { action: 'clear' };
  return { action: 'error', error: `未知的聊天子命令「${arg.slice(0, 32)}」，输入 /chat help 查看用法。` };
}
