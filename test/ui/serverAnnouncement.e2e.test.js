// test/ui/serverAnnouncement.e2e.test.js — the marquee announcement strip in headless Chrome, against the real server.
//
// Opt-in like the other browser suites: SP_E2E=1 node --test test/ui/serverAnnouncement.e2e.test.js
// Chrome path: $CHROME_PATH or the macOS default.
//
// ⚠ HEADLESS CHROME REPORTS `prefers-reduced-motion: reduce`. Any test that expects a CSS animation to run must
// emulate `no-preference` first, and `emulateMediaFeatures([])` does NOT undo it — the empty list means "the default",
// which here IS reduce. This suite emulates no-preference in `before` and switches to reduce only in the last test.
//
// Asserted (shared/announcement.js rules → public/js/ui/serverAnnouncement.js + css/server-announcement.css):
//   * nothing is on screen until an operator publishes; then the strip mounts, the text is the sanitized one and the
//     CSS marquee really runs (the strip's x decreases over time — not just "an animation is declared"),
//   * it never steals a click: elementFromPoint at the strip's centre is not the strip (pointer-events: none),
//   * the toasts step below it through `sp-ann` on <html> (the same trick the connection banner uses with sp-conn),
//   * a client that arrives LATE starts mid-pass: the same text, and a NEGATIVE `--sann-delay` of about the age of the
//     announcement — that is the whole point of broadcasting one frame with a `startedAt` instead of re-broadcasting,
//   * reloading the page (a fresh hello, so the server re-pushes the frame) brings it back, and after a clear no frame
//     at all is sent (checked at the protocol level, not just by looking for the element),
//   * it is chrome, not a screen: a route change does not take it down,
//   * `prefers-reduced-motion: reduce` swaps the marquee for a still, readable line (same schedule, no motion),
//   * zero console errors / failed requests throughout.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';

import { startServer, ADMIN_ANNOUNCE_PATH, ADMIN_TOKEN_ENV } from '../../server/index.js';
import { ANNOUNCEMENT } from '../../shared/announcement.js';
import { Client, CHROME, OUT, sleep } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const TOKEN = 'tok_e2e_announce';
/** 1 rem = 100 px at 1920×1080 (html { font-size: clamp(40px, min(100vw/19.2, 100svh/10.8), 240px) }). */
const TOAST_TOP = { plain: 22, withStrip: 52 };
const text = '维护通知：22:00 起停机 10 分钟';

/**
 * Record every push the client gets, on every document. Installed with `evaluateOnNewDocument` so a reload gets it
 * too: the "a cleared announcement is not restored" check then looks at the wire, not at whether an element happens
 * to be there.
 */
function recordFrames() {
  globalThis.__frames = [];
  const iv = setInterval(() => {
    if (!globalThis.__SP__?.net) return;
    clearInterval(iv);
    globalThis.__SP__.net.on('*', (m) => globalThis.__frames.push({ t: m.t, a: m.announcement ?? null }));
  }, 10);
}

describe('server announcement strip in the browser', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let puppeteer;
  let c;
  /** The last announcement the endpoint returned — the late-joiner check compares its age to the strip's offset. */
  let current = null;

  before(async () => {
    process.env[ADMIN_TOKEN_ENV] = TOKEN;
    puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    mkdirSync(OUT, { recursive: true });
    c = new Client(puppeteer, `http://127.0.0.1:${srv.port}`, 'announcement');
    await c.open('');
    await c.page.evaluateOnNewDocument(recordFrames); // for the reloads below
    await c.page.evaluate(recordFrames);              // and for this document
    await c.enter('凯尔希');
    // headless Chrome reports prefers-reduced-motion: reduce (see the header) — the marquee tests need the real thing
    await c.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  });

  after(async () => {
    await c?.close();
    await srv?.close();
    delete process.env[ADMIN_TOKEN_ENV];
    // /fonts/, /assets/ and /media/ come from the download pipeline (tools/fetch-assets.mjs) and are reported, not
    // failed, when absent — the same allowance test/client-static.test.js makes. Anything else is a real problem.
    const real = (c?.problems ?? []).filter((p) => !/\/fonts\/|\/assets\/|\/media\//.test(p));
    assert.deepEqual(real, [], 'no console errors / failed requests');
  });

  const page = () => c.page;
  /** POST /admin/announce; returns the parsed body. (Read the body ONCE — text() then json() throws.) */
  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${ADMIN_ANNOUNCE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    assert.equal(r.status, 200, raw);
    return JSON.parse(raw);
  };
  const publish = async (t) => { current = (await call({ text: t })).announcement; return current; };
  const clear = () => call({ action: 'clear' });

  const hasStrip = () => page().evaluate(() => !!document.querySelector('.sann'));
  const stripX = () => page().evaluate(() => document.querySelector('.sann__strip').getBoundingClientRect().x);
  const stripStyle = () => page().evaluate(() => {
    const el = document.querySelector('.sann__strip');
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      duration: cs.getPropertyValue('--sann-duration').trim(),
      delay: parseFloat(cs.getPropertyValue('--sann-delay')),
      text: el.textContent,
      textOverflow: cs.textOverflow,
    };
  });
  const frames = () => page().evaluate(() => globalThis.__frames || []);
  /** Wait for the strip to be mounted AND `sp-ann` on <html> (the class is set from an effect, one tick later). */
  const waitStrip = async (what = 'the strip') => {
    await page().waitForSelector('.sann', { timeout: 10000 }).catch(() => assert.fail(`${what} never appeared`));
    await page().waitForFunction(() => document.documentElement.classList.contains('sp-ann'), { timeout: 10000 });
  };
  const waitToastTop = (px) => page().waitForFunction(
    (want) => {
      const host = document.querySelector('.toast-host');
      return !!host && Math.abs(parseFloat(getComputedStyle(host).top) - want) < 1.5;
    },
    { timeout: 5000 }, px,
  ).then(() => true, () => false);

  test('nothing on screen until an operator publishes', async () => {
    await clear();
    assert.equal(await hasStrip(), false);
    assert.equal(await page().evaluate(() => document.documentElement.classList.contains('sp-ann')), false);
    assert.equal(await waitToastTop(TOAST_TOP.plain), true, 'the toasts keep their default place');
  });

  test('publishing mounts the strip, sanitizes the text and really scrolls it', async () => {
    // leading/trailing spaces and an ESC must not survive into the strip
    const a = await publish(`  \u001b[31m${text}  `);
    assert.equal(a.text, `[31m${text}`, 'the server sanitized it');
    await waitStrip();

    const st = await stripStyle();
    assert.equal(st.text, `[31m${text}`, 'rendered as plain text, exactly what the server stored');
    assert.equal(st.animationName, 'sann-scroll', 'the marquee keyframe is what is driving it');
    assert.equal(st.duration, `${ANNOUNCEMENT.scrollMs}ms`);
    assert.ok(st.delay <= 0 && st.delay > -3000, `a fresh publish starts near the beginning (${st.delay}ms)`);

    // it must not steal a click from whatever is under it
    const hit = await page().evaluate(() => {
      const el = document.querySelector('.sann');
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { pointerEvents: getComputedStyle(el).pointerEvents, inStrip: !!(at && at.closest('.sann')), at: at ? at.className : null };
    });
    assert.equal(hit.pointerEvents, 'none');
    assert.equal(hit.inStrip, false, `a click at the strip's centre lands on ${hit.at} instead`);

    // …and the toasts step below it
    assert.equal(await waitToastTop(TOAST_TOP.withStrip), true, 'the toasts moved under the strip');

    // …and the strip is genuinely moving (a declared animation is not enough — a paused one would pass that)
    const x1 = await stripX();
    await sleep(800);
    const x2 = await stripX();
    assert.ok(x2 < x1 - 5, `the marquee advanced (x ${x1} → ${x2})`);
    await sleep(1200);
    assert.ok((await stripX()) < x2 - 5, 'and keeps advancing');
  });

  test('a client that arrives late plays the remaining passes from mid-scroll', async () => {
    await sleep(2000); // let the announcement age, so "not from the top" is unambiguous
    const age = Date.now() - current.startedAt;
    const late = new Client(puppeteer, `http://127.0.0.1:${srv.port}`, 'announcement-late');
    try {
      await late.open('');
      // its own browser, so its own media emulation (headless defaults to reduce — see the header)
      await late.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await late.enter('阿米娅');
      await late.page.waitForSelector('.sann', { timeout: 10000 });
      // the transform of a freshly mounted element lands one frame later — wait for it rather than racing it
      await late.page.waitForFunction(() => document.querySelector('.sann__strip').getBoundingClientRect().x < -5, { timeout: 5000 });
      const st = await late.page.evaluate(() => {
        const el = document.querySelector('.sann__strip');
        const cs = getComputedStyle(el);
        return { text: el.textContent, delay: parseFloat(cs.getPropertyValue('--sann-delay')), x: el.getBoundingClientRect().x };
      });
      assert.equal(st.text, `[31m${text}`, 'the same announcement, not a replay from the top');
      assert.ok(st.delay <= -1500, `mid-pass, not from the top (${st.delay}ms)`);
      assert.ok(st.delay > -ANNOUNCEMENT.scrollMs, 'and still inside the first pass');
      assert.ok(st.x < -5, 'and therefore already past its starting position');
      // the offset IS the age of the announcement: that is what keeps every client in step
      assert.ok(Math.abs(-st.delay - age) < 2500, `offset ${-st.delay}ms ≈ the announcement's age ${age}ms`);
      // and the first client, on the same pass, is at roughly the same place
      assert.ok(Math.abs((await stripX()) - st.x) < 400, 'both clients are in step');
    } finally {
      await late.close();
    }
  });

  test('reloading the page re-shows it (a fresh hello re-pushes the live announcement)', async () => {
    const before = await page().evaluate(() => globalThis.__SP__.store.get().me.playerId);
    await page().reload({ waitUntil: 'domcontentloaded' });
    await page().waitForSelector('.lobby-screen', { timeout: 30000 });
    assert.equal(await page().evaluate(() => globalThis.__SP__.store.get().me.playerId), before, 'same session resumed');
    await waitStrip('the re-pushed strip');
    assert.equal((await stripStyle()).text, `[31m${text}`);
  });

  test('clear unmounts it, puts the toasts back, and a reload does not bring it back', async () => {
    await clear();
    // `.sann` goes with the render, `sp-ann` with the effect's cleanup one tick later — wait for both, or the
    // class assertion races the effect.
    await page().waitForFunction(
      () => !document.querySelector('.sann') && !document.documentElement.classList.contains('sp-ann'),
      { timeout: 10000 },
    );
    assert.equal(await hasStrip(), false);
    assert.equal(await page().evaluate(() => document.documentElement.classList.contains('sp-ann')), false);
    assert.equal(await waitToastTop(TOAST_TOP.plain), true, 'the toasts are back at the top');

    await page().reload({ waitUntil: 'domcontentloaded' });
    await page().waitForSelector('.lobby-screen', { timeout: 30000 });
    await sleep(600); // a frame would arrive with the welcome; give it room to show up if it were coming
    const pushed = (await frames()).filter((f) => f.t === 'server.announcement');
    assert.deepEqual(pushed, [], 'a cleared announcement is not restored by a hello (no frame on the wire at all)');
    assert.equal(await hasStrip(), false);
    assert.equal(srv.announcements.current, null, 'and the server has nothing to restore');
  });

  test('it survives a route change (chrome above the router, not part of a screen)', async () => {
    await publish(text);
    await waitStrip();
    // Flip the route the way the server would (a room.state), so this does not depend on a button's wording: the strip
    // lives in App's chrome layer, and a screen swap must not take it down. (Preact renders on a microtask — wait for
    // the screen instead of reading the DOM straight after the store write.)
    await page().evaluate(() => {
      const store = globalThis.__SP__.store;
      const me = store.get().me;
      store.set({
        room: {
          code: 'ABCD', hostId: me.playerId, mode: 'coop', difficulty: 'NORMAL',
          seats: [{ seat: 0, playerId: me.playerId, name: me.name, isBot: false, ready: false, connected: true }],
          spectators: [],
        },
      });
    });
    await page().waitForSelector('.room-screen', { timeout: 10000 });
    assert.equal(await hasStrip(), true, 'the strip is still there in the room');
    await page().evaluate(() => globalThis.__SP__.store.set({ room: null }));
    await page().waitForSelector('.lobby-screen', { timeout: 10000 });
    assert.equal(await hasStrip(), true, 'and after coming back');
    await clear();
    await page().waitForFunction(() => !document.querySelector('.sann'), { timeout: 10000 });
  });

  test('the marquee mid-pass (screenshot)', async () => {
    await publish(text); // plain text: the hostile-text pass above is not what an operator sends
    await waitStrip();
    // a pass is 30 s and the line travels a whole bar width plus its own, so ~8 s in it sits around the middle
    await sleep(8000);
    assert.equal(await hasStrip(), true, 'still on the same pass');
    await c.shot('announcement-marquee');
    await clear();
    await page().waitForFunction(() => !document.querySelector('.sann'), { timeout: 10000 });
  });

  // last: Chrome does not drop the emulation without a reload, and nothing after this depends on the animation
  test('prefers-reduced-motion: the marquee becomes a still line, and the schedule is unchanged', async () => {
    await publish(text);
    await waitStrip();
    assert.equal((await stripStyle()).animationName, 'sann-scroll', 'the marquee, to begin with');

    await page().emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const st = await stripStyle();
    assert.equal(st.animationName, 'none', 'no motion at all');
    assert.equal(st.text, text, 'still readable');
    assert.equal(st.textOverflow, 'ellipsis');
    assert.equal(await hasStrip(), true, 'and still on screen for the whole pass');
    // the schedule is the component's, not the animation's: it is still a scroll phase, so it is still mounted
    assert.equal(await page().evaluate(() => document.documentElement.classList.contains('sp-ann')), true);
    await c.shot('announcement-reduced-motion');
    await clear();
  });
});
