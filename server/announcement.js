// Server-side owner of the current announcement (shared/announcement.js holds the pure timing/parsing rules).
//
// ▸ State is a single record — one announcement at a time, server-wide (not per room): { id, text, startedAt }. It is
//   deliberately NOT persisted: an announcement is an operator's live notice ("服务器 22:00 维护"), and a restart
//   should not resurrect a stale one.
//
// ▸ One frame per announcement. `publish` broadcasts `server.announcement` once; every client derives its own position
//   from `startedAt` (announcementPhase) and stops on its own when the lifetime is over, so there is no per-pass
//   traffic and no "stop" frame to lose. The only other frames are the one a (re)connecting session gets in `sendTo`
//   — it carries the SAME `startedAt`, which is what makes a late joiner play only the remaining passes — and the
//   `announcement: null` a `clear` broadcasts. `sendTo` stays silent when there is nothing to restore, so a hello on a
//   quiet server costs no frame at all.
//
// ▸ Delivery is best-effort by design: `broadcast` returns how many sockets took the frame, and a socket that is
//   congested or reconnecting is simply skipped (a reconnect picks it up through sendTo). Losing the frame for a
//   player who is offline for the whole 11 min 30 s is the intended outcome, not a bug to retry around.

import { randomBytes } from 'node:crypto';
import {
  ANNOUNCEMENT, ANNOUNCEMENT_HELP, announcementLifetime, parseAnnouncementCommand, sanitizeAnnouncementText,
} from '../shared/announcement.js';
import { encode, sendRaw, sendSession } from './net.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** The announcement frame type; also listed in shared/protocol.js S2C. */
export const ANNOUNCEMENT_TYPE = 'server.announcement';

/** One announcement at a time, broadcast to every connected session. */
export class AnnouncementBoard {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   now?: () => number,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   newId?: () => string,
   * }} opts
   */
  constructor({ registry, now = Date.now, log = noopLog, newId = () => randomBytes(6).toString('hex') }) {
    this.registry = registry;
    this.now = now;
    this.log = log;
    this.newId = newId;
    /** @type {{ id: string, text: string, startedAt: number } | null} */
    this.active = null;
  }

  /** The announcement still inside its lifetime, or null (an expired one is dropped on read). */
  get current() {
    const a = this.active;
    if (!a) return null;
    if (this.now() - a.startedAt >= announcementLifetime()) { this.active = null; return null; }
    return a;
  }

  /** The frame every client keys off; `announcement: null` means "no strip" (a late joiner after a clear, or expiry). */
  frame() {
    const a = this.current;
    return {
      t: ANNOUNCEMENT_TYPE,
      announcement: a ? { id: a.id, text: a.text, startedAt: a.startedAt } : null,
      serverNow: this.now(),
    };
  }

  /**
   * Send the current announcement to one session — the late-joiner / reconnect path (lobby.onHello).
   *
   * Nothing is sent when there is no announcement: "no strip" is the client's own default state (a `welcome` clears
   * whatever it held), so an `announcement: null` frame here would be pure noise on every single hello. Only a
   * live announcement is worth restoring — and it must be, because a client that was away never saw the publish.
   *
   * @param {import('./net.js').Session} session
   * @returns {boolean} whether a frame went out
   */
  sendTo(session) {
    if (!session || !session.connected) return false;
    if (!this.current) return false;
    return sendSession(session, this.frame());
  }

  /**
   * Push the current state to every connected session.
   * @returns {number} how many sockets took the frame
   */
  broadcast() {
    const data = encode(this.frame());
    if (data == null) { this.log.error('[announce] unserializable frame'); return 0; }
    let sent = 0;
    for (const session of this.registry.byPlayerId.values()) {
      if (!session.connected) continue;
      if (sendRaw(session.ws, data)) sent++;
    }
    return sent;
  }

  /**
   * Publish `text` (already operator-supplied) and broadcast it. The text is sanitized and length-checked here, so
   * neither the console nor the admin endpoint needs to.
   * @param {unknown} rawText
   * @returns {{ ok: true, id: string, text: string, sent: number } | { ok: false, error: string }}
   */
  publish(rawText) {
    const text = sanitizeAnnouncementText(rawText);
    if (!text) return { ok: false, error: '公告内容不能为空。' };
    if ([...text].length > ANNOUNCEMENT.maxChars) {
      return { ok: false, error: `公告最多 ${ANNOUNCEMENT.maxChars} 个字，请缩短内容。` };
    }
    const a = { id: this.newId(), text, startedAt: this.now() };
    this.active = a;
    const sent = this.broadcast();
    this.log.info(`[announce] published to ${sent} client(s): ${text.slice(0, 60)}`);
    return { ok: true, id: a.id, text, sent };
  }

  /**
   * Drop the current announcement and tell every client to stop showing it.
   * @returns {{ ok: true, cleared: boolean, sent: number }}
   */
  clear() {
    const had = this.current != null;
    this.active = null;
    const sent = this.broadcast();
    this.log.info(`[announce] cleared (had one: ${had})`);
    return { ok: true, cleared: had, sent };
  }

  /**
   * Run one operator console line through the command parser.
   * @param {unknown} line
   * @returns {{ handled: boolean, lines?: string[], error?: string }}
   *   `handled: false` when the line is not an announcement command (the console may offer it to something else).
   */
  handleCommand(line) {
    const parsed = parseAnnouncementCommand(line);
    if (!parsed) return { handled: false };
    switch (parsed.action) {
      case 'help':
        return { handled: true, lines: ANNOUNCEMENT_HELP.split('\n') };
      case 'error':
        return { handled: true, error: parsed.error };
      case 'publish': {
        const res = this.publish(parsed.text);
        if (!res.ok) return { handled: true, error: res.error };
        return {
          handled: true,
          lines: [`已发布公告（${[...res.text].length} 字，${ANNOUNCEMENT.passes} 遍，共 ${Math.round(announcementLifetime() / 60_000)} 分钟）：${res.text}`,
            `已推送到 ${res.sent} 个在线客户端。`],
        };
      }
      case 'clear': {
        const res = this.clear();
        return { handled: true, lines: [res.cleared ? `已清除公告（通知了 ${res.sent} 个客户端）。` : '当前没有公告。'] };
      }
      case 'status': {
        const a = this.current;
        if (!a) return { handled: true, lines: ['当前没有公告。'] };
        const left = Math.max(0, announcementLifetime() - (this.now() - a.startedAt));
        return {
          handled: true,
          lines: [`当前公告：${a.text}`, `剩余 ${Math.floor(left / 60_000)} 分 ${Math.round((left % 60_000) / 1000)} 秒。`],
        };
      }
      default:
        return { handled: false };
    }
  }
}
