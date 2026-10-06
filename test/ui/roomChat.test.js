// test/ui/roomChat.test.js — the client half of friend-room chat: the anchor math, and what `installChat` does with
// the frames it is handed.
//
// The panel itself (drag, unread badge, collapse, Escape) is checked in the browser — test/ui/roomChat.e2e.test.js,
// SP_E2E=1. What can be driven in Node, and therefore must be, is the part where a mistake is invisible:
//
//   * the anchor math. The panel's position is a FRACTION of the free area, not a pixel offset, so a resize, a
//     rotation or a different window cannot strand it off screen. chatPosition / chatAnchor have to be exact inverses,
//     or dragging the panel would make it creep a little on every move.
//   * `showsChat` — the solo-room rule (a deliberate difference from the benchmark) and the `chatEnabled` flag, which
//     is the ONLY thing that hides the panel when an operator runs `/chat off`.
//   * `installChat`'s frame handling: which room's log is held, when it is reset, and — the part that would be a
//     silent data leak — that a frame of the room we just LEFT is dropped instead of bleeding into the next one.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT } from '../../shared/chat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/ui/roomChat.js')).href);

/** Minimal event bus shaped like net.js's `on` (returns an unsubscribe). */
function fakeNet() {
  const handlers = new Map();
  return {
    handlers,
    on(type, fn) {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    emit(type, msg) { for (const fn of [...(handlers.get(type) ?? [])]) fn(msg); },
    count: (type) => (handlers.get(type) ?? new Set()).size,
  };
}

const state = (code, chatEnabled = true) => ({ t: 'room.state', code, chatEnabled, hostId: 'p_1', mode: 'coop', seats: [], spectators: [] });
const say = (code, id, playerId, text) => ({ t: 'room.chat', code, message: { id, playerId, name: `n${playerId}`, text, at: 1000 + id } });
const history = (code, messages) => ({ t: 'room.chatHistory', code, messages });

// ---------------------------------------------------------------------------------------------------
// the anchor math
// ---------------------------------------------------------------------------------------------------

describe('chat panel anchors (public/js/ui/roomChat.js)', () => {
  const VIEW = { x: 0, y: 0, width: 1920, height: 1080 };
  const SIZE = { width: 360, height: 460 };
  /** Mirrors `--rchat-edge` in css/room-chat.css (8 px at 1920×1080, where 1 rem = 100 px). */
  const EDGE = 8;
  /**
   * The pixel box an anchor means, under the CSS's own formula — the thing `chatAnchor` has to invert:
   * `left = edge + a * (free - box)`, then `translate(-100% * a)` pulls the box back onto that point.
   */
  const boxFor = (anchor, size, view) => ({
    x: view.x + EDGE + anchor.x * (view.width - size.width - EDGE * 2),
    y: view.y + EDGE + anchor.y * (view.height - size.height - EDGE * 2),
  });

  test('normalizeChatAnchor clamps to 0..1 and fills a missing axis from the default', async () => {
    const { normalizeChatAnchor, DEFAULT_ANCHOR } = await mod();
    assert.deepEqual(normalizeChatAnchor({ x: 0.5, y: 0.25 }), { x: 0.5, y: 0.25 });
    assert.deepEqual(normalizeChatAnchor({ x: -3, y: 9 }), { x: 0, y: 1 });
    assert.deepEqual(normalizeChatAnchor({ x: 0, y: 1 }), { x: 0, y: 1 });
    // a missing / junk axis falls back rather than producing NaN, which would put the panel at `left: NaNpx`
    for (const anchor of [null, undefined, {}, { x: NaN, y: 'a' }, { x: Infinity }]) {
      const a = normalizeChatAnchor(anchor);
      assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), JSON.stringify(anchor));
      assert.deepEqual(a, { x: DEFAULT_ANCHOR.x, y: DEFAULT_ANCHOR.y });
    }
    // the default is the bottom-right corner: x = 1, y below centre, above the room / shop bar
    assert.equal(DEFAULT_ANCHOR.x, 1);
    assert.ok(DEFAULT_ANCHOR.y > 0.5 && DEFAULT_ANCHOR.y < 1);
  });

  test('chatAnchor maps the edges to 0 and 1, and the middle to 0.5', async () => {
    const { chatAnchor } = await mod();
    const EDGE = 8;
    // The formula css/room-chat.css implements with `--rchat-ax` + `translate(-100% * a)`: anchor 0 puts the panel's
    // LEFT edge at the margin, anchor 1 puts its RIGHT edge at the opposite margin, and everything between is linear.
    const spanX = VIEW.width - SIZE.width - EDGE * 2;
    const spanY = VIEW.height - SIZE.height - EDGE * 2;
    assert.deepEqual(chatAnchor({ x: EDGE, y: EDGE }, SIZE, VIEW), { x: 0, y: 0 });
    assert.deepEqual(chatAnchor({ x: EDGE + spanX, y: EDGE + spanY }, SIZE, VIEW), { x: 1, y: 1 });
    const mid = chatAnchor({ x: EDGE + spanX / 2, y: EDGE + spanY / 2 }, SIZE, VIEW);
    assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.5) < 1e-9, JSON.stringify(mid));
    // past the edges it clamps rather than leaving the anchor's range (that is where a drag ends)
    assert.deepEqual(chatAnchor({ x: -500, y: -500 }, SIZE, VIEW), { x: 0, y: 0 });
    assert.deepEqual(chatAnchor({ x: 9999, y: 9999 }, SIZE, VIEW), { x: 1, y: 1 });
  });

  test('chatAnchor round-trips in every direction (a wrong size is what would make a drag creep)', async () => {
    const { chatAnchor } = await mod();
    for (const view of [VIEW, { x: 12, y: 40, width: 1280, height: 720 }, { x: 0, y: 0, width: 900, height: 700 }]) {
      for (const size of [SIZE, { width: 330, height: 46 }, { width: 200, height: 120 }]) {
        for (const want of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }, { x: 0.13, y: 0.87 }, { x: 1, y: 0.72 }]) {
          const back = chatAnchor(boxFor(want, size, view), size, view);
          assert.ok(Math.abs(back.x - want.x) < 1e-9, `x ${want.x} -> ${back.x}`);
          assert.ok(Math.abs(back.y - want.y) < 1e-9, `y ${want.y} -> ${back.y}`);
        }
      }
    }
  });

  test('a view too small for the panel, and a degenerate box, give a finite anchor rather than NaN', async () => {
    const { chatAnchor } = await mod();
    const tiny = { x: 0, y: 0, width: 100, height: 100 };
    const a = chatAnchor({ x: EDGE, y: EDGE }, SIZE, tiny);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), JSON.stringify(a));
    assert.deepEqual(a, { x: 0, y: 0 }, 'the free area is clamped at 0, so the panel pins to the top-left');
    // a zero-sized box and a zero-sized view: the divisor is guarded, so nothing becomes Infinity
    const degenerate = chatAnchor({ x: 0, y: 0 }, { width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 });
    assert.ok(Number.isFinite(degenerate.x) && Number.isFinite(degenerate.y), JSON.stringify(degenerate));
  });

  test('the same anchor means the same relative spot at every window size', async () => {
    const { chatAnchor } = await mod();
    // bottom-right at 1920×1080 -> the anchor for it…
    const a = chatAnchor(boxFor({ x: 1, y: 1 }, SIZE, VIEW), SIZE, VIEW);
    assert.deepEqual(a, { x: 1, y: 1 });
    // …and at every other size that anchor is still the bottom-right corner, in that size's pixels
    for (const view of [{ x: 0, y: 0, width: 900, height: 700 }, { x: 0, y: 0, width: 1280, height: 720 }, VIEW]) {
      const box = boxFor(a, SIZE, view);
      assert.equal(box.x + SIZE.width, view.width - EDGE, `right edge at ${view.width}x${view.height}`);
      assert.equal(box.y + SIZE.height, view.height - EDGE, `bottom edge at ${view.width}x${view.height}`);
      assert.deepEqual(chatAnchor(box, SIZE, view), { x: 1, y: 1 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// when the panel is on screen at all
// ---------------------------------------------------------------------------------------------------

describe('showsChat (public/js/ui/roomChat.js)', () => {
  test('a chat-enabled co-op room shows it; nothing else does', async () => {
    const { showsChat } = await mod();
    assert.equal(showsChat({ code: 'ABCD', mode: 'coop', chatEnabled: true }), true);
    // the server's switch — the one thing `/chat off` changes
    assert.equal(showsChat({ code: 'ABCD', mode: 'coop', chatEnabled: false }), false);
    assert.equal(showsChat({ code: 'ABCD', mode: 'coop' }), false, 'a room.state without the flag is not a yes');
    assert.equal(showsChat({ code: 'ABCD', mode: 'coop', chatEnabled: 'true' }), false, 'only a real true');
    // the solo rule: one player has nobody to talk to
    assert.equal(showsChat({ code: 'ABCD', mode: 'solo', chatEnabled: true }), false);
    // no room at all
    for (const room of [null, undefined]) assert.equal(showsChat(room), false);
    // an unknown mode is not solo, so a future mode gets the panel rather than silently losing it
    assert.equal(showsChat({ code: 'ABCD', mode: 'future', chatEnabled: true }), true);
  });
});

// ---------------------------------------------------------------------------------------------------
// installChat — the frame wiring
// ---------------------------------------------------------------------------------------------------

describe('installChat', () => {
  beforeEach(async () => {
    const { chatStore } = await mod();
    chatStore.set({ code: null, messages: [], liveSeq: 0 });
  });

  test('it subscribes to the three frames and the two resets, and the unsubscribe detaches all five', async () => {
    const { installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    assert.equal(bus.count('room.chat'), 1);
    assert.equal(bus.count('room.chatHistory'), 1);
    assert.equal(bus.count('room.state'), 1);
    assert.equal(bus.count('welcome'), 1);
    assert.equal(bus.count('room.closed'), 1);
    off();
    for (const type of ['room.chat', 'room.chatHistory', 'room.state', 'welcome', 'room.closed']) {
      assert.equal(bus.count(type), 0, type);
    }
  });

  test('room.state is what opens the channel: its code is the room whose log we hold', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      assert.equal(chatStore.get().code, null);
      // a frame before any room is dropped (there is no log to put it in)
      bus.emit('room.chat', say('ABCD', 1, 'p_2', 'too early'));
      assert.equal(chatStore.get().messages.length, 0);

      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('ABCD'));
      assert.equal(chatStore.get().code, 'ABCD');

      bus.emit('room.chatHistory', history('ABCD', [{ id: 1, playerId: 'p_2', name: 'b', text: 'earlier' }]));
      assert.deepEqual(chatStore.get().messages.map((m) => m.text), ['earlier']);
      assert.equal(chatStore.get().liveSeq, 0, 'a backlog is not unread');

      bus.emit('room.chat', say('ABCD', 2, 'p_2', 'now'));
      assert.deepEqual(chatStore.get().messages.map((m) => m.text), ['earlier', 'now']);
      assert.equal(chatStore.get().liveSeq, 1, 'a teammate\'s live line is');
    } finally {
      off();
    }
  });

  test('our OWN messages are not unread (myId comes from welcome, not from the frame)', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('ABCD'));
      bus.emit('room.chat', say('ABCD', 1, 'p_1', 'mine'));
      assert.equal(chatStore.get().messages.length, 1, 'still in the log');
      assert.equal(chatStore.get().liveSeq, 0, 'but it does not badge');
      bus.emit('room.chat', say('ABCD', 2, 'p_2', 'theirs'));
      assert.equal(chatStore.get().liveSeq, 1);
    } finally {
      off();
    }
  });

  test('a frame of the room we just LEFT is dropped, and the new room starts empty', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 1, 'p_2', 'in A'));
      assert.equal(chatStore.get().messages.length, 1);

      // the move: a new room.state resets the log for the new code
      bus.emit('room.state', state('BBBB'));
      assert.equal(chatStore.get().code, 'BBBB');
      assert.equal(chatStore.get().messages.length, 0, 'A\'s log did not come along');

      // …and a late frame of A must not land in B (the server may still be flushing A's room)
      bus.emit('room.chat', say('AAAA', 2, 'p_2', 'late from A'));
      assert.equal(chatStore.get().messages.length, 0, 'a frame of another room is dropped');
      assert.equal(chatStore.get().code, 'BBBB');

      bus.emit('room.chat', say('BBBB', 3, 'p_2', 'in B'));
      assert.deepEqual(chatStore.get().messages.map((m) => m.text), ['in B']);
    } finally {
      off();
    }
  });

  test('the same room re-broadcasting its state does NOT wipe the log', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 1, 'p_2', 'kept'));
      // every seat change, ready toggle and match start re-broadcasts room.state
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.state', { ...state('AAAA'), seats: [{ seat: 0, playerId: 'p_1' }] });
      assert.deepEqual(chatStore.get().messages.map((m) => m.text), ['kept'], 'a re-broadcast is not a room change');
      assert.equal(chatStore.get().liveSeq, 1);
    } finally {
      off();
    }
  });

  test('chatEnabled:false (or a room.state without it) closes the channel', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 1, 'p_2', 'before'));
      assert.equal(chatStore.get().messages.length, 1);

      // `/chat off` reaches every open client as one room.state with chatEnabled:false
      bus.emit('room.state', state('AAAA', false));
      assert.equal(chatStore.get().code, null);
      assert.equal(chatStore.get().messages.length, 0, 'the panel is gone, and so is its log');
      bus.emit('room.chat', say('AAAA', 2, 'p_2', 'while off'));
      assert.equal(chatStore.get().messages.length, 0, 'and nothing arrives while it is off');

      // back on: a fresh room.state reopens it, and the history frame that follows refills it
      bus.emit('room.state', state('AAAA', true));
      assert.equal(chatStore.get().code, 'AAAA');
      bus.emit('room.chatHistory', history('AAAA', [{ id: 1, playerId: 'p_2', name: 'b', text: 'restored' }]));
      assert.deepEqual(chatStore.get().messages.map((m) => m.text), ['restored']);
    } finally {
      off();
    }
  });

  test('welcome and room.closed both clear it (a reconnect rebuilds from the frames that follow)', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 1, 'p_2', 'x'));

      // a fresh hello: whatever we hold is about to be replaced (or is gone) — the server re-pushes the state and the
      // history right after, so holding on would only risk showing a line from the session we just lost
      bus.emit('welcome', { playerId: 'p_1' });
      assert.equal(chatStore.get().code, null);
      assert.equal(chatStore.get().messages.length, 0);

      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 2, 'p_2', 'again'));
      assert.equal(chatStore.get().messages.length, 1);

      // the room ended (disbanded, expired, kicked, shutdown)
      bus.emit('room.closed', { reason: 'host_left' });
      assert.equal(chatStore.get().code, null);
      assert.equal(chatStore.get().messages.length, 0);
    } finally {
      off();
    }
  });

  test('a welcome that does not name us leaves myId unknown, so our own line badges', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', {}); // no playerId
      bus.emit('room.state', state('AAAA'));
      bus.emit('room.chat', say('AAAA', 1, 'p_1', 'is this mine?'));
      // With no id to compare against, every line counts as news. The safe direction: a spurious badge is a nudge, a
      // missing one is a message the player never notices.
      assert.equal(chatStore.get().liveSeq, 1);
    } finally {
      off();
    }
  });

  test('the log is capped at CHAT.historyLimit, oldest first, whichever frame brings it', async () => {
    const { chatStore, installChat } = await mod();
    const bus = fakeNet();
    const off = installChat({ net: bus });
    try {
      bus.emit('welcome', { playerId: 'p_1' });
      bus.emit('room.state', state('AAAA'));
      const many = Array.from({ length: CHAT.historyLimit + 5 }, (_, i) => ({ id: i + 1, playerId: 'p_2', name: 'b', text: `m${i + 1}` }));
      bus.emit('room.chatHistory', history('AAAA', many));
      assert.equal(chatStore.get().messages.length, CHAT.historyLimit);
      assert.equal(chatStore.get().messages[0].id, 6, 'the oldest five fell off');
      assert.equal(chatStore.get().messages.at(-1).id, CHAT.historyLimit + 5);
    } finally {
      off();
    }
  });

  test('it defaults to the app socket and is safe to call with nothing', async () => {
    const { installChat } = await mod();
    for (const args of [undefined, {}, { net: undefined }]) {
      const off = installChat(args);
      assert.equal(typeof off, 'function');
      off(); // detaches at once — this must not leave a listener on the real socket
    }
  });
});
