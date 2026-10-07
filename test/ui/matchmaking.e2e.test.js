// test/ui/matchmaking.e2e.test.js — quick match in headless Chrome, against the real server.
//
// Opt-in like the other browser suites: SP_E2E=1 node --test test/ui/matchmaking.e2e.test.js
// Chrome path: $CHROME_PATH or the macOS default. (No public/assets needed — the waiting screen is chrome, and the
// match this suite starts uses the platform stub: what is under test is the QUEUE, not the sim.)
//
// ⚠ The FIRST test is the point of this file: a real page load, and the app must come up clean. A screen module that
// imports something which touches the DOM at evaluation time, or a stylesheet link that 404s, takes the WHOLE
// application down at boot — and nothing but a real page can tell you that.
//
// Asserted (shared/matchmaking.js + server/lobby.js → public/js/screens/{lobby,matchmaking,room}.js + css):
//   * the app boots with the waiting screen wired in (console clean, __SP__ present, the lobby renders),
//   * 快速匹配 is offered for 同盟模拟 only — switching the mode card to 独立模拟 takes it away (a solo queue has
//     nothing to match with; 开始独立模拟 is right there),
//   * clicking it puts the player on the waiting screen: the difficulty, the elapsed clock, `已找到 N / 4`, the seat
//     grid, and the START RULE with the number the SERVER reported (not a client default),
//   * a second doctor lands in the SAME queue and both see 2/4 and each other's names — the count is live, without a
//     reload,
//   * a third doctor joins (3/4) and cancels: they are back in the lobby, with no toast about a closed alliance, and
//     the two who stayed are still queued at 2/4,
//   * when the wait runs out the queue starts with the doctors who are THERE: both clients leave the waiting screen for
//     the match (room.inMatch, route = game), without anybody pressing 开始模拟,
//   * zero console errors / failed requests throughout.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { startServer } from '../../server/index.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { Client, CHROME, sleep } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
/** The wait the queue of this suite uses: long enough for three doctors to queue and one to cancel in comfort. */
const WAIT_MS = 12_000;
/** The download pipeline's directories, absent in a bare checkout: reported, not failed (as in client-static.test.js). */
const OPTIONAL = /\/fonts\/|\/assets\/|\/media\//;

describe('quick match in the browser', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let puppeteer;
  /** @type {Client} the first doctor: hosts the queue and runs most assertions */
  let a;
  /** @type {Client} the second doctor: proves the queue is shared and the count live */
  let b;
  /** @type {Client} the third doctor: joins the queue and cancels out of it */
  let c;

  /** The waiting screen's text, or null when it is not on screen. */
  const mmText = (cl) => cl.page.evaluate(() => document.querySelector('.mm-screen')?.innerText ?? null);
  /** The waiting screen's seat grid, as rendered. */
  const mmSeats = (cl) => cl.page.evaluate(() => [...document.querySelectorAll('.mm-seat')].map((li) => ({
    filled: li.classList.contains('is-filled'),
    mine: li.classList.contains('is-me'),
    name: (li.querySelector('.mm-seat__name')?.textContent || '').trim(),
    state: (li.querySelector('.mm-seat__state')?.textContent || '').trim(),
  })));

  /** Wait for the waiting screen's text to match. */
  const waitForText = async (cl, re, what, timeout = 10_000) => {
    const t0 = Date.now();
    let text = null;
    while (Date.now() - t0 < timeout) {
      text = await mmText(cl);
      if (text && re.test(text)) return text;
      await sleep(150);
    }
    assert.fail(`${cl.label}: ${what} never appeared (text: ${JSON.stringify(text)})`);
  };

  /** Whether the lobby's create box offers a button with this text (point() skips disabled ones). */
  const hasLobbyButton = async (cl, text) => !!(await cl.point('.create-box button', text));

  before(async () => {
    puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, matchmakingTimeoutMs: WAIT_MS,
    });
    const base = `http://127.0.0.1:${srv.port}`;
    a = new Client(puppeteer, base, 'mm-a', { prefix: 'matchmaking' });
    b = new Client(puppeteer, base, 'mm-b', { prefix: 'matchmaking' });
    c = new Client(puppeteer, base, 'mm-c', { prefix: 'matchmaking', w: 1280, h: 720 });
  });

  after(async () => {
    await Promise.all([a, b, c].map((cl) => cl?.close()));
    await srv?.close();
  });

  test('the app boots clean with the waiting screen wired in', async () => {
    await Promise.all([a.open(), b.open(), c.open()]);
    await Promise.all([a.enter('阿尔法'), b.enter('贝塔'), c.enter('伽马')]);
    for (const cl of [a, b, c]) {
      assert.equal(await cl.page.evaluate(() => !!globalThis.__SP__), true, `${cl.label}: __SP__ missing`);
      assert.equal(await cl.visible('.lobby-screen'), true, `${cl.label}: no lobby`);
      // 快速匹配 is offered for 同盟模拟 (the default) and taken away for 独立模拟
      assert.equal(await hasLobbyButton(cl, '快速匹配'), true, `${cl.label}: no 快速匹配 in the co-op lobby`);
      await cl.click('.mode-card', '独立模拟');
      assert.equal(await hasLobbyButton(cl, '快速匹配'), false, `${cl.label}: 快速匹配 shown for a solo run`);
      assert.equal(await hasLobbyButton(cl, '开始独立模拟'), true);
      await cl.click('.mode-card', '同盟模拟');
      assert.equal(await hasLobbyButton(cl, '快速匹配'), true, `${cl.label}: 快速匹配 did not come back`);
      await cl.shot('lobby');
    }
  });

  test('快速匹配 opens the waiting screen with the server\'s rule, and a second doctor joins the same queue', async () => {
    await a.click('.create-box button', '快速匹配');
    const one = await waitForText(a, /已找到 1 \/ 4 名博士/, 'the waiting screen');
    assert.match(one, /满员自动开始/);
    assert.match(one, /标准模拟/, 'the difficulty the lobby had selected');
    // the START RULE carries the number the SERVER reported (matchmakingTimeoutSec), not a client default
    assert.match(one, new RegExp(`等待 ${WAIT_MS / 1000} 秒`), `the rule should state the server's wait:\n${one}`);
    assert.match(one, /^0:0\d$/m, 'the elapsed clock is running');
    assert.equal(await a.visible('.mm-screen'), true);
    assert.equal(await a.page.evaluate(() => document.querySelectorAll('.mm-seat').length), 4);
    const first = await mmSeats(a);
    assert.equal(first.filter((s) => s.filled).length, 1);
    assert.equal(first[0].mine, true);
    assert.match(first[0].state, /你 · 已加入/);
    assert.equal(first[0].name, '阿尔法');
    await a.shot('waiting');

    await b.click('.create-box button', '快速匹配');
    for (const cl of [a, b]) {
      const two = await waitForText(cl, /已找到 2 \/ 4 名博士/, 'the shared queue');
      assert.match(two, /满员自动开始/);
      const seats = await mmSeats(cl);
      const filled = seats.filter((s) => s.filled);
      assert.equal(filled.length, 2, JSON.stringify(seats));
      assert.deepEqual(filled.map((s) => s.name).sort(), ['阿尔法', '贝塔'].sort());
      assert.equal(seats[0].name, '阿尔法', 'the first doctor keeps seat 1');
      assert.equal(seats[1].mine, cl === b, 'each client sees which seat is its own');
    }
    // and the waiting room is a real room: the same code on both sides
    const [sa, sb] = [await a.st(), await b.st()];
    assert.equal(sa.room.code, sb.room.code, 'both doctors are in one queue room');
    assert.equal(sa.room.inMatch, false);
  });

  test('the count is live: a third doctor appears as 3/4, then cancels back to the lobby', async () => {
    await c.click('.create-box button', '快速匹配');
    const three = await waitForText(c, /已找到 3 \/ 4 名博士/, 'the third seat');
    assert.match(three, /满员自动开始/);
    // the two who were already waiting see the third without doing anything
    const live = await waitForText(a, /已找到 3 \/ 4 名博士/, 'the live count on the first doctor');
    assert.match(live, /贝塔/);
    assert.match(live, /伽马/);

    await c.click('.mm-card__actions button', '取消匹配');
    // back in the lobby, and with nothing to read: 取消匹配 is what the player just asked for
    await c.page.waitForSelector('.lobby-screen', { timeout: 10_000 });
    await sleep(300);
    assert.equal(await c.visible('.mm-screen'), false);
    assert.equal((await c.st()).room, null);
    const toasts = await c.toasts();
    assert.deepEqual(toasts.filter((t) => /同盟已关闭|未能开局|匹配/.test(t)), [], `unexpected toast: ${JSON.stringify(toasts)}`);

    // the two who stayed are still queued, and the count went back to 2
    const back = await waitForText(a, /已找到 2 \/ 4 名博士/, 'the queue after a cancel');
    assert.doesNotMatch(back, /伽马/);
    assert.equal((await a.st()).room.inMatch, false, 'a cancel never starts a match for the others');
    assert.equal(srv.lobby.queues.size, 1);
    assert.equal(srv.lobby.queuedCount(), 2);
  });

  test('the wait runs out: the queue starts with the doctors who are there, and both land in the match', async () => {
    // Nobody presses 开始模拟: the queue's own wait (matchmakingTimeoutMs) starts the match. The room is no longer a
    // waiting room, so both clients leave the waiting screen for the game route.
    const [ra, rb] = await Promise.all([
      a.waitFor((s) => !!s.room?.inMatch, 'the queue to start (A)', WAIT_MS + 15_000),
      b.waitFor((s) => !!s.room?.inMatch, 'the queue to start (B)', WAIT_MS + 15_000),
    ]);
    assert.equal(ra.room.code, rb.room.code, 'both doctors started in the same room');
    for (const cl of [a, b]) {
      assert.equal(await cl.page.evaluate(() => !!document.querySelector('.mm-screen')), false, `${cl.label}: the waiting screen stayed up`);
      assert.equal(await cl.page.evaluate(() => !!document.querySelector('.screen')), true, `${cl.label}: no screen at all`);
    }
    assert.equal(srv.lobby.queues.size, 0, 'the queue is empty once it started');
    assert.equal(srv.lobby.stats().matching, 0);
    assert.equal(srv.lobby.stats().queued, 0);
    await a.shot('started');
    await b.shot('started');
  });

  test('no console errors, failed requests or 4xx/5xx responses along the way', () => {
    for (const cl of [a, b, c]) {
      const real = cl.problems.filter((p) => !OPTIONAL.test(p));
      assert.deepEqual(real, [], `${cl.label}:\n${real.join('\n')}`);
    }
  });
});
