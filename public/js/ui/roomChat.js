// Friend-room chat panel — the room's plain-text channel (shared/chat.js owns the wire rules, server/lobby.js the log).
//
// ▸ Why a floating panel and not a docked column: the room screen is a seat grid over a full-width bottom bar, and the
//   match screen is a field over a shop bar with an emote wheel in one corner — there is no free column on either. A
//   small draggable overlay is the one shape that fits all of them, and it is why the panel is mounted in App's chrome
//   layer (main.js) instead of inside screens/room.js: one component, every screen, and a conversation is never cut off
//   by a route change. The benchmark reached the same conclusion (`roomChat.js` is a draggable overlay too).
//
// ▸ Collapsed at rest. The panel is a single pill that previews the newest line from a teammate and badges the unread
//   count; expanded it is a log plus an input. Nothing is covered until the player drags it somewhere — and the anchor
//   is a FRACTION of the free area rather than a pixel offset, so a resize, a rotation or a different window cannot
//   strand it off screen.
//
// ▸ The anchor is applied by the CSS, not by this file (see css/room-chat.css): `--rchat-ax` / `--rchat-ay` are the
//   fraction, and `left`/`top` + `translate(-100% * a)` place the box from it. Nothing here measures the panel for
//   positioning — `chatAnchor()` is only the inverse of that formula, used to turn a drag back into an anchor.
//
// ▸ Hidden in a solo room. One player has nobody to talk to, and a chat box with no audience is precisely the "button
//   that does nothing" this UI avoids elsewhere. The server still accepts the intent; only the panel is not rendered.
//   (Deliberate difference from the benchmark, which shows it in every chat-enabled room.)
//
// ▸ No corner-cycling button (the benchmark has one): the handle is draggable AND arrow-key operable when focused, so
//   the keyboard already has a way to move the panel. One less control in a header that has room for three.
//
// ▸ Safety: every message is rendered as TEXT (Preact escapes it) and was sanitised twice — shared/chat.js
//   sanitizeChat on the server, then readChatMessage here, because the wire is untrusted input like any other.
//
// ▸ The log is the last CHAT.historyLimit lines keyed by message id. A re-pushed history (a reconnect) therefore
//   neither duplicates a line nor re-animates anything, and a frame from another room is dropped rather than bled in.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { describeError } from './toasts.js';
import { createStore, loadPref, savePref, useStore, shallowEqual } from '../store.js';
import { net } from '../net.js';
import { CHAT, chatLength, emptyChat, latestChatPreview, mergeChat, sanitizeChat, validChat } from '../../../shared/chat.js';

/** The chat log of the room we are in. Module store: the panel is global chrome, like the announcement strip. */
export const chatStore = createStore(emptyChat());

/** Where the panel sits when the player never moved it: right edge, low — above the room / shop bar on every screen. */
export const DEFAULT_ANCHOR = Object.freeze({ x: 1, y: 0.72 });
const PREF_ANCHOR = 'roomChatPosition';
/** The margin the panel keeps from the free area's edges. Mirrors `--rchat-edge` in css/room-chat.css. */
const EDGE_PX = 8;

// ---- anchor math (pure; the position lives in the CSS, only the anchor is stored) --------------------

/**
 * Clamp an anchor into 0..1 per axis, filling a missing / non-finite axis with the default.
 * @param {{ x?: number, y?: number } | null | undefined} anchor
 * @returns {{ x: number, y: number }}
 */
export function normalizeChatAnchor(anchor) {
  const axis = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
  return { x: axis(anchor?.x, DEFAULT_ANCHOR.x), y: axis(anchor?.y, DEFAULT_ANCHOR.y) };
}

/**
 * The anchor a pixel box corresponds to — the inverse of what css/room-chat.css does with `--rchat-ax` / `--rchat-ay`
 * (`left = edge + a * (free - box)`, `translate(-100% * a)`), so dragging turns a position back into an anchor.
 *
 * `position` is the panel's own top-left as it is on screen (`getBoundingClientRect`), `size` its current box and `view`
 * the area it may use (`viewport()`). Read the box when this is called rather than caching it: the panel's size changes
 * with its state, and a stale size is exactly what would make a drag creep.
 *
 * @param {{ x: number, y: number }} position
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number, width: number, height: number }} view
 * @returns {{ x: number, y: number }}
 */
export function chatAnchor(position, size, view) {
  return normalizeChatAnchor({
    x: (position.x - view.x - EDGE_PX) / Math.max(1, view.width - size.width - EDGE_PX * 2),
    y: (position.y - view.y - EDGE_PX) / Math.max(1, view.height - size.height - EDGE_PX * 2),
  });
}

/**
 * The area a drag is measured against: the visual viewport (a phone keyboard shrinks it) minus the safe-area insets —
 * the same `--sa-*` values the CSS's `env(safe-area-inset-*)` resolves to, so `chatAnchor` and css/room-chat.css agree
 * on where the free area is. Positioning itself does not use this; only turning a drag back into an anchor does.
 */
function viewport() {
  const v = globalThis.visualViewport;
  const style = globalThis.document?.documentElement ? getComputedStyle(document.documentElement) : null;
  const inset = (edge) => Math.max(0, parseFloat(style?.getPropertyValue(`--sa-${edge}`)) || 0);
  const l = inset('l');
  const r = inset('r');
  const t = inset('t');
  const b = inset('b');
  return {
    x: (v?.offsetLeft || 0) + l,
    y: (v?.offsetTop || 0) + t,
    width: (v?.width || globalThis.innerWidth || 0) - l - r,
    height: (v?.height || globalThis.innerHeight || 0) - t - b,
  };
}

// ---- net wiring -------------------------------------------------------------------------------------

/**
 * Wire `room.chat` / `room.chatHistory` / `room.state` into chatStore. Called once from main.js.
 *
 * The room code and the local playerId are tracked here rather than read from the app store, so the module stays
 * self-contained (and testable with a fake socket): `welcome` carries the id, `room.state` the code and the
 * `chatEnabled` switch. Frames are dropped while we hold no room, which is what keeps a message of the room we just
 * left from appearing in the next one.
 *
 * @param {{ net?: { on: (type: string, fn: (payload: any) => void) => (() => void) } }} [opts]
 * @returns {() => void} unsubscribe
 */
export function installChat({ net: netLike = net } = {}) {
  /** @type {string|null} */
  let myId = null;
  /** @type {string|null} the room whose log we hold; null = no room (or chat off): frames are dropped */
  let roomCode = null;

  const reset = () => {
    roomCode = null;
    chatStore.set(emptyChat());
  };

  const offChat = netLike.on('room.chat', (msg) => {
    if (roomCode == null) return;
    chatStore.set((s) => mergeChat(s, msg, { myId, roomCode }));
  });
  const offHistory = netLike.on('room.chatHistory', (msg) => {
    if (roomCode == null) return;
    chatStore.set((s) => mergeChat(s, msg, { myId, roomCode }));
  });
  const offState = netLike.on('room.state', (msg) => {
    const code = msg && typeof msg.code === 'string' ? msg.code : null;
    if (msg?.chatEnabled !== true || code == null) { reset(); return; }
    roomCode = code;
    if (chatStore.get().code !== code) chatStore.set(emptyChat(code));
  });
  // A welcome precedes the re-push of a resumed session, and room.closed ends the room: either way what we hold is
  // about to be replaced (or is gone), so it is cleared here and rebuilt from the frames that follow.
  const offWelcome = netLike.on('welcome', (msg) => { myId = msg?.playerId ?? null; reset(); });
  const offClosed = netLike.on('room.closed', reset);
  return () => { offChat(); offHistory(); offState(); offWelcome(); offClosed(); };
}

// ---- the panel --------------------------------------------------------------------------------------

/** Wording for the send failures a player can actually hit (anything else falls back to the shared error text). */
const SEND_ERROR = {
  RATE: '发送太快了，等一秒再发',
  BAD_MSG: '消息为空或太长',
  NOT_IN_ROOM: '你已不在同盟中',
  WRONG_PHASE: '服务器已关闭聊天',
  OFFLINE: '连接已断开，稍后重试',
  DISCONNECTED: '连接已断开，稍后重试',
  TIMEOUT: '发送超时，请重试',
};
const sendErrorText = (err) => SEND_ERROR[err?.code] || describeError(err);

const hhmm = (at) => {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Whether the panel belongs on screen for a room: a co-op room on a server whose chat is on. A solo run is
 * deliberately excluded — one player has nobody to talk to, and an input box with no audience is exactly the "control
 * that does nothing" this UI avoids everywhere else. (Deliberate difference from the benchmark, which shows the panel
 * in every chat-enabled room.) The server still accepts a `room.chat` from a solo room; only the panel is not drawn.
 * @param {any} room the app store's `room` slice (a `room.state` payload, or null)
 * @returns {boolean}
 */
export function showsChat(room) {
  return !!room && room.chatEnabled === true && room.mode !== 'solo';
}

/**
 * Mount once, in App's chrome layer (main.js). Renders the panel while the player is in a chat-enabled co-op room.
 */
export function RoomChatHost() {
  const room = useStore((s) => s.room);
  if (!showsChat(room)) return null;
  return html`<${RoomChat} key=${room.code} code=${room.code} />`;
}

/**
 * The draggable chat panel of one room. Keyed by the room code, so a room change resets draft, unread and scroll
 * position along with the panel itself.
 * @param {{ code: string }} props
 */
function RoomChat({ code }) {
  // TWO stores, and they must not be confused: the log lives in this module's `chatStore` (the only thing
  // `installChat` writes), while the connection and the identity come from the app store. Reading `s.chat` off the APP
  // store compiles, renders, and is silently always empty — the app store has no `chat` key at all.
  const chat = useStore((s) => s, shallowEqual, chatStore);
  const view = useStore((s) => ({ online: s.connection.status === 'online', myId: s.me.playerId }), shallowEqual);
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const preview = latestChatPreview(messages, view.myId);
  const previewName = preview ? `${preview.name}${preview.playerId === view.myId ? '（我）' : ''}` : '';

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [behind, setBehind] = useState(false);
  const [anchor, setAnchor] = useState(() => normalizeChatAnchor(loadPref(PREF_ANCHOR, null)));
  const [area, setArea] = useState(viewport);

  const root = useRef(null);
  const log = useRef(null);
  const input = useRef(null);
  const pill = useRef(null);
  const drag = useRef(null);
  const atBottom = useRef(true);
  const lastLive = useRef(chat?.liveSeq ?? 0);
  const sending = useRef(false);
  const alive = useRef(true);
  const returnFocus = useRef(false);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // The position itself is the CSS's job (css/room-chat.css): the anchor goes out as two custom properties and the
  // panel is placed from them, so nothing here needs to know how big the panel currently is.
  const style = { '--rchat-ax': String(anchor.x), '--rchat-ay': String(anchor.y) };
  const length = chatLength(draft);
  const tooLong = length > CHAT.maxLen;

  useEffect(() => () => { alive.current = false; }, []);

  // Focus goes back to the pill when the panel collapses by keyboard / button (never on a mouse click elsewhere).
  // (useEffect, not useLayoutEffect: this vendor's hooks run layout effects from a requestAnimationFrame that is only
  // scheduled when there are passive effects too, so a layout effect is not reliably earlier — and focus is not
  // something that has to beat the paint.)
  useEffect(() => {
    if (!open && returnFocus.current) { returnFocus.current = false; pill.current?.focus?.(); }
  }, [open]);

  // Follow the visual viewport: on a phone the keyboard shrinks it, and a drag has to be measured against what is
  // actually left. (The POSITION needs no listener at all — the CSS recomputes it from the anchor on every layout.)
  useEffect(() => {
    const onResize = () => setArea(viewport());
    globalThis.addEventListener?.('resize', onResize);
    globalThis.visualViewport?.addEventListener?.('resize', onResize);
    return () => {
      globalThis.removeEventListener?.('resize', onResize);
      globalThis.visualViewport?.removeEventListener?.('resize', onResize);
    };
  }, []);

  // New lines: badge them while collapsed, follow them while open — unless the player scrolled up to read, in which
  // case nothing moves under their eyes and the 「有新消息」 button offers the jump.
  useEffect(() => {
    const delta = (chat?.liveSeq ?? 0) - lastLive.current;
    lastLive.current = chat?.liveSeq ?? 0;
    if (!open) {
      if (delta > 0) setUnread((n) => Math.min(99, n + delta));
      return;
    }
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    else if (delta > 0) setBehind(true);
  }, [chat, open]);

  const commitAnchor = () => savePref(PREF_ANCHOR, anchorRef.current);
  const move = (next, persist) => { setAnchor(next); if (persist) savePref(PREF_ANCHOR, next); };

  /**
   * The panel's box as it is on screen right now. Read on demand — never cached: the box changes with the panel's state
   * (the pill ↔ the open panel), and turning a drag into an anchor with a stale box is what would make it creep.
   */
  const boxNow = () => {
    const r = root.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  };

  // Drag by the handle, in both states (a collapsed panel parked over a button must be movable too).
  const dragStart = (e) => {
    if ((e.button != null && e.button !== 0) || drag.current) return;
    const box = boxNow();
    if (!box) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, box, anchor: anchorRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const dragMove = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // An INCREMENT on the anchor, so the drag does not care that EDGE_PX is only a close approximation of the CSS's
    // `--rchat-edge` (in rem, so it is 8 px at 1920×1080 and a few px off at other sizes — under 1% of the travel, and
    // normalizeChatAnchor clamps the ends, so the panel still lands exactly on an edge).
    const spanX = Math.max(1, area.width - d.box.width - EDGE_PX * 2);
    const spanY = Math.max(1, area.height - d.box.height - EDGE_PX * 2);
    setAnchor(normalizeChatAnchor({
      x: d.anchor.x + (e.clientX - d.x) / spanX,
      y: d.anchor.y + (e.clientY - d.y) / spanY,
    }));
  };
  const dragEnd = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    commitAnchor();
  };
  const dragCancel = () => { if (drag.current) { drag.current = null; commitAnchor(); } };

  // Keyboard equivalent of the drag (the handle is a button: it is focusable and it says so in its label).
  const moveKey = (e) => {
    const step = e.shiftKey ? 48 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    const box = boxNow();
    if (!box) return;
    move(chatAnchor({ x: box.x + delta[0], y: box.y + delta[1] }, box, area), true);
  };

  const expand = () => { atBottom.current = true; setBehind(false); setUnread(0); setOpen(true); };
  const collapse = () => { returnFocus.current = true; setOpen(false); };
  const jump = () => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setBehind(false);
  };

  const send = async (e) => {
    e?.preventDefault?.();
    if (sending.current || !view.online || !validChat(draft)) return;
    const text = sanitizeChat(draft);
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await net.request('room.chat', { text });
      // Clear only when nothing was typed meanwhile, so a fast second line is never swallowed.
      if (alive.current) { setDraft((cur) => (cur === draft ? '' : cur)); input.current?.focus?.(); }
    } catch (err) {
      // The draft stays: a refused message is retyping work nobody should have to redo.
      if (alive.current) setError(sendErrorText(err));
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const hint = error ? error
    : !view.online ? '连接已断开，重连后可继续聊天'
    : tooLong ? `消息最多 ${CHAT.maxLen} 字（当前 ${length}）`
    : '拖动 ⠿ 可移动 · Esc 收起';

  const grip = html`<button type="button" class="rchat__grip" aria-label="移动聊天框（方向键移动，Shift 加速）"
    onPointerDown=${dragStart} onPointerMove=${dragMove} onPointerUp=${dragEnd} onPointerCancel=${dragCancel}
    onLostPointerCapture=${dragCancel} onKeyDown=${moveKey}>
    <${Icon} name="dots" class="rchat__grip-icon" />
  </button>`;

  return html`<aside ref=${root} class=${`rchat${open ? ' is-open' : ' is-collapsed'}`} aria-label="同盟频道"
    style=${style}
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && open && !e.isComposing) { e.preventDefault(); collapse(); }
    }}>
    <div class="rchat__head">
      ${grip}
      ${open
        ? html`<span class="rchat__title">同盟频道<span class="rchat__code num">${code}</span></span>
            <button type="button" class="rchat__icon" aria-label="收起聊天" title="收起聊天" onClick=${collapse}><${Icon} name="minus" /></button>`
        : html`<button ref=${pill} type="button" class="rchat__pill" aria-expanded="false" onClick=${expand}
              title=${preview ? `${previewName}：${preview.text}` : '暂无消息，点击展开'}>
            <span class="rchat__pill-label"><${Icon} name="users" />同盟频道</span>
            <span class=${preview ? 'rchat__pill-text' : 'rchat__pill-text is-empty'} aria-live="polite" aria-atomic="true">
              ${preview ? `${previewName}：${preview.text}` : '暂无消息，点击展开'}
            </span>
            ${unread > 0
              ? html`<span class="rchat__badge" aria-label=${`${unread} 条未读消息`}>${unread}</span>`
              : html`<${Icon} name="plus" class="rchat__pill-plus" />`}
          </button>`}
    </div>
    ${open ? html`<div class="rchat__body">
      <div ref=${log} class="rchat__log" role="log" aria-label="聊天记录" aria-live="polite" aria-relevant="additions"
        onScroll=${(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom.current) setBehind(false);
        }}>
        ${messages.length
          ? messages.map((m) => html`<div key=${m.id} class=${`rchat__msg${m.playerId === view.myId ? ' is-mine' : ''}`}>
              <div class="rchat__meta">
                <b class="rchat__who">${m.name}${m.playerId === view.myId ? '（我）' : ''}</b>
                <time class="rchat__time num">${hhmm(m.at)}</time>
              </div>
              <p class="rchat__text">${m.text}</p>
            </div>`)
          : html`<p class="rchat__empty">开局前也能聊，和队友商量一下。</p>`}
      </div>
      ${behind ? html`<button type="button" class="rchat__jump" onClick=${jump}>有新消息 · 查看最新</button>` : null}
      <form class="rchat__form" onSubmit=${send}>
        <input ref=${input} class="rchat__input" type="text" value=${draft} maxLength=${CHAT.maxInput}
          autocomplete="off" enterkeyhint="send" placeholder=${view.online ? '和队友说点什么…' : '正在重连…'}
          disabled=${!view.online} aria-label=${`给同盟里的队友发消息，最多 ${CHAT.maxLen} 字`}
          aria-invalid=${tooLong ? 'true' : undefined}
          onInput=${(e) => { setDraft(e.currentTarget.value); if (error) setError(''); }}
          onKeyDown=${(e) => {
            // Enter sends (an IME candidate window owns Enter: isComposing, or the legacy keyCode 229)
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(e); }
          }} />
        ${length > 0 ? html`<span class=${`rchat__count num${tooLong ? ' is-over' : ''}`}>${length}/${CHAT.maxLen}</span>` : null}
        <button type="submit" class="rchat__send" disabled=${busy || !view.online || !validChat(draft)}>${busy ? '…' : '发送'}</button>
      </form>
      <div class=${`rchat__hint${error ? ' is-error' : ''}`} role="status">${hint}</div>
    </div>` : null}
  </aside>`;
}
