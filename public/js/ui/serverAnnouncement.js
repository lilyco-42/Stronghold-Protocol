// Server announcement strip — the operator's marquee line (server/announcement.js publishes, shared/announcement.js
// owns the timing rules, this file renders it).
//
// ▸ One frame, no re-broadcasts. The server sends `server.announcement` once when it publishes; from then on every
//   client positions the strip itself with announcementPhase(notice.startedAt, serverNow()) and stops on its own when
//   the lifetime runs out. `serverNow()` (store.js, fed by net.js's pong offset) — never `Date.now()` — is what keeps
//   all clients in step; a client trusting its own clock would be off by its clock skew, up to a whole pass.
//
// ▸ The component re-renders only when the PHASE changes, not every frame: `waitMs` from announcementPhase says how
//   long the current phase still lasts, and one timer wakes the component exactly then. Inside a scroll phase the
//   motion is pure CSS (one keyframe, `--sann-duration` per pass, a NEGATIVE `--sann-delay` seeding the pass offset
//   for a late joiner). So a client that joins mid-pass starts mid-scroll, in step with everybody else.
//
// ▸ `announcement: null` (an operator `clear`, or the server having none) unmounts the strip. A fresh `welcome` also
//   clears it: the frame that follows carries whatever is really current, so a reconnect can never leave a stale line
//   on screen — and if nothing follows, there is nothing to show.
//
// ▸ Safe for a match: the strip is `pointer-events: none` (clicks fall through to the game), it is a plain text child
//   (Preact escapes it, the operator's HTML is never parsed) and it lays out in the gaps the top bar leaves, pushing
//   the toasts down through the `sp-ann` class on <html> (the same trick as the connection banner's `sp-conn`).
//   `prefers-reduced-motion: reduce` swaps the marquee for a still, ellipsised line — no motion, same schedule.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { createStore, serverNow, useStore } from '../store.js';
import { useDocClass } from './device.js';
import { net } from '../net.js';
import { ANNOUNCEMENT, announcementPhase, sanitizeAnnouncementText } from '../../../shared/announcement.js';

/** The current announcement ({ id, text, startedAt }) or null. Module store: the strip is global chrome. */
export const announcementStore = createStore({ notice: null });

const selectNotice = (s) => s.notice;

/**
 * Read a `server.announcement` frame. Anything malformed, oversized or empty reads as "no announcement" — a forged
 * frame must not be able to make the client lay out an essay or keep a dead strip on screen.
 * @param {any} msg
 * @returns {{ id: string, text: string, startedAt: number } | null}
 */
export function readAnnouncement(msg) {
  const a = msg && typeof msg === 'object' ? msg.announcement : null;
  if (!a || typeof a !== 'object') return null;
  if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 64) return null;
  if (typeof a.text !== 'string' || !Number.isFinite(a.startedAt)) return null;
  const text = sanitizeAnnouncementText(a.text);
  if (!text || text.length > ANNOUNCEMENT.maxReceived) return null;
  return Object.freeze({ id: a.id, text, startedAt: a.startedAt });
}

/**
 * Wire the announcement frames into the store. Called once from main.js, before the first connect (the frame that
 * answers a hello must not be missed).
 * @param {{ net?: { on: (type: string, fn: (payload: any) => void) => (() => void) } }} [opts]
 *   `net` defaults to the app's socket (the shape matches installLoadoutSync({ net })).
 * @returns {() => void} unsubscribe
 */
export function installAnnouncements({ net: netLike = net } = {}) {
  const offFrame = netLike.on('server.announcement', (msg) => {
    announcementStore.set({ notice: readAnnouncement(msg) });
  });
  // A welcome precedes the re-push of a resumed session, so clearing here can never race the frame that follows it.
  const offWelcome = netLike.on('welcome', () => announcementStore.set({ notice: null }));
  return () => { offFrame(); offWelcome(); };
}

/** The marquee strip. Mount once, near the app root (main.js). */
export function ServerAnnouncementHost() {
  const notice = useStore(selectNotice, Object.is, announcementStore);
  const [tick, setTick] = useState(0);
  const phase = notice ? announcementPhase(notice.startedAt, serverNow()) : null;
  const scrolling = !!phase && phase.phase === 'scroll';
  // While the strip shows, <html> carries sp-ann so the stylesheet can step the toasts out of its way.
  useDocClass('sp-ann', scrolling);
  const wakeIn = phase && phase.phase !== 'done' ? phase.waitMs : null;
  useEffect(() => {
    if (wakeIn == null) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), wakeIn + 20);
    return () => clearTimeout(t);
  }, [notice, tick, wakeIn]);

  if (!notice || !scrolling) return null;
  return html`<div class="sann" role="status" aria-live="polite" aria-atomic="true">
    <div class="sann__strip" key=${`${notice.id}:${phase.pass}`} style=${{
      '--sann-duration': `${ANNOUNCEMENT.scrollMs}ms`,
      '--sann-delay': `-${Math.max(0, Math.round(phase.offsetMs || 0))}ms`,
    }}>${notice.text}</div>
  </div>`;
}
