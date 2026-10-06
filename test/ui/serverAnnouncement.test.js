// test/ui/serverAnnouncement.test.js — the client half of the marquee announcement: what a `server.announcement` frame
// is allowed to put on screen, and how the wiring reacts to a hello.
//
// The component itself is checked in the browser (test/ui/serverAnnouncement.e2e.test.js, SP_E2E=1) — this file covers
// the two pieces that are pure logic and can be driven in Node: readAnnouncement (a forged or oversized frame must not
// make the client lay out an essay, keep a dead strip on screen, or hold anything but a frozen plain-text record) and
// installAnnouncements (the frame sets the notice, a welcome clears it, and unsubscribing detaches both).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANNOUNCEMENT } from '../../shared/announcement.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/ui/serverAnnouncement.js')).href);

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

const frame = (a) => ({ t: 'server.announcement', announcement: a, serverNow: 1_000_000 });
const GOOD = { id: 'a1b2c3', text: '维护通知', startedAt: 999_000 };

describe('readAnnouncement', () => {
  test('a well-formed frame becomes a frozen plain-text record', async () => {
    const { readAnnouncement } = await mod();
    const a = readAnnouncement(frame(GOOD));
    assert.deepEqual(a, GOOD);
    assert.ok(Object.isFrozen(a), 'frozen: nothing downstream may mutate what the strip renders');
    // extra fields of the frame are dropped, not carried along
    assert.deepEqual(Object.keys(readAnnouncement({ ...frame(GOOD), extra: 1, announcement: { ...GOOD, junk: true } })), ['id', 'text', 'startedAt']);
  });

  test('the text is sanitized the same way the server sanitized it', async () => {
    const { readAnnouncement } = await mod();
    assert.equal(readAnnouncement(frame({ ...GOOD, text: '  a\u0000\u202eb  ' })).text, 'a b');
  });

  test('anything malformed reads as "no announcement" (never a strip with junk in it)', async () => {
    const { readAnnouncement } = await mod();
    const bad = [
      null, undefined, 42, 'x', [], {},
      { t: 'server.announcement' },                          // no announcement field at all (a clear)
      frame(null), frame(undefined), frame('x'), frame(42), frame([]),
      frame({ ...GOOD, id: undefined }), frame({ ...GOOD, id: '' }), frame({ ...GOOD, id: 7 }),
      frame({ ...GOOD, id: 'x'.repeat(65) }),                // id longer than any the server mints
      frame({ ...GOOD, text: undefined }), frame({ ...GOOD, text: 42 }),
      frame({ ...GOOD, text: '   ' }),                       // nothing left after sanitizing
      frame({ ...GOOD, text: '\u0000\u202e' }),
      frame({ ...GOOD, startedAt: undefined }), frame({ ...GOOD, startedAt: NaN }),
      frame({ ...GOOD, startedAt: Infinity }), frame({ ...GOOD, startedAt: '999000' }),
      frame({ ...GOOD, text: 'x'.repeat(ANNOUNCEMENT.maxReceived + 1) }),
    ];
    for (const msg of bad) {
      assert.equal(readAnnouncement(msg), null, JSON.stringify(msg)?.slice(0, 80));
    }
    // exactly at the limits is still fine
    assert.ok(readAnnouncement(frame({ ...GOOD, id: 'x'.repeat(64) })));
    assert.ok(readAnnouncement(frame({ ...GOOD, text: 'x'.repeat(ANNOUNCEMENT.maxReceived) })));
  });

  test('a long line is not silently truncated into something the operator never wrote', async () => {
    const { readAnnouncement } = await mod();
    const over = readAnnouncement(frame({ ...GOOD, text: 'x'.repeat(ANNOUNCEMENT.maxChars + 50) }));
    assert.equal(over.text.length, ANNOUNCEMENT.maxChars + 50, 'accepted whole (it is under maxReceived)');
    assert.equal(readAnnouncement(frame({ ...GOOD, text: 'x'.repeat(ANNOUNCEMENT.maxReceived + 1) })), null, 'and refused whole above it');
  });
});

describe('installAnnouncements', () => {
  test('a frame sets the notice, a welcome clears it, and the unsubscribe detaches both', async () => {
    const { announcementStore, installAnnouncements } = await mod();
    announcementStore.set({ notice: null });
    const bus = fakeNet();

    const off = installAnnouncements({ net: bus });
    assert.equal(bus.count('server.announcement'), 1);
    assert.equal(bus.count('welcome'), 1);
    assert.equal(announcementStore.get().notice, null);

    bus.emit('server.announcement', frame(GOOD));
    assert.deepEqual(announcementStore.get().notice, GOOD);

    // a fresh hello clears it: the frame that follows carries whatever is really current, so a reconnect can never
    // leave a stale line on screen — and if nothing follows, there is nothing to show
    bus.emit('welcome', { playerId: 'p_1' });
    assert.equal(announcementStore.get().notice, null);

    // a malformed frame clears it too (rather than keeping the previous line)
    bus.emit('server.announcement', frame(GOOD));
    bus.emit('server.announcement', frame({ ...GOOD, text: '   ' }));
    assert.equal(announcementStore.get().notice, null);

    bus.emit('server.announcement', frame(GOOD));
    off();
    assert.equal(bus.count('server.announcement'), 0);
    assert.equal(bus.count('welcome'), 0);
    assert.deepEqual(announcementStore.get().notice, GOOD, 'detaching does not disturb what is on screen');
  });

  test('a clear frame (announcement: null) unmounts the strip', async () => {
    const { announcementStore, installAnnouncements } = await mod();
    const bus = fakeNet();
    const off = installAnnouncements({ net: bus });
    try {
      bus.emit('server.announcement', frame(GOOD));
      assert.ok(announcementStore.get().notice);
      bus.emit('server.announcement', frame(null));
      assert.equal(announcementStore.get().notice, null);
    } finally {
      off();
      announcementStore.set({ notice: null });
    }
  });

  test('it defaults to the app socket and is safe to call with nothing', async () => {
    const { installAnnouncements } = await mod();
    for (const args of [undefined, {}, { net: undefined }]) {
      const off = installAnnouncements(args);
      assert.equal(typeof off, 'function');
      off(); // detaches at once — this must not leave a listener on the real socket
    }
  });
});
