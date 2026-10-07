// test/ui/matchmaking.test.js — the client half of quick match: what can be driven in Node, and the wiring that would
// otherwise only be checked by opening a browser.
//
// The waiting screen itself (rendering, the live count, the clock, cancel) is checked in the browser —
// test/ui/matchmaking.e2e.test.js, SP_E2E=1. What is here is the part where a mistake is INVISIBLE:
//
//   * `queueStatusText` — the one sentence the player reads while waiting. It has to agree with the number in the seat
//     grid, and it has to stop saying 满员自动开始 once the queue is full (or the screen contradicts itself).
//   * the module graph: screens/matchmaking.js must NOT import screens/room.js. room.js imports it, and a cycle there
//     would be resolved by hoisting — the kind of thing that works until the day one of the two is evaluated first.
//   * the wiring, asserted on the sources (the way test/ui/loadout.test.js checks its CSS link): the room screen
//     diverts to the waiting screen on `matchmaking && !inMatch` and hands over the NORMALIZED seats; the lobby offers
//     快速匹配 for co-op only and sends `room.matchmake` with the difficulty the cards selected; index.html links the
//     stylesheet; main.js takes the queue's wording from shared/matchmaking.js instead of keeping a second copy.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_SEATS } from '../../shared/constants.js';
import { MATCHMAKING_CLOSE, matchmakingRule } from '../../shared/matchmaking.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const screen = () => import(pathToFileURL(path.join(ROOT, 'public/js/screens/matchmaking.js')).href);

const LOBBY = read('public/js/screens/lobby.js');
const ROOM = read('public/js/screens/room.js');
const MAIN = read('public/js/main.js');
const HTML = read('public/index.html');
const CSS = read('public/css/screens/matchmaking.css');

// ---------------------------------------------------------------------------------------------------
// the sentence on the screen
// ---------------------------------------------------------------------------------------------------

describe('the waiting screen\'s status line (public/js/screens/matchmaking.js)', () => {
  test('it counts against the room capacity and stops promising 满员 once the queue is full', async () => {
    const { queueStatusText } = await screen();
    assert.equal(queueStatusText(1, MAX_SEATS), '已找到 1 / 4 名博士，满员自动开始');
    assert.equal(queueStatusText(3, MAX_SEATS), '已找到 3 / 4 名博士，满员自动开始');
    assert.match(queueStatusText(4, MAX_SEATS), /正在进入模拟/, 'a full queue is starting, not still waiting');
    assert.equal(queueStatusText(1, 1), '已找到 1 / 1 名博士，正在进入模拟…', 'the same line works for a solo-capacity room');
  });

  test('an offline player is told the seat is kept, not that the queue is over', async () => {
    const { queueStatusText } = await screen();
    const text = queueStatusText(2, MAX_SEATS, { online: false });
    assert.match(text, /连接已中断/);
    assert.match(text, /重连后自动回到队列/);
    assert.doesNotMatch(text, /满员自动开始/);
  });

  test('the module loads on its own and exports the screen (the app-boot class of bug)', async () => {
    const mod = await screen();
    assert.equal(typeof mod.MatchmakingScreen, 'function');
    assert.equal(typeof mod.queueStatusText, 'function');
  });

  test('the rule the screen prints is the server\'s, with the wait the server reported', async () => {
    // The screen renders matchmakingRule(room.matchmakingTimeoutSec, capacity) — one source of truth with /match status.
    const src = read('public/js/screens/matchmaking.js');
    assert.match(src, /matchmakingRule\(timeoutSec, capacity\)/);
    assert.match(src, /room\.matchmakingTimeoutSec/, 'the wait comes from room.state, never from a client default');
    assert.match(src, /matchmakingClock\(elapsed\)/, 'the elapsed wait is the shared m:ss formatter');
    assert.match(src, /serverNow\(\)/, 'the clock is the SERVER clock (store.serverNow), not Date.now()');
    assert.match(src, /server\.announcement|serverNow/, 'sanity: the module reads the store, not a local clock');
    assert.equal(matchmakingRule(2), '满 4 名博士立即开始；已有 2 名以上时，等待 2 秒也会按当前人数开始。');
  });
});

// ---------------------------------------------------------------------------------------------------
// the wiring
// ---------------------------------------------------------------------------------------------------

describe('quick match wiring (screens / main.js / index.html)', () => {
  test('the room screen diverts to the waiting screen and hands over the normalized seats', () => {
    assert.match(ROOM, /import \{ MatchmakingScreen \} from '\.\/matchmaking\.js';/);
    assert.match(ROOM, /if \(room\.matchmaking && !room\.inMatch\) return html`<\$\{MatchmakingScreen\} room=\$\{room\} seats=\$\{facts\.seats\} \/>`;/);
    // the diversion sits AFTER the facts are computed (the seats come from roomFacts) and before any hook-less work
    assert.ok(ROOM.indexOf('const facts = roomFacts(room, me.playerId)') < ROOM.indexOf('<${MatchmakingScreen}'),
      'the seat grid is normalized before it is handed over');
    assert.match(ROOM, /export function roomFacts/, 'the same normalization both screens use');
  });

  test('the waiting screen does not import the room screen (no import cycle)', () => {
    const src = read('public/js/screens/matchmaking.js');
    assert.doesNotMatch(src, /from '\.\/room\.js'/, 'a cycle would be resolved by hoisting — invisible until it breaks');
    assert.match(src, /from '\.\/loadout\.js'/, '干员调配 stays reachable while waiting');
  });

  test('the lobby offers 快速匹配 for co-op only, with the difficulty the cards selected', () => {
    assert.match(LOBBY, /net\.request\('room\.matchmake', \{ difficulty \}\)/);
    assert.match(LOBBY, /roomMode === 'coop' \? html`<\$\{Tooltip\} block=\$\{true\}/, 'the button is co-op only');
    assert.match(LOBBY, /loading=\$\{busy === 'match'\}/);
    assert.match(LOBBY, /满 \$\{MAX_SEATS\} 人立即开局/);
  });

  test('main.js takes the queue\'s wording from the shared module, and 取消匹配 says nothing', () => {
    assert.match(MAIN, /import \{ MATCHMAKING_CLOSE \} from '\.\.\/\.\.\/shared\/matchmaking\.js';/);
    assert.match(MAIN, /\.\.\.MATCHMAKING_CLOSE/);
    assert.match(MAIN, /if \(text === null\) return; \/\/ 取消匹配/, 'a null wording is the silent case');
    // the lookup must not be fooled by a forged reason: a normal object answers Object.prototype for '__proto__'
    assert.match(MAIN, /Object\.assign\(Object\.create\(null\), \{/);
    for (const reason of Object.keys(MATCHMAKING_CLOSE)) assert.ok(reason.startsWith('matchmaking_'), reason);
  });

  test('the stylesheet is linked and ships with the screen', () => {
    assert.ok(existsSync(path.join(ROOT, 'public/css/screens/matchmaking.css')));
    assert.match(HTML, /<link rel="stylesheet" href="\/css\/screens\/matchmaking\.css" \/>/);
    // the classes the screen renders must exist in the stylesheet, or the screen silently renders unstyled
    const src = read('public/js/screens/matchmaking.js');
    for (const cls of ['mm-screen', 'mm-body', 'mm-card', 'mm-card__status', 'mm-progress', 'mm-seats', 'mm-seat', 'mm-card__hint', 'mm-card__actions', 'mm-card__clock']) {
      assert.ok(src.includes(cls), `the screen renders .${cls}`);
      assert.ok(CSS.includes(`.${cls}`), `the stylesheet styles .${cls}`);
    }
    // Sized in rem against the root scale (theme.css), like every other screen: a pixel length does not scale with the
    // window, so on a 640×360 phone it is simply the wrong size. Hairline borders are the one honest exception
    // (theme.css `--bk-w`), and they are what the filter below lets through.
    const px = [...CSS.matchAll(/([a-z-]+)\s*:\s*([^;{}]*\d+px[^;{}]*)/g)]
      .filter(([, prop]) => !/^(border|border-(top|right|bottom|left)|outline)/.test(prop));
    assert.deepEqual(px.map(([, prop, val]) => `${prop}: ${val.trim()}`), [], 'no pixel lengths outside borders');
  });

  test('the waiting screen is reachable from every screen the player can be on', () => {
    // the chat panel and the announcement strip are App chrome: they must not disappear while queued
    const chat = read('public/js/ui/roomChat.js');
    assert.match(chat, /export function showsChat\(room\) \{[\s\S]*?room\.mode !== 'solo'/, 'the panel follows the room, queue included');
    assert.match(read('public/js/main.js'), /<\$\{RoomChatHost\} \/>/);
  });
});
