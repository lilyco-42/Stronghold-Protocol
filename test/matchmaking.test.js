// test/matchmaking.test.js — quick match: the queue's rules (shared/matchmaking.js) and the lobby's queue
// (server/lobby.js `matchmake` / `cancelMatchmaking`, `startQueuedMatch`, the `/match` console lever).
//
// The browser halves live in test/ui/matchmaking.test.js (the waiting screen + the lobby entry + the close-reason
// wording) and test/ui/matchmaking.e2e.test.js (two real pages meeting in one queue and starting a match).
//
// What has to hold here:
//
//   * the ROOM is the queue: one waiting room per difficulty, a second doctor asking for the same difficulty takes a
//     free seat in it (so the queue is visible to its own members), a different difficulty gets its own room, and a
//     full queue sends the next doctor to a fresh room — never behind a queue that is already starting;
//   * the start rule (owner's decision: 满员或超时): MAX_SEATS doctors start at once; otherwise the queue starts after
//     the wait with the doctors who are THERE; a lone doctor keeps waiting (the timer re-arms) and is never started
//     into a co-op run alone;
//   * a doctor who is offline when the queue starts is FREED, not carried into the match, and is told
//     `matchmaking_disconnected` on their next resume — the same reason the lobby grace gives a queued doctor;
//   * leaving answers `matchmaking_cancelled` (the client stays silent — the player asked for it) and whoever stays
//     queued keeps waiting; a start that cannot happen ends the queue with `matchmaking_failed`;
//   * a waiting room refuses everything that shapes a lobby room (ready / difficulty / AI seats / kick / start /
//     join / spectate) while room.chat and room.loadout keep working — 等待期间聊天与调配干员照常可用;
//   * `/match` is the operator's lever: `status` shows the queues, `timeout` changes the wait on a running server and
//     reaches the waiting screens with the state broadcast that follows it.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { Lobby, LOBBY_DEFAULTS } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { S2C, C2S, validateC2S } from '../shared/protocol.js';
import { MATCHMAKING, MATCHMAKING_CLOSE, MATCH_HELP, matchmakingClock, matchmakingCount, matchmakingRule, parseMatchCommand } from '../shared/matchmaking.js';
import { MAX_SEATS } from '../shared/constants.js';

/** The wait the servers of this file use (2 s: long enough to observe, short enough to wait out once). */
const WAIT = 2000;
const quietLog = () => ({ info() {}, warn() {}, debug() {}, error() {} });

const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
const expectOk = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const expectError = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `expected error ${code} for ${msg.t}, got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};

// ---------------------------------------------------------------------------------------------------
// shared/matchmaking.js — the rules and the operator parser
// ---------------------------------------------------------------------------------------------------

describe('matching queue rules (shared/matchmaking.js)', () => {
  test('the tunables are the owner\'s decision: 2 doctors minimum, a 60 s wait, full = MAX_SEATS', () => {
    assert.equal(MATCHMAKING.minPlayers, 2);
    assert.equal(MATCHMAKING.timeoutMs, 60_000);
    assert.equal(LOBBY_DEFAULTS.matchmakingTimeoutMs, MATCHMAKING.timeoutMs, 'the lobby default is the shared one');
    assert.ok(MATCHMAKING.minTimeoutSec < MATCHMAKING.maxTimeoutSec);
  });

  test('matchmakingCount counts CONNECTED HUMANS, and reads the same on both sides of the wire', () => {
    // the server's raw seats and the client's room.state.seats differ only in the extra fields
    assert.equal(matchmakingCount([{ playerId: 'a', isBot: false, connected: true }, null, { playerId: 'b', isBot: false, connected: false }]), 1);
    assert.equal(matchmakingCount([{ playerId: 'ai_1', isBot: true, connected: true }, { playerId: 'a', isBot: false, connected: true }]), 1);
    assert.equal(matchmakingCount([]), 0);
    assert.equal(matchmakingCount(null), 0);
    assert.equal(matchmakingCount([{}, null, null, null]), 1, 'a seat without the flag (a forged frame) still counts as a doctor');
  });

  test('the rule sentence states what the server does, with the wait in force', () => {
    assert.equal(matchmakingRule(60), '满 4 名博士立即开始；已有 2 名以上时，等待 60 秒也会按当前人数开始。');
    assert.match(matchmakingRule(90), /等待 90 秒/);
    assert.match(matchmakingRule(), /等待 60 秒/, 'no argument = the default wait');
    assert.match(matchmakingRule(0), /等待 60 秒/, 'a nonsense wait falls back to the default, never "0 秒"');
  });

  test('the waiting clock is m:ss', () => {
    assert.equal(matchmakingClock(0), '0:00');
    assert.equal(matchmakingClock(7_000), '0:07');
    assert.equal(matchmakingClock(75_400), '1:15');
    assert.equal(matchmakingClock(NaN), '0:00');
  });

  test('parseMatchCommand: status / help / a bounded timeout, and never claims another command', () => {
    assert.deepEqual(parseMatchCommand('/match'), { action: 'status' });
    assert.deepEqual(parseMatchCommand('匹配'), { action: 'status' });
    assert.deepEqual(parseMatchCommand('/match status'), { action: 'status' });
    assert.deepEqual(parseMatchCommand('/match help'), { action: 'help' });
    assert.deepEqual(parseMatchCommand('/match timeout 90'), { action: 'timeout', sec: 90 });
    assert.deepEqual(parseMatchCommand('匹配 超时 90'), { action: 'timeout', sec: 90 });
    assert.equal(parseMatchCommand('/match timeout 1').action, 'error', 'below the floor');
    assert.equal(parseMatchCommand('/match timeout 9999').action, 'error', 'above the ceiling');
    assert.equal(parseMatchCommand('/match nonsense').action, 'error');
    assert.equal(parseMatchCommand('/chat off'), null, 'not ours');
    assert.equal(parseMatchCommand('/announce hi'), null);
    assert.equal(parseMatchCommand(''), null);
    assert.match(MATCH_HELP, /\/match timeout/);
  });

  test('the protocol registers both intents and refuses a difficulty the game does not have', () => {
    assert.ok(S2C.includes('room.state'));
    assert.ok(Object.hasOwn(C2S, 'room.matchmake') && Object.hasOwn(C2S, 'room.cancelMatchmaking'));
    assert.equal(validateC2S({ t: 'room.matchmake', difficulty: 'NORMAL' }), null);
    assert.ok(validateC2S({ t: 'room.matchmake', difficulty: 'EASY' }), 'unknown difficulty');
    assert.ok(validateC2S({ t: 'room.matchmake' }), 'difficulty is required');
    assert.equal(validateC2S({ t: 'room.cancelMatchmaking' }), null);
  });

  test('the three closing reasons are worded where the server raises them', () => {
    // main.js spreads this map into its own CLOSE_REASON, so a reason renamed on one side cannot end up unhandled.
    assert.deepEqual(Object.keys(MATCHMAKING_CLOSE).sort(),
      ['matchmaking_cancelled', 'matchmaking_disconnected', 'matchmaking_failed']);
    assert.equal(MATCHMAKING_CLOSE.matchmaking_cancelled, null, '取消匹配 says nothing: the player asked for it');
    assert.match(MATCHMAKING_CLOSE.matchmaking_disconnected, /匹配队列/);
    assert.match(MATCHMAKING_CLOSE.matchmaking_failed, /重新匹配/);
  });
});

// ---------------------------------------------------------------------------------------------------
// the lobby's queue — real servers in-process
// ---------------------------------------------------------------------------------------------------

describe('quick match in the lobby (server/lobby.js)', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  const clients = new Set();

  const connect = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    clients.add(c);
    return c;
  };

  /** A fresh socket that has NOT said hello yet — what a resume needs (a hello without a token is a new doctor). */
  const connectRaw = async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.add(c);
    return c;
  };

  /** queue one doctor and wait for the state that says so. */
  const queue = async (c, difficulty = 'NORMAL') => {
    await expectOk(c, { t: 'room.matchmake', difficulty });
    return c.waitFor('room.state', (s) => s.matchmaking === true);
  };

  before(async () => {
    srv = await startServer({
      port: 0, host: '127.0.0.1', log: quietLog(), MatchClass: StubMatch, matchmakingTimeoutMs: WAIT,
    });
  });

  afterEach(async () => {
    await Promise.all([...clients].map((c) => c.terminate().catch(() => {})));
    clients.clear();
    srv.lobby.shutdown('test');
    srv.lobby.rooms.clear();
    srv.lobby.queues.clear();
  });

  after(async () => { await srv.close(); });

  test('room.matchmake opens a waiting room; a second doctor of the same difficulty shares it', async () => {
    const a = await connect('A');
    const st = await queue(a);
    assert.equal(st.mode, 'coop');
    assert.equal(st.difficulty, 'NORMAL');
    assert.equal(st.inMatch, false);
    assert.equal(st.hostId, a.id, 'the first doctor hosts the waiting room');
    assert.ok(st.matchmakingSince > 0, 'the waiting clock starts on the server');
    assert.equal(st.matchmakingTimeoutSec, WAIT / 1000);
    assert.equal(seatOf(st, a.id).seat, 0);
    assert.equal(seatOf(st, a.id).isBot, false);
    const code = st.code;

    const b = await connect('B');
    const stB = await queue(b);
    assert.equal(stB.code, code, 'the same difficulty waits in the same room');
    assert.equal(seatOf(stB, b.id).seat, 1, 'the newcomer takes the lowest free seat');
    assert.equal(stB.hostId, a.id, 'the host does not move');
    assert.equal(matchmakingCount(stB.seats), 2);

    // A sees the queue grow without asking
    const seen = await a.waitFor('room.state', (s) => s.code === code && s.seats.some((x) => x && x.playerId === b.id));
    assert.equal(matchmakingCount(seen.seats), 2);

    // and asking again while queued is a resync, not a second seat
    await expectOk(a, { t: 'room.matchmake', difficulty: 'NORMAL' });
    const again = await a.waitFor('room.state', (s) => s.code === code);
    assert.equal(again.seats.filter((x) => x && x.playerId === a.id).length, 1);
    assert.equal(matchmakingCount(again.seats), 2);
  });

  test('a different difficulty gets its own waiting room', async () => {
    const a = await connect('A');
    const b = await connect('B');
    const normal = await queue(a, 'NORMAL');
    const hard = await queue(b, 'HARD');
    assert.notEqual(normal.code, hard.code);
    assert.equal(srv.lobby.queues.size, 2);
    assert.equal(srv.lobby.stats().matching, 2);
    assert.equal(srv.lobby.stats().queued, 2);
  });

  test('a full queue starts at once, with every doctor in it', async () => {
    const team = [await connect('A'), await connect('B'), await connect('C'), await connect('D')];
    const first = await queue(team[0]);
    await queue(team[1]);
    await queue(team[2]);
    // the 4th doctor fills the queue: the room starts instead of waiting out the timer
    await expectOk(team[3], { t: 'room.matchmake', difficulty: 'NORMAL' });
    for (const c of team) {
      const started = await c.waitFor('room.state', (s) => s.code === first.code && s.inMatch === true);
      assert.equal(started.matchmaking, false, 'a started room is out of the queue');
      assert.equal(matchmakingCount(started.seats), MAX_SEATS);
      assert.ok(seatOf(started, c.id), `${c === team[0] ? 'A' : 'a doctor'} holds a seat`);
    }
    assert.equal(srv.lobby.queues.size, 0, 'the queue is empty once it started');
    assert.equal(srv.lobby.stats().matching, 0);
  });

  test('the wait runs out: the queue starts with the doctors who are there (and re-arms while alone)', async () => {
    const a = await connect('A');
    const st = await queue(a);
    // one doctor: the timer re-arms instead of starting a co-op run alone
    await delay(WAIT + 300);
    assert.equal(srv.lobby.queues.get('NORMAL')?.code, st.code, 'still queued');
    assert.equal(srv.lobby.queueCount(srv.lobby.queues.get('NORMAL')), 1);
    await a.expectNone('room.state', (s) => s.inMatch === true, 50); // nothing started

    // a second doctor arrives: the next wait starts the match with the two of them
    const b = await connect('B');
    await queue(b);
    const started = await a.waitFor('room.state', (s) => s.inMatch === true, 5000);
    assert.equal(started.matchmaking, false);
    assert.equal(matchmakingCount(started.seats), 2, 'started with the doctors who were there, not padded to 4');
    assert.ok(seatOf(started, a.id) && seatOf(started, b.id));
    await b.waitFor('room.state', (s) => s.inMatch === true, 5000);
  });

  test('a doctor who is offline when the queue starts is freed, not carried in — and told why on resume', async () => {
    const a = await connect('A');
    const b = await connect('B');
    const c = await connect('C');
    await queue(a);
    await queue(b);
    const st = await queue(c);
    // B drops; the queue must not start around an empty chair
    await b.terminate();
    await a.waitFor('room.state', (s) => { const x = seatOf(s, b.id); return !!x && x.connected === false; });
    srv.lobby.onQueueTimeout(srv.lobby.queues.get('NORMAL'));
    const started = await a.waitFor('room.state', (s) => s.inMatch === true, 5000);
    assert.equal(matchmakingCount(started.seats), 2, 'the two doctors who are here');
    assert.equal(seatOf(started, b.id), null, 'B lost the seat');
    assert.ok(seatOf(started, a.id) && seatOf(started, c.id));
    assert.equal(srv.lobby.queues.size, 0);
    assert.equal(st.code, started.code);

    // B comes back: the room is gone and says which queue it lost
    const back = await connectRaw();
    const welcome = await back.hello('B', b.token);
    assert.equal(welcome.resumed, true);
    const frame = await back.waitFor('room.closed', () => true, 3000);
    assert.equal(frame.reason, 'matchmaking_disconnected');
  });

  test('the lobby grace of a queued doctor says matchmaking_disconnected, not "you left the alliance"', async () => {
    const srv2 = await startServer({ port: 0, host: '127.0.0.1', log: quietLog(), MatchClass: StubMatch, lobbyGraceMs: 150, matchmakingTimeoutMs: 60_000 });
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv2.port}/ws`);
      const w = await c.hello('A');
      c.id = w.playerId; c.token = w.token;
      await c.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
      await c.waitFor('room.state', (s) => s.matchmaking === true);
      await c.terminate();
      await delay(400); // past the grace: the seat is freed and the notice recorded
      assert.equal(srv2.lobby.queues.size, 0, 'the empty queue room is disposed');
      const back = await TestClient.connect(`ws://127.0.0.1:${srv2.port}/ws`);
      await back.hello('A', w.token);
      const frame = await back.waitFor('room.closed', () => true, 3000);
      assert.equal(frame.reason, 'matchmaking_disconnected');
      await back.terminate();
    } finally {
      await srv2.close();
    }
  });

  test('room.cancelMatchmaking leaves the queue silently and the others keep waiting', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await queue(a);
    const st = await queue(b);
    await expectOk(b, { t: 'room.cancelMatchmaking' });
    const closed = await b.waitFor('room.closed', () => true, 2000);
    assert.equal(closed.reason, 'matchmaking_cancelled');
    const after = await a.waitFor('room.state', (s) => s.code === st.code && matchmakingCount(s.seats) === 1);
    assert.equal(seatOf(after, b.id), null);
    assert.equal(after.matchmaking, true, 'A is still queued');
    assert.equal(srv.lobby.queues.get('NORMAL').code, st.code);

    // and B is out of the room for good: cancelling again is NOT_IN_ROOM
    await expectError(b, { t: 'room.cancelMatchmaking' }, 'NOT_IN_ROOM');
  });

  test('room.leave on a waiting room is the same exit, with the same reason', async () => {
    const a = await connect('A');
    await queue(a);
    await expectOk(a, { t: 'room.leave' });
    const closed = await a.waitFor('room.closed', () => true, 2000);
    assert.equal(closed.reason, 'matchmaking_cancelled');
    assert.equal(srv.lobby.queues.size, 0, 'the empty queue room is gone');
  });

  test('room.cancelMatchmaking on a normal room is refused (the queue is not this room\'s business)', async () => {
    const a = await connect('A');
    await expectOk(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await a.waitFor('room.state', (s) => s.mode === 'coop');
    await expectError(a, { t: 'room.cancelMatchmaking' }, 'WRONG_PHASE');
  });

  test('a waiting room refuses everything that shapes a lobby room, but not chat or 干员调配', async () => {
    const a = await connect('A');
    const b = await connect('B');
    const st = await queue(a);
    for (const msg of [
      { t: 'room.ready', ready: true },
      { t: 'room.setDifficulty', difficulty: 'HARD' },
      { t: 'room.addBot' },
      { t: 'room.removeBot', seat: 1 },
      { t: 'room.kick', seat: 1, playerId: b.id },
      { t: 'room.start' },
      { t: 'room.join', code: st.code },
      { t: 'room.spectate', code: st.code },
    ]) {
      await expectError(a, msg, 'WRONG_PHASE');
    }
    // the queue is untouched by all of that
    const now = await a.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
    assert.equal(now.t, 'ok');
    const state = await a.waitFor('room.state', (s) => s.code === st.code);
    assert.equal(state.difficulty, 'NORMAL');
    assert.equal(matchmakingCount(state.seats), 1);
    assert.equal(state.seats.some((s) => s && s.isBot), false, 'no AI seat ever appears in a queue');

    // 等待期间聊天与调配干员照常可用
    await expectOk(a, { t: 'room.chat', text: '有人吗' });
    await a.waitFor('room.chat', (m) => m.message && m.message.text === '有人吗');
    await expectOk(a, { t: 'room.loadout', entries: {} });
    await expectOk(a, { t: 'room.leave' });
    await a.waitFor('room.closed', () => true);
  });

  test('a reconnect inside the grace keeps the queue seat', async () => {
    const a = await connect('A');
    const b = await connect('B');
    const st = await queue(a);
    await queue(b);
    await a.terminate();
    await b.waitFor('room.state', (s) => { const x = seatOf(s, a.id); return !!x && x.connected === false; });
    const back = await connectRaw();
    const welcome = await back.hello('A', a.token);
    assert.equal(welcome.resumed, true);
    back.id = welcome.playerId;
    const state = await back.waitFor('room.state', (s) => s.code === st.code);
    assert.equal(state.matchmaking, true);
    assert.equal(seatOf(state, back.id).connected, true);
    assert.equal(matchmakingCount(state.seats), 2);
    assert.equal(srv.lobby.queues.get('NORMAL').code, st.code);
    await expectOk(back, { t: 'room.cancelMatchmaking' });
    await back.waitFor('room.closed', () => true);
  });

  test('a start that cannot happen ends the queue with matchmaking_failed', async () => {
    const boom = await startServer({
      port: 0, host: '127.0.0.1', log: quietLog(), matchmakingTimeoutMs: WAIT,
      MatchClass: class { constructor() { throw new Error('boom'); } },
    });
    try {
      const a = await TestClient.connect(`ws://127.0.0.1:${boom.port}/ws`);
      const w = await a.hello('A');
      a.id = w.playerId;
      const b = await TestClient.connect(`ws://127.0.0.1:${boom.port}/ws`);
      await b.hello('B');
      await a.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
      const st = await a.waitFor('room.state', (s) => s.matchmaking === true);
      await b.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
      await b.waitFor('room.state', (s) => s.matchmaking === true);
      boom.lobby.onQueueTimeout(boom.lobby.queues.get('NORMAL'));
      for (const c of [a, b]) {
        const closed = await c.waitFor('room.closed', () => true, 3000);
        assert.equal(closed.reason, 'matchmaking_failed');
      }
      assert.equal(boom.lobby.rooms.has(st.code), false, 'the waiting room is gone');
      assert.equal(boom.lobby.queues.size, 0);
      await a.terminate(); await b.terminate();
    } finally {
      await boom.close();
    }
  });

  test('the per-network match limit refuses a queued start the same way', async () => {
    // The limit only applies to internet clients (net.js clientAddress), so the test charges the key by hand.
    const a = await connect('A');
    const b = await connect('B');
    const c = await connect('C');
    srv.lobby.opts.maxMatchesPerAddr = 1;
    srv.registry.byId(a.id).limitKey = 'test-net';
    srv.registry.byId(b.id).limitKey = 'test-net'; // the queue's host: the same network
    // one match already running from that network
    await expectOk(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await a.waitFor('room.state', (s) => s.mode === 'coop' && !s.matchmaking);
    await expectOk(a, { t: 'room.start' });
    await a.waitFor('room.state', (s) => s.inMatch === true);
    assert.equal(srv.lobby.countRooms((r) => !!r.match && r.matchKey === 'test-net'), 1);

    // now a queued start: the queue may not open a second match from that network
    const queued = await queue(b);
    await queue(c);
    srv.lobby.onQueueTimeout(srv.lobby.queues.get('NORMAL'));
    for (const cl of [b, c]) {
      const closed = await cl.waitFor('room.closed', () => true, 3000);
      assert.equal(closed.reason, 'matchmaking_failed');
    }
    assert.equal(srv.lobby.rooms.has(queued.code), false);
  });

  test('a room in the queue still answers the lobby\'s own frame order on hello (no surprise frames)', async () => {
    const a = await connect('A');
    const st = await queue(a);
    // a repeated hello on a live socket is a resync: state first, and no chat frame for an empty log
    const again = await a.request({ t: 'hello', name: 'A', token: a.token });
    assert.equal(again.t, 'welcome');
    const state = await a.waitFor('room.state', (s) => s.code === st.code);
    assert.equal(state.matchmaking, true);
    await a.expectNone('room.closed', () => true, 100);
  });

  test('/match status and /match timeout drive the queue from the console', async () => {
    const a = await connect('A');
    await queue(a);
    const status = srv.lobby.handleCommand('/match');
    assert.equal(status.handled, true);
    const text = status.lines.join('\n');
    assert.match(text, /匹配队列：1 个/);
    assert.match(text, /等待中 1 名博士/);
    assert.match(text, /NORMAL 1\/4 · A/);
    assert.match(text, /满 4 名博士立即开始/);

    const set = srv.lobby.handleCommand('/match timeout 30');
    assert.equal(set.handled, true);
    assert.equal(srv.lobby.opts.matchmakingTimeoutMs, 30_000);
    assert.match(set.lines.join('\n'), /30 秒/);
    // the waiting screen prints the number: it is re-broadcast at once
    const state = await a.waitFor('room.state', (s) => s.matchmakingTimeoutSec === 30);
    assert.equal(state.matchmaking, true);

    assert.equal(srv.lobby.handleCommand('/match timeout 1').handled, true);
    assert.match(srv.lobby.handleCommand('/match timeout 1').error, /5–600/);
    assert.match(srv.lobby.handleCommand('/match help').lines.join('\n'), /\/match timeout/);
    assert.equal(srv.lobby.handleCommand('/match nonsense').handled, true);
    assert.equal(srv.lobby.handleCommand('/chat off').handled, true, 'the chat lever is untouched');
    assert.equal(srv.lobby.handleCommand('hello there').handled, false);
    srv.lobby.opts.matchmakingTimeoutMs = WAIT;
    await expectOk(a, { t: 'room.cancelMatchmaking' });
    await a.waitFor('room.closed', () => true);
  });

  test('the Lobby exposes the queue for /healthz', () => {
    assert.deepEqual(Object.keys(new Lobby({ registry: { byId: () => null }, log: quietLog() }).stats()).sort(),
      ['bots', 'humans', 'matches', 'matching', 'queued', 'rooms', 'spectators']);
  });
});
