// test/announcement.test.js — server-wide marquee announcement (shared/announcement.js rules, server/announcement.js
// board, POST /admin/announce, the lobby hello re-push).
//
// The feature is "one frame per announcement": the server broadcasts `server.announcement` once and every client
// derives its own position from `startedAt`, so what has to hold is
//   * the timing rules (announcementPhase) — every boundary of 3 passes × 30 s with a 5 min gap after each,
//   * the text rules (sanitizeAnnouncementText, parseAnnouncementCommand) — control characters and bidi overrides
//     never reach a terminal or a strip, length is counted in code points,
//   * the board's own state machine (publish / clear / expiry / broadcast reach),
//   * the operator endpoint (unset token ⇒ 404, wrong token ⇒ 401, and no malformed body answering 200),
//   * and the late-joiner path over a real WebSocket: the SAME startedAt reaches a client that hellos after the
//     publish, and a hello on a quiet server costs no frame at all (the resume protocol's frame order is pinned by
//     test/lobby.test.js 'match result replay').

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer, ADMIN_ANNOUNCE_PATH, ADMIN_TOKEN_ENV } from '../server/index.js';
import { AnnouncementBoard, ANNOUNCEMENT_TYPE } from '../server/announcement.js';
import {
  ANNOUNCEMENT, ANNOUNCEMENT_HELP, announcementLifetime, announcementPhase, parseAnnouncementCommand,
  sanitizeAnnouncementText,
} from '../shared/announcement.js';
import { S2C } from '../shared/protocol.js';
import { installConsole } from '../server/console.js';
import { TestClient } from './helpers/wsClient.js';

const quietLog = () => ({ info() {}, warn() {}, debug() {}, error() {} });

/** POST/GET with a body; resolves { status, headers, body(text) }. */
function req(port, path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

/** Publish through the operator endpoint. */
const post = (port, token, body, extra = {}) => req(port, ADMIN_ANNOUNCE_PATH, {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
});

// ---------------------------------------------------------------------------------------------------
// shared/announcement.js — the timing rules
// ---------------------------------------------------------------------------------------------------

describe('announcement timing (shared/announcement.js)', () => {
  test('lifetime is 3 passes + the 2 gaps between them', () => {
    assert.equal(ANNOUNCEMENT.passes, 3);
    assert.equal(ANNOUNCEMENT.scrollMs, 30_000);
    assert.equal(ANNOUNCEMENT.gapMs, 300_000);
    assert.equal(announcementLifetime(), 3 * 30_000 + 2 * 300_000);
    assert.equal(announcementLifetime(), 690_000);
    assert.ok(ANNOUNCEMENT.maxReceived > ANNOUNCEMENT.maxChars, 'a client accepts more than an operator may publish');
  });

  test('every boundary of the schedule', () => {
    const T = 1_000_000_000; // arbitrary server-clock origin
    const at = (ms) => announcementPhase(T, T + ms);

    // pass 1
    assert.deepEqual(at(0), { phase: 'scroll', pass: 1, offsetMs: 0, waitMs: 30_000 });
    assert.deepEqual(at(1), { phase: 'scroll', pass: 1, offsetMs: 1, waitMs: 29_999 });
    assert.deepEqual(at(29_999), { phase: 'scroll', pass: 1, offsetMs: 29_999, waitMs: 1 });
    // gap 1 (30 s → 5 min 30 s)
    assert.deepEqual(at(30_000), { phase: 'gap', pass: 1, waitMs: 300_000 });
    assert.deepEqual(at(329_999), { phase: 'gap', pass: 1, waitMs: 1 });
    // pass 2
    assert.deepEqual(at(330_000), { phase: 'scroll', pass: 2, offsetMs: 0, waitMs: 30_000 });
    // gap 2
    assert.deepEqual(at(360_000), { phase: 'gap', pass: 2, waitMs: 300_000 });
    // pass 3
    assert.deepEqual(at(660_000), { phase: 'scroll', pass: 3, offsetMs: 0, waitMs: 30_000 });
    // done
    assert.deepEqual(at(690_000), { phase: 'done', pass: 3, waitMs: 0 });
    assert.deepEqual(at(690_001), { phase: 'done', pass: 3, waitMs: 0 });
    assert.deepEqual(at(99_999_999), { phase: 'done', pass: 3, waitMs: 0 });
  });

  test('a clock behind the server is clamped (never a negative pass), junk reads as done', () => {
    const T = 1_000_000_000;
    // now < startedAt: a client whose offset is not settled yet must not compute a pass -1
    assert.deepEqual(announcementPhase(T, T - 60_000), { phase: 'scroll', pass: 1, offsetMs: 0, waitMs: 30_000 });
    assert.equal(announcementPhase(T, NaN).phase, 'done');
    assert.equal(announcementPhase(T, undefined).phase, 'done');
    assert.equal(announcementPhase(NaN, T).phase, 'done');
    assert.equal(announcementPhase('x', 'y').phase, 'done');
  });

  test('the scroll phases are what the CSS animation is driven from: offsetMs + waitMs === scrollMs', () => {
    const T = 0;
    for (const ms of [0, 1, 7_500, 15_000, 29_999]) {
      const p = announcementPhase(T, ms);
      assert.equal(p.phase, 'scroll');
      assert.equal(p.offsetMs + p.waitMs, ANNOUNCEMENT.scrollMs, `pass ${p.pass} @${ms}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// shared/announcement.js — the text rules
// ---------------------------------------------------------------------------------------------------

describe('announcement text (shared/announcement.js)', () => {
  test('sanitizeAnnouncementText drops controls and bidi, folds whitespace, trims', () => {
    // an ANSI colour sequence would otherwise run in the operator's terminal and in any log echoing it
    assert.equal(sanitizeAnnouncementText('\u001b[31m红\u001b[0m'), '[31m红 [0m');
    assert.equal(sanitizeAnnouncementText('a\u0000b\u0007c\u007fd\u0085e'), 'a b c d e');
    assert.equal(sanitizeAnnouncementText('a\u202eb'), 'a b');       // RLO
    assert.equal(sanitizeAnnouncementText('a\u2066b\u2069c'), 'a b c'); // LRI…PDI
    assert.equal(sanitizeAnnouncementText('a\n\tb'), 'a b');          // the strip is one line
    assert.equal(sanitizeAnnouncementText('  a   b  '), 'a b');
    assert.equal(sanitizeAnnouncementText(null), '');
    assert.equal(sanitizeAnnouncementText(undefined), '');
    assert.equal(sanitizeAnnouncementText(42), '42');
    // nothing but controls → empty (so a publish of it is refused)
    assert.equal(sanitizeAnnouncementText('\u0000\u001b\u202e'), '');
  });

  test('parseAnnouncementCommand: the two spellings, the sub-commands, and what is not a command', () => {
    assert.deepEqual(parseAnnouncementCommand('/announce 服务器 22:00 维护'), { action: 'publish', text: '服务器 22:00 维护' });
    assert.deepEqual(parseAnnouncementCommand('公告 服务器 22:00 维护'), { action: 'publish', text: '服务器 22:00 维护' });
    assert.deepEqual(parseAnnouncementCommand('announce  hi'), { action: 'publish', text: 'hi' });
    assert.deepEqual(parseAnnouncementCommand('/ANNOUNCE hi'), { action: 'publish', text: 'hi' });
    assert.deepEqual(parseAnnouncementCommand('  /announce   hi  '), { action: 'publish', text: 'hi' });
    // an empty command lists the usage instead of publishing an empty line
    assert.deepEqual(parseAnnouncementCommand('/announce'), { action: 'help' });
    assert.deepEqual(parseAnnouncementCommand('/announce   '), { action: 'help' });
    assert.deepEqual(parseAnnouncementCommand('/announce help'), { action: 'help' });
    assert.deepEqual(parseAnnouncementCommand('/announce HELP'), { action: 'help' });
    assert.deepEqual(parseAnnouncementCommand('/announce clear'), { action: 'clear' });
    assert.deepEqual(parseAnnouncementCommand('/announce status'), { action: 'status' });
    // not a command at all: the console keeps the line for something else
    assert.equal(parseAnnouncementCommand('hello'), null);
    assert.equal(parseAnnouncementCommand(''), null);
    assert.equal(parseAnnouncementCommand('   '), null);
    assert.equal(parseAnnouncementCommand(null), null);
    assert.equal(parseAnnouncementCommand('/announcement hi'), null, 'a longer word is a different command');
    assert.equal(parseAnnouncementCommand('say /announce hi'), null, 'only a whole line is a command');
    // controls are stripped before the text is handed on
    assert.deepEqual(parseAnnouncementCommand('/announce \u001b[31mhi'), { action: 'publish', text: '[31mhi' });
  });

  test('the length limit counts code points, and is applied after sanitizing', () => {
    const long = 'x'.repeat(ANNOUNCEMENT.maxChars);
    assert.deepEqual(parseAnnouncementCommand(`/announce ${long}`), { action: 'publish', text: long });
    const over = parseAnnouncementCommand(`/announce ${'x'.repeat(ANNOUNCEMENT.maxChars + 1)}`);
    assert.equal(over.action, 'error');
    assert.match(over.error, new RegExp(String(ANNOUNCEMENT.maxChars)));
    // an emoji is one character to the operator even though `.length` counts two
    assert.equal(parseAnnouncementCommand(`/announce ${'😀'.repeat(ANNOUNCEMENT.maxChars)}`).action, 'publish');
    assert.equal(parseAnnouncementCommand(`/announce ${'😀'.repeat(ANNOUNCEMENT.maxChars + 1)}`).action, 'error');
    // 500 control characters do not make a 2-character announcement too long
    assert.deepEqual(parseAnnouncementCommand(`/announce ${'\u0000'.repeat(500)}hi`), { action: 'publish', text: 'hi' });
  });

  test('the usage text documents the schedule it enforces', () => {
    assert.ok(ANNOUNCEMENT_HELP.includes('/announce'));
    assert.ok(ANNOUNCEMENT_HELP.includes('clear'));
    assert.ok(ANNOUNCEMENT_HELP.includes('status'));
    assert.ok(ANNOUNCEMENT_HELP.includes('公告'));
    assert.ok(ANNOUNCEMENT_HELP.includes(String(ANNOUNCEMENT.maxChars)), 'the character limit is stated');
  });

  test('server.announcement is a documented S2C push', () => {
    assert.ok(S2C.includes(ANNOUNCEMENT_TYPE), `${ANNOUNCEMENT_TYPE} is in shared/protocol.js S2C`);
  });
});

// ---------------------------------------------------------------------------------------------------
// server/announcement.js — the board
// ---------------------------------------------------------------------------------------------------

/** A registry whose sessions are plain objects with a fake socket. */
function fakeRegistry(count, { connected = true } = {}) {
  const byPlayerId = new Map();
  for (let i = 0; i < count; i++) {
    byPlayerId.set(`p_${i}`, {
      playerId: `p_${i}`,
      connected,
      ws: { readyState: 1, bufferedAmount: 0, sent: [], send(d) { this.sent.push(JSON.parse(d)); } },
    });
  }
  return { byPlayerId };
}

function board(registry, now = () => 1_000_000) {
  let id = 0;
  return new AnnouncementBoard({ registry, now, log: quietLog(), newId: () => `id${++id}` });
}

describe('AnnouncementBoard', () => {
  test('publish stores the text and broadcasts one frame to every connected session', () => {
    const reg = fakeRegistry(3);
    const b = board(reg);
    const res = b.publish('  服务器 22:00 维护  ');
    assert.deepEqual(res, { ok: true, id: 'id1', text: '服务器 22:00 维护', sent: 3 });
    for (const s of reg.byPlayerId.values()) {
      assert.equal(s.ws.sent.length, 1);
      const f = s.ws.sent[0];
      assert.equal(f.t, ANNOUNCEMENT_TYPE);
      assert.deepEqual(f.announcement, { id: 'id1', text: '服务器 22:00 维护', startedAt: 1_000_000 });
      assert.equal(f.serverNow, 1_000_000, 'the frame carries the server clock the startedAt belongs to');
    }
    assert.equal(b.current.text, '服务器 22:00 维护');
  });

  test('a disconnected session is skipped, not queued', () => {
    const reg = fakeRegistry(2);
    reg.byPlayerId.get('p_1').connected = false;
    const b = board(reg);
    assert.equal(b.publish('hi').sent, 1);
    assert.equal(reg.byPlayerId.get('p_0').ws.sent.length, 1);
    assert.equal(reg.byPlayerId.get('p_1').ws.sent.length, 0);
  });

  test('empty / whitespace-only / over-long text is refused and nothing is broadcast', () => {
    const reg = fakeRegistry(1);
    const b = board(reg);
    for (const bad of ['', '   ', '\u0000\u202e', null, undefined]) {
      const res = b.publish(bad);
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.equal(res.error, '公告内容不能为空。');
    }
    const long = b.publish('x'.repeat(ANNOUNCEMENT.maxChars + 1));
    assert.equal(long.ok, false);
    assert.match(long.error, /最多/);
    assert.equal(b.current, null);
    assert.equal(reg.byPlayerId.get('p_0').ws.sent.length, 0);
  });

  test('publishing again replaces the current one (one announcement at a time)', () => {
    const reg = fakeRegistry(1);
    const b = board(reg);
    b.publish('first');
    b.publish('second');
    assert.equal(b.current.text, 'second');
    assert.equal(reg.byPlayerId.get('p_0').ws.sent.length, 2);
    assert.equal(reg.byPlayerId.get('p_0').ws.sent[1].announcement.text, 'second');
  });

  test('an announcement expires on read, and the expiry is not broadcast (clients stop on their own)', () => {
    const reg = fakeRegistry(1);
    let now = 5_000;
    const b = new AnnouncementBoard({ registry: reg, now: () => now, log: quietLog(), newId: () => 'id1' });
    b.publish('hi');
    assert.equal(reg.byPlayerId.get('p_0').ws.sent.length, 1);
    now += announcementLifetime() - 1;
    assert.ok(b.current, 'still inside the lifetime');
    now += 1;
    assert.equal(b.current, null, 'expired');
    assert.equal(reg.byPlayerId.get('p_0').ws.sent.length, 1, 'no frame on expiry');
    // and the frame of an expired one reads as "no announcement"
    assert.equal(b.frame().announcement, null);
  });

  test('clear broadcasts announcement:null and forgets the text', () => {
    const reg = fakeRegistry(2);
    const b = board(reg);
    b.publish('hi');
    assert.deepEqual(b.clear(), { ok: true, cleared: true, sent: 2 });
    assert.equal(b.current, null);
    for (const s of reg.byPlayerId.values()) {
      assert.equal(s.ws.sent.length, 2);
      assert.equal(s.ws.sent[1].announcement, null);
    }
    assert.deepEqual(b.clear(), { ok: true, cleared: false, sent: 2 }, 'clearing twice is not an error');
  });

  test('sendTo restores a live announcement (same startedAt) and stays silent when there is none', () => {
    const reg = fakeRegistry(2);
    let now = 7_000;
    const b = new AnnouncementBoard({ registry: reg, now: () => now, log: quietLog(), newId: () => 'id1' });
    const late = reg.byPlayerId.get('p_1');
    late.ws.sent.length = 0;

    // nothing published yet: a hello must not cost a frame (the client's default state is already "no strip")
    assert.equal(b.sendTo(late), false);
    assert.equal(late.ws.sent.length, 0);

    b.publish('维护通知');
    late.ws.sent.length = 0;
    now += 120_000; // 2 minutes in: the late joiner is inside pass 1
    assert.equal(b.sendTo(late), true);
    assert.equal(late.ws.sent.length, 1);
    assert.deepEqual(late.ws.sent[0].announcement, { id: 'id1', text: '维护通知', startedAt: 7_000 }, 'the ORIGINAL startedAt, so only the remaining passes play');
    assert.equal(late.ws.sent[0].serverNow, now);

    // a disconnected session takes nothing
    late.connected = false;
    late.ws.sent.length = 0;
    assert.equal(b.sendTo(late), false);
    assert.equal(late.ws.sent.length, 0);

    // after a clear there is nothing to restore either
    late.connected = true;
    b.clear();
    late.ws.sent.length = 0;
    assert.equal(b.sendTo(late), false);
    assert.equal(late.ws.sent.length, 0);
    assert.equal(b.sendTo(null), false);
  });

  test('handleCommand: help / status / clear / publish / error, and a foreign line is not handled', () => {
    const reg = fakeRegistry(1);
    const b = board(reg);
    assert.deepEqual(b.handleCommand('ls -la'), { handled: false });

    const help = b.handleCommand('/announce help');
    assert.equal(help.handled, true);
    assert.deepEqual(help.lines, ANNOUNCEMENT_HELP.split('\n'));

    assert.deepEqual(b.handleCommand('/announce status').lines, ['当前没有公告。']);

    const pub = b.handleCommand('/announce 大家好');
    assert.equal(pub.handled, true);
    assert.match(pub.lines[0], /大家好/);
    assert.match(pub.lines[1], /1 个在线客户端/);

    const status = b.handleCommand('公告 status');
    assert.equal(status.lines[0], '当前公告：大家好');
    assert.match(status.lines[1], /剩余/);

    const tooLong = b.handleCommand(`/announce ${'x'.repeat(ANNOUNCEMENT.maxChars + 1)}`);
    assert.equal(tooLong.handled, true);
    assert.ok(tooLong.error, 'an over-long publish reports an error instead of throwing');
    assert.equal(b.current.text, '大家好', 'and does not replace what is on screen');

    const cleared = b.handleCommand('/announce clear');
    assert.equal(cleared.lines[0], '已清除公告（通知了 1 个客户端）。');
    assert.deepEqual(b.handleCommand('/announce clear').lines, ['当前没有公告。']);
  });

  test('a session that cannot take the frame is not counted as sent', () => {
    const reg = fakeRegistry(1);
    reg.byPlayerId.get('p_0').ws.readyState = 3; // CLOSED
    const b = board(reg);
    assert.equal(b.publish('hi').sent, 0);
  });
});

// ---------------------------------------------------------------------------------------------------
// server/console.js — the foreground operator console
// ---------------------------------------------------------------------------------------------------

describe('operator console (server/console.js)', () => {
  /** Just enough of a stream for readline (non-terminal mode) and for capturing what the console prints. */
  function fakeStreams() {
    const out = [];
    const stream = (isTTY) => ({
      isTTY, on() {}, once() {}, removeListener() {}, pause() {}, resume() {},
      write: (s) => { out.push(String(s)); return true; },
    });
    return { out, input: stream(false), output: stream(false) };
  }

  test('not attached without a TTY, attached when forced', () => {
    const s = fakeStreams();
    const b = board(fakeRegistry(0));
    assert.equal(installConsole({ board: b, log: quietLog(), input: s.input, output: s.output }), null);
    // …and not attached when only one of the two is a TTY either
    assert.equal(installConsole({ board: b, log: quietLog(), input: { ...s.input, isTTY: true }, output: s.output }), null);
    const c = installConsole({ board: b, log: quietLog(), input: s.input, output: s.output, force: true });
    assert.ok(c);
    assert.equal(typeof c.handleLine, 'function');
    assert.equal(typeof c.close, 'function');
    c.close();
  });

  test('handleLine drives the board and reports the outcome', () => {
    const s = fakeStreams();
    const reg = fakeRegistry(2);
    const b = board(reg);
    const c = installConsole({ board: b, log: quietLog(), input: s.input, output: s.output, force: true });
    try {
      assert.equal(c.handleLine('/announce 终端公告'), true);
      assert.equal(b.current.text, '终端公告');
      assert.equal(reg.byPlayerId.get('p_0').ws.sent.at(-1).announcement.text, '终端公告');
      assert.ok(s.out.some((l) => l.includes('终端公告')));

      assert.equal(c.handleLine(''), false, 'an empty line is ignored');
      assert.equal(c.handleLine('   '), false);
      assert.equal(c.handleLine('nonsense'), false, 'a foreign line is not an announcement command');
      assert.ok(s.out.some((l) => l.includes('未知命令')));

      assert.equal(c.handleLine(`/announce ${'x'.repeat(3000)}`), true, 'an over-long LINE is refused unread');
      assert.ok(s.out.some((l) => l.includes('命令行过长')));

      assert.equal(c.handleLine('/announce clear'), true);
      assert.equal(b.current, null);
    } finally {
      c.close();
    }
  });

  test('a throwing board does not take the console (or the server) down', () => {
    const s = fakeStreams();
    const boom = { handleCommand() { throw new Error('boom'); } };
    const c = installConsole({ board: boom, log: quietLog(), input: s.input, output: s.output, force: true });
    try {
      assert.equal(c.handleLine('/announce x'), true);
      assert.ok(s.out.some((l) => l.includes('boom')));
    } finally {
      c.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// POST /admin/announce + the WebSocket late-joiner path
// ---------------------------------------------------------------------------------------------------

describe('POST /admin/announce and the lobby hello re-push', () => {
  const TOKEN = 'tok_2f8c1d';
  let srv;
  let pool;
  const savedToken = process.env[ADMIN_TOKEN_ENV];

  const open = new Set();
  const player = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.add(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    return c;
  };

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: quietLog() });
  });
  afterEach(async () => {
    delete process.env[ADMIN_TOKEN_ENV];
    srv.announcements.clear();
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    open.clear();
  });
  after(async () => {
    await srv?.close();
    if (savedToken === undefined) delete process.env[ADMIN_TOKEN_ENV];
    else process.env[ADMIN_TOKEN_ENV] = savedToken;
  });

  test('without SP_ADMIN_TOKEN the endpoint does not exist (404, not 401)', async () => {
    delete process.env[ADMIN_TOKEN_ENV];
    const r = await post(srv.port, TOKEN, { text: 'x' });
    assert.equal(r.status, 404);
    assert.equal(srv.announcements.current, null);
    // a whitespace-only value is "unset", not an endpoint nobody can reach
    process.env[ADMIN_TOKEN_ENV] = '   ';
    assert.equal((await post(srv.port, TOKEN, { text: 'x' })).status, 404);
    process.env[ADMIN_TOKEN_ENV] = `\n${TOKEN}\n`;
    assert.equal((await post(srv.port, TOKEN, { text: 'x' })).status, 200, 'a stray newline in the config is forgiven');
    assert.equal(srv.announcements.current.text, 'x');
  });

  test('with the token: method, credential and body validation', async () => {
    process.env[ADMIN_TOKEN_ENV] = TOKEN;

    const get = await req(srv.port, ADMIN_ANNOUNCE_PATH, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');

    for (const bad of [null, '', 'wrong', TOKEN.slice(0, -1), TOKEN.toUpperCase(), `x${TOKEN}`, `${TOKEN}x`]) {
      const r = await post(srv.port, bad, { text: 'x' });
      assert.equal(r.status, 401, `token ${JSON.stringify(bad)}`);
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
    const basic = await post(srv.port, TOKEN, { text: 'x' }, { authorization: `Basic ${TOKEN}` });
    assert.equal(basic.status, 401, 'only a Bearer credential is accepted');
    assert.equal(srv.announcements.current, null, 'nothing published by any rejected request');

    // surrounding whitespace is not part of a credential, and the scheme name is case-insensitive (RFC 6750)
    const raw = (authorization) => req(srv.port, ADMIN_ANNOUNCE_PATH, {
      method: 'POST', body: JSON.stringify({ text: 'x' }), headers: { 'content-type': 'application/json', authorization },
    });
    for (const authorization of [`Bearer  ${TOKEN} `, `bearer ${TOKEN}`, `BEARER\t${TOKEN}`]) {
      assert.equal((await raw(authorization)).status, 200, JSON.stringify(authorization));
    }
    assert.equal(srv.announcements.current.text, 'x', 'those three did publish');
    srv.announcements.clear(); // so the "a malformed body publishes nothing" checks below start from empty

    const badJson = await post(srv.port, TOKEN, '{broken');
    assert.equal(badJson.status, 400);
    assert.match(badJson.body, /invalid json/);

    const empty = await post(srv.port, TOKEN, '');
    assert.equal(empty.status, 400);
    assert.match(empty.body, /empty body/);

    const blank = await post(srv.port, TOKEN, '   ');
    assert.equal(blank.status, 400);

    // a JSON body that names no intent must not fall through to the usage text
    for (const body of [{}, { foo: 1 }, { text: 42 }, { action: 'nope' }]) {
      const r = await post(srv.port, TOKEN, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body, /expected \{ text \}/);
    }
    assert.equal(srv.announcements.current, null);

    const tooLong = await post(srv.port, TOKEN, { text: 'x'.repeat(ANNOUNCEMENT.maxChars + 1) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body, /最多/);

    const huge = await post(srv.port, TOKEN, JSON.stringify({ text: 'x'.repeat(20_000) }));
    assert.equal(huge.status, 413);
    assert.equal(srv.announcements.current, null);
  });

  test('publish / status / clear, in JSON and as a plain text body', async () => {
    process.env[ADMIN_TOKEN_ENV] = TOKEN;

    const pub = await post(srv.port, TOKEN, { text: '  服务器 22:00 维护  ' });
    assert.equal(pub.status, 200);
    const body = JSON.parse(pub.body);
    assert.equal(body.ok, true);
    assert.equal(body.announcement.text, '服务器 22:00 维护');
    assert.equal(typeof body.announcement.id, 'string');
    assert.ok(Number.isFinite(body.announcement.startedAt));
    assert.match(body.message, /服务器 22:00 维护/);

    const status = JSON.parse((await post(srv.port, TOKEN, { action: 'status' })).body);
    assert.equal(status.ok, true);
    assert.equal(status.announcement.text, '服务器 22:00 维护');
    assert.match(status.message, /剩余/);

    // a bare text body is published as-is (curl -d '维护通知')
    const plain = JSON.parse((await post(srv.port, TOKEN, '维护通知', { 'content-type': 'text/plain' })).body);
    assert.equal(plain.announcement.text, '维护通知');
    assert.equal(srv.announcements.current.text, '维护通知');

    // { command } takes the very same lines the console does
    const help = JSON.parse((await post(srv.port, TOKEN, { command: '/announce help' })).body);
    assert.equal(help.ok, true);
    assert.match(help.message, /公告用法/);
    assert.equal(srv.announcements.current.text, '维护通知', 'help does not touch what is on screen');

    const clear = JSON.parse((await post(srv.port, TOKEN, { action: 'clear' })).body);
    assert.equal(clear.ok, true);
    assert.equal(clear.announcement, null);
    assert.equal(srv.announcements.current, null);
  });

  test('a connected client gets the frame; a later hello gets the same startedAt; a quiet server sends nothing', async () => {
    process.env[ADMIN_TOKEN_ENV] = TOKEN;

    const early = await player('早');
    // nothing published: hello cost no frame at all
    await early.expectNone(ANNOUNCEMENT_TYPE, () => true, 120);

    const { announcement } = JSON.parse((await post(srv.port, TOKEN, { text: '跑马灯公告' })).body);
    const got = await early.waitFor(ANNOUNCEMENT_TYPE);
    assert.equal(got.announcement.text, '跑马灯公告');
    assert.equal(got.announcement.id, announcement.id);
    assert.equal(got.announcement.startedAt, announcement.startedAt);
    assert.ok(Number.isFinite(got.serverNow), 'the frame carries the server clock');

    // a player who hellos afterwards is a late joiner: same id/startedAt, so only the remaining passes play
    const late = await player('晚');
    const lateGot = await late.waitFor(ANNOUNCEMENT_TYPE);
    assert.deepEqual(lateGot.announcement, got.announcement);
    assert.ok(lateGot.serverNow >= got.serverNow);

    // a repeated hello on a live socket re-sends it too (that is the resync path)
    early.clearInbox();
    await early.hello('早');
    assert.equal((await early.waitFor(ANNOUNCEMENT_TYPE)).announcement.id, announcement.id);

    // after a clear, a hello restores nothing (announcement:null is the client's own default)
    await post(srv.port, TOKEN, { action: 'clear' });
    const stopped = await early.waitFor(ANNOUNCEMENT_TYPE);
    assert.equal(stopped.announcement, null);
    const fresh = await player('新');
    await fresh.expectNone(ANNOUNCEMENT_TYPE, () => true, 120);
  });

  test('the frame is delivered outside any room too (it is server-wide, not per room)', async () => {
    process.env[ADMIN_TOKEN_ENV] = TOKEN;
    const a = await player('A');
    const b = await player('B');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await a.waitFor('room.state');
    await post(srv.port, TOKEN, { text: '全服公告' });
    for (const c of [a, b]) {
      assert.equal((await c.waitFor(ANNOUNCEMENT_TYPE)).announcement.text, '全服公告');
    }
  });
});
