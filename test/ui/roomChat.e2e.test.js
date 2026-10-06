// test/ui/roomChat.e2e.test.js — the friend-room chat panel in headless Chrome, against the real server.
//
// Opt-in like the other browser suites: SP_E2E=1 node --test test/ui/roomChat.e2e.test.js
// Chrome path: $CHROME_PATH or the macOS default. (No public/assets needed — the panel is chrome, not the field.)
//
// ⚠ The FIRST test is the point of this file. `installChat({ net })` and `installChat(net)` are both valid syntax, both
// pass `node --check`, both pass every static import-graph check — and one of them takes the WHOLE application down at
// boot (the announcement feature shipped with exactly that mistake once). Nothing but a real page load can tell them
// apart, so the first thing this suite does is load the page and prove the app came up, and only then does it look at
// the panel.
//
// ⚠ The second lesson this file paid for: in headless Chrome a class change is NOT reflected in the layout until the
// next frame, so `is-open` can be true while the panel still computes the collapsed 330×46 box. The panel is anchored
// by its BOTTOM edge and grows upwards, so measuring in that window puts it ~400 px too low, with the input past the
// bottom of the window — and the click then lands on <html> once a real input event forces the recalc. Every helper
// that interacts with the panel therefore waits for the settled BOX, never just for the class. (A real player is
// unaffected: an input event recalculates style before it hit-tests. It is the measuring side that must wait.)
//
// Asserted (shared/chat.js rules → public/js/ui/roomChat.js + css/room-chat.css):
//   * the app boots with the chat module wired in (console clean, __SP__ present, the lobby renders),
//   * the panel mounts as a COLLAPSED pill in a co-op room and is not there at all in a solo one (a deliberate
//     difference from the benchmark: one player has nobody to talk to),
//   * expanding it, typing and sending puts our own line in the log with the time and the (我) marker,
//   * a teammate's line arrives live while the panel is COLLAPSED, badges the pill with the unread count, and shows up
//     in the collapsed preview — without the panel ever being opened,
//   * the unread badge clears when the panel is opened, and the log follows the newest line,
//   * a rate-limited send keeps the draft and says why, in words a player understands,
//   * the panel is draggable by its handle, the position persists as a FRACTION across a reload, and a window resize
//     keeps it inside the view,
//   * `/chat off` takes the panel down in an open client; `/chat on` brings it back,
//   * leaving the room takes it down, a fresh room starts empty, and a reload in the room restores the log from the
//     server (the reconnect re-push),
//   * zero console errors / failed requests throughout.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { startServer } from '../../server/index.js';
import { CHAT } from '../../shared/chat.js';
import { Client, CHROME, sleep } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const PREF_KEY = 'sp.pref.roomChatPosition';
/** The download pipeline's directories, absent in a bare checkout: reported, not failed (as in client-static.test.js). */
const OPTIONAL = /\/fonts\/|\/assets\/|\/media\//;

describe('room chat panel in the browser', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let puppeteer;
  /** @type {Client} the host: creates the rooms, owns the panel under test */
  let host;
  /** @type {Client} a second player: the one whose messages the host sees */
  let guest;

  before(async () => {
    puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    host = new Client(puppeteer, `http://127.0.0.1:${srv.port}`, 'chat-host', { prefix: 'roomchat' });
    guest = new Client(puppeteer, `http://127.0.0.1:${srv.port}`, 'chat-guest', { prefix: 'roomchat', w: 1280, h: 720 });
    // Opened once and reused: each `open()` launches a whole Chrome, and the title screen is where a test starts from.
    await host.open('');
    await guest.open('');
  });

  after(async () => {
    await host?.close();
    await guest?.close();
    await srv?.close();
    const real = [...(host?.problems ?? []), ...(guest?.problems ?? [])].filter((p) => !OPTIONAL.test(p));
    assert.deepEqual(real, [], 'no console errors / failed requests');
  });

  // ---- helpers --------------------------------------------------------------------------------------

  /**
   * Put a client back on the lobby screen: enter from the title if it never has, leave the room if it is in one. Every
   * test starts here, so no test has to know what the one before it left behind.
   */
  const toLobby = async (c, name) => {
    if (await c.page.$('.title-login')) { await c.enter(name); return; }
    if (await c.page.$('.room-screen')) await leaveRoom(c);
    await c.page.waitForSelector('.lobby-screen', { timeout: 15000 });
  };

  /** Leave the room. The host owns it, so it gets a confirm dialog first; a plain member does not. */
  const leaveRoom = async (c) => {
    await c.click('button[aria-label="离开同盟"]');
    await sleep(250);
    if (await c.page.$('.modal__actions')) await c.click('.modal__actions button', '离开');
    await c.page.waitForSelector('.lobby-screen', { timeout: 15000 });
  };

  /** Create a room from the lobby and return its code. The create button is worded per mode (独立模拟 starts at once). */
  const createRoom = async (c, mode = '同盟模拟') => {
    await c.click('.mode-card', mode);
    await c.click('.diff-card', '标准模拟');
    await c.click('.create-box button', mode === '独立模拟' ? '开始独立模拟' : '创建同盟');
    const s = await c.waitFor((st) => !!st.room?.code, 'room created');
    await c.page.waitForSelector('.room-screen', { timeout: 15000 });
    return s.room.code;
  };

  const joinRoom = async (c, code) => {
    await c.click('.join-row input');
    await c.page.keyboard.type(code);
    await c.click('.join-row button', '加入同盟');
    await c.page.waitForSelector('.room-screen', { timeout: 15000 });
  };

  /** The panel's own view of itself: what is actually on screen, not what the store holds. */
  const panel = (c = host) => c.page.evaluate(() => {
    const el = document.querySelector('.rchat');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const badge = document.querySelector('.rchat__badge');
    return {
      present: true,
      open: el.classList.contains('is-open'),
      collapsed: el.classList.contains('is-collapsed'),
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      badge: badge ? badge.textContent.trim() : null,
      pill: document.querySelector('.rchat__pill-text')?.textContent?.trim() ?? null,
      pillEmpty: !!document.querySelector('.rchat__pill-text.is-empty'),
      empty: !!document.querySelector('.rchat__empty'),
      messages: [...document.querySelectorAll('.rchat__msg')].map((m) => ({
        who: m.querySelector('.rchat__who')?.textContent ?? '',
        text: m.querySelector('.rchat__text')?.textContent ?? '',
        time: m.querySelector('.rchat__time')?.textContent ?? '',
        mine: m.classList.contains('is-mine'),
      })),
      hint: document.querySelector('.rchat__hint')?.textContent?.trim() ?? null,
      draft: document.querySelector('.rchat__input')?.value ?? null,
    };
  });

  const waitPanel = (what, c = host) => c.page.waitForSelector('.rchat', { timeout: 10000 })
    .catch(() => assert.fail(`${what}: the chat panel never appeared`));
  const waitGone = (what, c = host) => c.page.waitForFunction(() => !document.querySelector('.rchat'), { timeout: 10000 })
    .catch(() => assert.fail(`${what}: the chat panel is still on screen`));

  /**
   * The open panel is 4.6rem tall and the collapsed pill .46rem — 460 px vs 46 px at 1920×1080, so anything between
   * them is neither state. Used to tell the two apart by BOX rather than by class (see openPanel).
   */
  const PILL_MAX_H = 100;

  /**
   * Open the panel and wait until it is REALLY open — the open box, not the class.
   *
   * ⚠ Waiting for `is-open` alone is not enough under headless Chrome: the style recalc that turns the class into the
   * open BOX is deferred to the next frame, so for up to a frame the element carries `is-open` while still computing
   * the collapsed 330×46 box. Anything measured then is off by ~400 px — the panel grows upwards from an anchored
   * bottom edge, so the stale box sits far too low, with its input past the bottom of the window — and the moment a
   * real input event forces the recalc the panel jumps, so the click is hit-tested against a box that no longer
   * exists. (A real player never sees this: an input event recalculates style before it hit-tests. It is the
   * measuring side — this suite — that has to wait.)
   */
  const openPanel = async (c = host) => {
    await c.click('.rchat__pill');
    await c.page.waitForFunction((max) => {
      const p = document.querySelector('.rchat');
      return !!p && p.classList.contains('is-open') && p.getBoundingClientRect().height > max;
    }, { timeout: 5000 }, PILL_MAX_H).catch(() => assert.fail('the chat panel never settled into its open box'));
  };

  /** Collapse it again, with the same stale-layout caveat as openPanel — wait for the collapsed BOX. */
  const collapsePanel = async (c = host) => {
    await c.click('.rchat__icon');
    await c.page.waitForFunction((max) => {
      const p = document.querySelector('.rchat');
      return !!p && p.classList.contains('is-collapsed') && p.getBoundingClientRect().height < max;
    }, { timeout: 5000 }, PILL_MAX_H).catch(() => assert.fail('the chat panel never settled back into its pill'));
  };

  /**
   * Type into the input the way a player does. No line breaks: it is a single-line `<input>`, so a real player cannot
   * produce one either — what the server does with one is shared/chat.js's business, tested in test/chat.test.js.
   */
  const type = async (text, c = host) => {
    // Record focus moves, so a failure can say whether the click never reached the input (a stale-layout miss) or
    // whether the element was replaced under us.
    await c.page.evaluate(() => {
      if (globalThis.__focusLog) return;
      globalThis.__focusLog = [];
      for (const ev of ['pointerdown', 'mousedown', 'focusin']) {
        document.addEventListener(ev, (e) => { globalThis.__focusLog.push(`${ev}:${e.target.tagName}.${e.target.className}`); }, true);
      }
    });
    await c.click('.rchat__input');
    await c.page.keyboard.type(text);
    const got = await c.page.evaluate(() => document.querySelector('.rchat__input')?.value);
    if (got === text) return;
    const why = await c.page.evaluate(() => {
      const el = document.querySelector('.rchat__input');
      const p = document.querySelector('.rchat');
      const r = el?.getBoundingClientRect();
      const pr = p?.getBoundingClientRect();
      const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        panel: p ? { cls: p.className, box: `${Math.round(pr.width)}x${Math.round(pr.height)}` } : null,
        input: r ? { y: Math.round(r.y), h: Math.round(r.height) } : null,
        atPoint: at ? `${at.tagName}.${at.className}` : null,
        active: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
        focusLog: (globalThis.__focusLog ?? []).slice(-6),
      };
    });
    await c.shot('roomchat-typefail');
    assert.fail(`typing ${JSON.stringify(text)} left the input at ${JSON.stringify(got)} — ${JSON.stringify(why)}`);
  };

  /** When each client last sent, so `send` can respect the per-SESSION rate limit (see below). */
  const lastSend = new Map();

  /**
   * Click 发送 and give the round trip (send → server → broadcast back) time to land.
   *
   * ⚠ The rate limit is one message per SESSION per second, and `host` keeps one session for the whole suite: a send
   * that follows another test's send by less than CHAT.intervalMs is refused with RATE, and the test then measures the
   * limit instead of whatever it meant to measure. Wait the window out first. `force: true` skips the wait — that is
   * for the one test that IS about the limit.
   */
  const send = async (c = host, { force = false } = {}) => {
    if (!force) {
      const wait = (lastSend.get(c) ?? 0) + CHAT.intervalMs + 150 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const pt = await c.point('.rchat__send');
    if (!pt) {
      // A disabled 发送 is the interesting case, so say WHY instead of "nothing clickable"
      const info = await c.page.evaluate(() => {
        const btn = document.querySelector('.rchat__send');
        const input = document.querySelector('.rchat__input');
        const s = globalThis.__SP__.store.get();
        const r = btn?.getBoundingClientRect();
        const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
        return {
          disabled: btn?.disabled, label: btn?.textContent,
          rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          coveredBy: at ? `${at.tagName}.${at.className}` : null,
          input: input ? { disabled: input.disabled, value: input.value } : null,
          conn: s.connection.status, viewport: `${innerWidth}x${innerHeight}`,
        };
      });
      assert.fail(`发送 is not clickable — ${JSON.stringify(info)}`);
    }
    await c.page.mouse.click(pt.x, pt.y);
    lastSend.set(c, Date.now());
    await sleep(300);
  };

  // ---- the tests ------------------------------------------------------------------------------------

  test('the app boots with the chat module wired in (a real page load, not a syntax check)', async () => {
    // `open()` already waited for `globalThis.__SP__` and a `.screen`. What it cannot prove is that the chat module did
    // not blow up on the way: `installChat(net)` — an object where the signature wants `{ net }` — would throw inside
    // boot() and leave the app dead at the title screen with nothing but a console error to show for it.
    assert.ok(await host.page.evaluate(() => !!globalThis.__SP__), 'the app booted');
    assert.equal(await host.page.evaluate(() => typeof globalThis.__SP__.net?.on), 'function', 'the socket is wired');
    await host.enter('凯尔希');
    await host.page.waitForSelector('.lobby-screen', { timeout: 20000 });
    assert.deepEqual(host.problems.filter((p) => !OPTIONAL.test(p)), [], 'a clean boot');
    assert.equal((await panel()).present, false, 'nothing is drawn outside a room');
  });

  test('a co-op room mounts the panel collapsed, and a solo room does not mount it at all', async () => {
    await toLobby(host, '凯尔希');
    const code = await createRoom(host);
    assert.ok(code, 'the room has a code');
    await waitPanel('a co-op room');
    const p = await panel();
    assert.equal(p.collapsed, true, 'it starts as a pill, covering nothing');
    assert.equal(p.open, false);
    assert.equal(p.pillEmpty, true, 'nothing has been said yet');
    assert.equal(await host.visible('.room-screen'), true, 'the room screen is underneath, untouched');
    await host.shot('roomchat-collapsed');

    // solo: the panel is deliberately not rendered (the server still accepts the intent — test/chat.test.js)
    await leaveRoom(host);
    const solo = await createRoom(host, '独立模拟');
    assert.ok(solo);
    await sleep(500); // give a wrongly-rendered panel room to appear
    assert.equal((await panel()).present, false, 'a solo run has nobody to talk to');
    assert.equal(await host.visible('.room-screen'), true, 'and the room itself is fine');
    await leaveRoom(host);
  });

  test('sending a line shows it in the log with the time and the (我) marker, and clears the draft', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    assert.equal((await panel()).messages.length, 0);
    assert.equal((await panel()).empty, true, 'an invitation to talk');

    await type('  大家   好  ');
    await send();

    const p = await panel();
    assert.equal(p.messages.length, 1, JSON.stringify(p.messages));
    assert.equal(p.messages[0].text, '大家 好', 'sanitized: runs of spaces collapse, the ends are trimmed');
    assert.match(p.messages[0].who, /凯尔希/);
    assert.match(p.messages[0].who, /（我）/);
    assert.equal(p.messages[0].mine, true);
    assert.match(p.messages[0].time, /^\d{2}:\d{2}$/, 'the server time, not "just now"');
    assert.equal(p.draft, '', 'the input is cleared');
    assert.equal(p.hint, '拖动 ⠿ 可移动 · Esc 收起');
    await host.shot('roomchat-open');
  });

  test('a teammate\'s line arrives live: the pill badges it and previews it, without the panel being opened', async () => {
    await toLobby(host, '凯尔希');
    await toLobby(guest, '阿米娅');
    const code = await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    await type('第一句');
    await send();
    // …and the host goes back to playing: from here on the collapsed pill is the whole story, which is the point —
    // a line that arrives while it is collapsed has to announce itself.
    await collapsePanel();

    // the guest joins and talks; the host stays COLLAPSED
    await joinRoom(guest, code);
    await waitPanel('the guest\'s panel', guest);
    await openPanel(guest);
    await type('收到，我在', guest);
    await send(guest);

    // the guest sees both lines, its own marked
    const gp = await panel(guest);
    assert.deepEqual(gp.messages.map((m) => m.text), ['第一句', '收到，我在']);
    assert.equal(gp.messages[0].mine, false, 'the host\'s line is not ours');
    assert.equal(gp.messages[1].mine, true);

    // …and the host, still collapsed, is badged
    await host.page.waitForFunction(() => {
      const b = document.querySelector('.rchat__badge');
      return !!b && b.textContent.trim() === '1';
    }, { timeout: 8000 }).catch(() => assert.fail('the unread badge never showed a 1'));
    const collapsed = await panel();
    assert.equal(collapsed.collapsed, true, 'the host never opened it');
    assert.equal(collapsed.badge, '1');
    assert.match(collapsed.pill, /阿米娅/, 'the preview names the sender');
    assert.match(collapsed.pill, /收到，我在/);
    assert.doesNotMatch(collapsed.pill, /（我）/, 'a teammate\'s line, not our own');
    await host.shot('roomchat-unread');

    // opening it clears the badge and shows both lines, scrolled to the newest
    await openPanel();
    const opened = await panel();
    assert.equal(opened.badge, null, 'the badge is gone once it has been read');
    assert.deepEqual(opened.messages.map((m) => m.text), ['第一句', '收到，我在']);
    assert.equal(opened.messages[0].mine, true);
    assert.equal(opened.messages[1].mine, false);
    assert.equal(await host.page.evaluate(() => {
      const el = document.querySelector('.rchat__log');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    }), true, 'the log followed the newest line');
  });

  test('a rate-limited send keeps the draft and says why in plain words', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    await type('第一条');
    await send();
    assert.equal((await panel()).messages.length, 1);

    // immediately again — `force` is the point of THIS test: no waiting for the window, the server must refuse
    await type('太快了');
    await send(host, { force: true });
    const p = await panel();
    assert.equal(p.messages.length, 1, 'the refused line never entered the log');
    assert.equal(p.draft, '太快了', 'and the draft is still there — retyping it would be the insult');
    assert.match(p.hint, /发送太快了/, `the hint explains it (${p.hint})`);

    // …and it really was only the rate limit: the same draft goes through once the window has passed
    await send();
    const after = await panel();
    assert.deepEqual(after.messages.map((m) => m.text), ['第一条', '太快了']);
    assert.equal(after.draft, '');
  });

  test('the panel is draggable by its handle and the position survives a reload', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    const before = await panel();
    const grip = await host.point('.rchat__grip');
    assert.ok(grip, 'the drag handle is clickable');
    await host.drag(grip, { x: 120, y: 140 });
    await sleep(200);
    const moved = await panel();
    assert.ok(moved.x < before.x - 100, `moved left (${before.x} → ${moved.x})`);
    assert.ok(moved.y < before.y - 100, `moved up (${before.y} → ${moved.y})`);
    assert.ok(moved.x >= 0 && moved.y >= 0, 'still on screen');
    await host.shot('roomchat-dragged');

    // the anchor is a FRACTION, so it is persisted as one and survives a reload
    const saved = await host.page.evaluate((k) => globalThis.localStorage.getItem(k), PREF_KEY);
    assert.ok(saved, 'the anchor was persisted');
    const anchor = JSON.parse(saved);
    assert.ok(anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1, `an anchor, not pixels (${saved})`);
    assert.ok(anchor.x < 0.5 && anchor.y < 0.5, 'and it is the top-left one we dragged to');

    await host.page.reload({ waitUntil: 'domcontentloaded' });
    await host.page.waitForSelector('.room-screen', { timeout: 30000 });
    await waitPanel('after the reload');
    const restored = await panel();
    assert.ok(Math.abs(restored.x - moved.x) < 14, `the same place (${moved.x} → ${restored.x})`);
    assert.ok(Math.abs(restored.y - moved.y) < 14, `the same place (${moved.y} → ${restored.y})`);
  });

  test('a window resize keeps the panel inside the view (the anchor is a fraction, not an offset)', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    const grip = await host.point('.rchat__grip');
    await host.drag(grip, { x: 1920 - 60, y: 1080 - 60 }); // bottom-right corner
    await sleep(200);
    const big = await panel();
    assert.ok(big.x + big.width <= 1920, 'inside at 1920');
    assert.ok(big.y + big.height <= 1080, 'inside at 1080');

    await host.page.setViewport({ width: 1024, height: 768 });
    await sleep(500);
    const small = await panel();
    assert.ok(small.x + small.width <= 1025, `still inside at 1024 (${small.x} + ${small.width})`);
    assert.ok(small.y + small.height <= 769, `still inside at 768 (${small.y} + ${small.height})`);
    assert.ok(small.x > 1024 / 2, 'and still the right-hand side: the anchor held');
    await host.shot('roomchat-resized');

    await host.page.setViewport({ width: 1920, height: 1080 });
    await sleep(500);
    const back = await panel();
    assert.ok(Math.abs(back.x - big.x) < 14 && Math.abs(back.y - big.y) < 14, 'and back where it was');
  });

  test('/chat off takes the panel down in an open client, /chat on brings it back', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    await type('关之前');
    await send();
    assert.equal((await panel()).messages.length, 1);

    try {
      assert.equal(srv.lobby.handleCommand('/chat off').handled, true);
      // one room.state per room carries the flag — the panel goes with it
      await waitGone('/chat off');
      assert.equal(await host.visible('.room-screen'), true, 'the room itself is untouched');

      assert.equal(srv.lobby.handleCommand('/chat on').handled, true);
      await waitPanel('/chat on');
      await openPanel();
      // the log went with the panel; the server re-pushes the history on the next state it sends
      const p = await panel();
      assert.ok(p.messages.length <= 1, `a fresh log (${JSON.stringify(p.messages.map((m) => m.text))})`);
    } finally {
      srv.lobby.handleCommand('/chat on');
    }
  });

  test('leaving the room takes it down, and a fresh room starts with an empty log', async () => {
    await toLobby(host, '凯尔希');
    await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    await type('临走一句');
    await send();

    await leaveRoom(host);
    await waitGone('after leaving');

    await createRoom(host);
    await waitPanel('the new room');
    const p = await panel();
    assert.equal(p.pillEmpty, true, 'the new room\'s pill says nothing has been said');
    assert.equal(p.badge, null);
    await openPanel();
    assert.equal((await panel()).messages.length, 0, 'the previous room\'s log did not come along');
  });

  test('a reload in the room restores the log from the server (a late joiner reads the backlog)', async () => {
    await toLobby(host, '凯尔希');
    await toLobby(guest, '阿米娅');
    const code = await createRoom(host);
    await waitPanel('the room');
    await openPanel();
    await type('重连前的第一句');
    await send();

    await joinRoom(guest, code);
    await waitPanel('the guest', guest);
    await openPanel(guest);
    const seen = await panel(guest);
    assert.deepEqual(seen.messages.map((m) => m.text), ['重连前的第一句'], 'the guest read the backlog on joining');
    assert.equal(seen.badge, null, 'and a backlog is not unread');
    assert.match(seen.messages[0].who, /凯尔希/);

    // the host reloads: the reconnect re-pushes the history
    await host.page.reload({ waitUntil: 'domcontentloaded' });
    await host.page.waitForSelector('.room-screen', { timeout: 30000 });
    await waitPanel('after the reload');
    await openPanel();
    const back = await panel();
    assert.deepEqual(back.messages.map((m) => m.text), ['重连前的第一句'], 'the log came back with the session');
    assert.equal(back.messages[0].mine, true, 'and it is still ours');
    await host.shot('roomchat-reloaded');
  });
});
