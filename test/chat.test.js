// test/chat.test.js — friend-room chat: the shared rules (shared/chat.js), the lobby's log (server/lobby.js `chat`),
// and the operator's `/chat` switch.
//
// The browser half lives in test/ui/roomChat.test.js (frames + wiring) and test/ui/roomChat.e2e.test.js (the panel in
// headless Chrome). What has to hold here:
//
//   * length is counted in CODE POINTS — "最多 200 字" must mean the same to the counter under the input, the check
//     that refuses the send and the server that stores it, and an emoji is one 字;
//   * invisible characters never reach a log line: controls, bidi overrides (the "Trojan Source" `\u202e`), soft
//     hyphens and zero-widths go, every line-ish break becomes one space — but ZWNJ / ZWJ stay, because they are part
//     of legitimate emoji sequences and of Persian / Arabic / Indic spelling;
//   * the wire is untrusted input: a forged `room.chat` frame cannot put a 10 KB essay, a nameless message or an
//     out-of-order id into the client's log, and a frame from ANOTHER room is dropped rather than bled in;
//   * one message per session per second — the budget is the SESSION's, so leaving and rejoining does not reset it,
//     and a refused message does not consume it;
//   * a late joiner / spectator / reconnect gets the log, and a room that never used chat costs no frame at all (the
//     resume protocol's frame order is pinned by test/lobby.test.js 'match result replay');
//   * `/chat off` is a live kill switch: the very next `room.state` hides the panel in every open client and sends are
//     refused — and it is reachable from the console the game itself uses, not from a second source of truth.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { installConsole } from '../server/console.js';
import { Lobby } from '../server/lobby.js';
import { S2C, C2S } from '../shared/protocol.js';
import { CHAT, CHAT_HELP, chatLength, emptyChat, latestChatPreview, mergeChat, parseChatCommand, readChatMessage, readChatName, sanitizeChat, validChat } from '../shared/chat.js';
import { TestClient } from './helpers/wsClient.js';

const quietLog = () => ({ info() {}, warn() {}, debug() {}, error() {} });

// ---------------------------------------------------------------------------------------------------
// shared/chat.js — length and sanitizing
// ---------------------------------------------------------------------------------------------------

describe('chat length and sanitizing (shared/chat.js)', () => {
  test('the limits are the benchmark\'s, and maxInput is the UTF-16 twin of maxLen', () => {
    assert.equal(CHAT.maxLen, 200);
    assert.equal(CHAT.historyLimit, 50);
    assert.equal(CHAT.intervalMs, 1000);
    // `<input maxlength>` counts UTF-16 units, the counter and the server count code points: one emoji is 2 units
    // and 1 字, so the input bound has to be twice the code-point bound or a 200-emoji message could not be typed.
    assert.equal(CHAT.maxInput, CHAT.maxLen * 2);
    assert.ok(CHAT.maxReceived > CHAT.maxLen, 'a client renders more than it may send (a rogue or older server)');
  });

  test('length is code points, not UTF-16 units', () => {
    assert.equal(chatLength('abc'), 3);
    assert.equal(chatLength('😀'), 1, 'one emoji is one 字');
    assert.equal(chatLength('😀'.repeat(200)), 200);
    assert.equal('😀'.repeat(200).length, 400, 'but 400 UTF-16 units on the wire');
    assert.equal(chatLength(''), 0);
    assert.equal(chatLength(null), 0);
    assert.equal(chatLength(42), 0);
    assert.equal(chatLength(undefined), 0);
  });

  test('sanitizeChat: breaks fold to one space, invisibles go, whitespace collapses, the line is trimmed', () => {
    // the whole line-ish break set collapses to ONE space (a message is always a single line)
    assert.equal(sanitizeChat('a\nb'), 'a b');
    assert.equal(sanitizeChat('a\r\nb'), 'a b');
    assert.equal(sanitizeChat('a\tb'), 'a b');
    assert.equal(sanitizeChat('a\u000bb\u000cc'), 'a b c');
    assert.equal(sanitizeChat('a\u0085b\u2028c\u2029d'), 'a b c d');
    // Controls, DEL and the C1 block are REMOVED, not turned into spaces — the benchmark's rule, and the reason a
    // message can never carry a terminal escape into a log: `a\u0000b` is `ab`, and there is nothing left to run.
    assert.equal(sanitizeChat('a\u0000b\u0007c\u007fd\u009fe'), 'abcde');
    assert.equal(sanitizeChat('a\u001bb'), 'ab');
    // an ANSI colour sequence loses its ESC and stays literal text — it renders as `[31m`, never as colour
    assert.equal(sanitizeChat('\u001b[31m红\u001b[0m'), '[31m红[0m');
    // bidi overrides: the "Trojan Source" trick (`\u202e` flips the rest of the line) and the isolate run
    assert.equal(sanitizeChat('a\u202eb'), 'ab');
    assert.equal(sanitizeChat('a\u2066b\u2069c'), 'abc');
    // soft hyphen, zero-width space, the `\u2060-\u206f` format characters, the BOM
    assert.equal(sanitizeChat('a\u00adb'), 'ab');
    assert.equal(sanitizeChat('a\u200bb'), 'ab');
    assert.equal(sanitizeChat('a\u2060b\u2063c'), 'abc');
    assert.equal(sanitizeChat('\ufeffa'), 'a');
    // runs of spaces become one, and the ends are trimmed
    assert.equal(sanitizeChat('  a   b  '), 'a b');
    assert.equal(sanitizeChat('   '), '');
    // NFC: a decomposed form is composed, so two spellings of the same text are one message
    assert.equal(sanitizeChat('e\u0301'), '\u00e9');
    assert.equal(sanitizeChat('é'), '\u00e9');
    // not a string at all
    for (const bad of [null, undefined, 42, {}, [], true]) assert.equal(sanitizeChat(bad), '', JSON.stringify(bad));
    // nothing but invisibles → empty (so a send of it is refused rather than posted blank)
    assert.equal(sanitizeChat('\u0000\u001b\u202e\u200b'), '');
  });

  test('ZWNJ / ZWJ survive: they are part of real emoji sequences and of Persian / Arabic / Indic spelling', () => {
    // 👨‍👩‍👧 is three people joined by ZWJ — stripping it would render as three separate emoji
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    assert.equal(sanitizeChat(family), family);
    assert.equal(chatLength(family), 5, '3 emoji + 2 ZWJ');
    // ZWNJ is a real letter joiner in Persian
    assert.equal(sanitizeChat('می\u200cرود'), 'می\u200cرود');
    // …and a flag is two regional indicators
    const flag = '\u{1F1E8}\u{1F1F3}';
    assert.equal(sanitizeChat(flag), flag);
  });

  test('unpaired surrogates are dropped (a half-written emoji cannot reach a renderer)', () => {
    // a lone high surrogate, a lone low one, and a truncated pair in the middle
    assert.equal(sanitizeChat('a\ud83db'), 'ab');
    assert.equal(sanitizeChat('a\udc00b'), 'ab');
    assert.equal(sanitizeChat('a\ud83d\udc4db'), 'a\ud83d\udc4db', 'a well-formed pair is kept');
    // high surrogate followed by a NON-low-surrogate: the high one goes, the rest stays
    assert.equal(sanitizeChat('\ud83da'), 'a');
    assert.equal(sanitizeChat('\ud83d'), '');
    // and the result is always well-formed UTF-16
    for (const s of ['a\ud83db', 'a\udc00b', '\ud83d', 'a\ud83d\udc4db']) {
      assert.equal(typeof sanitizeChat(s), 'string');
      assert.equal(chatLength(sanitizeChat(s)), [...sanitizeChat(s)].length);
    }
  });

  test('an over-long input is refused whole, never silently truncated', () => {
    assert.equal(sanitizeChat('x'.repeat(CHAT.maxInput)), 'x'.repeat(CHAT.maxInput));
    assert.equal(sanitizeChat('x'.repeat(CHAT.maxInput + 1)), '', 'a 401-unit paste is a mistake to show, not to cut');
    // The unit bound is checked BEFORE anything is stripped, on purpose: 500 control characters plus `hi` is a
    // 502-unit payload, and a message that big is refused rather than quietly slimmed down to two characters. (This
    // is where chat differs from the announcement, whose bound is on the sanitized text.)
    assert.equal(sanitizeChat(`${'\u0000'.repeat(500)}hi`), '');
  });

  test('validChat: both bounds at once, and something must survive sanitizing', () => {
    assert.equal(validChat('hi'), true);
    assert.equal(validChat('😀'.repeat(CHAT.maxLen)), true);
    assert.equal(validChat('😀'.repeat(CHAT.maxLen + 1)), false, 'over the code-point bound');
    assert.equal(validChat('x'.repeat(CHAT.maxInput)), false, 'under the unit bound but over the 字 bound');
    assert.equal(validChat('x'.repeat(CHAT.maxInput + 1)), false, 'over the unit bound');
    assert.equal(validChat('   '), false);
    assert.equal(validChat('\u0000\u202e'), false);
    assert.equal(validChat(''), false);
    for (const bad of [null, undefined, 42, {}, []]) assert.equal(validChat(bad), false, JSON.stringify(bad));
  });
});

// ---------------------------------------------------------------------------------------------------
// shared/chat.js — names, messages, the log
// ---------------------------------------------------------------------------------------------------

describe('chat names and messages (shared/chat.js)', () => {
  test('readChatName sanitizes, bounds and falls back to 博士', () => {
    assert.equal(readChatName('凯尔希'), '凯尔希');
    // A name is a single line too, and a break is removed rather than turned into a space: `a\nb` is one word by the
    // time the server has stored it (`session.name` is sanitized on the way in), so this is a second guard, not the
    // first. What survives the strip is then collapsed: runs of real spaces become one.
    assert.equal(readChatName('  a\nb  '), 'ab');
    assert.equal(readChatName('  a   b  '), 'a b');
    assert.equal(readChatName('a\u202eb'), 'ab', 'a bidi override has no business in a name either');
    assert.equal(readChatName('x'.repeat(CHAT.maxNameLen + 10)), 'x'.repeat(CHAT.maxNameLen));
    assert.equal(readChatName('😀'.repeat(CHAT.maxNameLen + 10)).length, CHAT.maxNameLen * 2, 'truncated by code point');
    assert.equal(readChatName('   '), '博士');
    assert.equal(readChatName(''), '博士');
    assert.equal(readChatName('\u0000\u202e'), '博士');
    for (const bad of [null, undefined, 42, {}, []]) assert.equal(readChatName(bad), '博士', JSON.stringify(bad));
  });

  test('readChatMessage accepts a well-formed record and freezes it', () => {
    const m = readChatMessage({ id: 7, playerId: 'p_1', name: '甲', text: '  你好  ', at: 1234 });
    assert.deepEqual(m, { id: 7, playerId: 'p_1', name: '甲', text: '你好', at: 1234 });
    assert.ok(Object.isFrozen(m), 'frozen: nothing downstream may mutate what the log renders');
    assert.deepEqual(Object.keys(m), ['id', 'playerId', 'name', 'text', 'at'], 'extra fields are dropped');
    // `at` is optional — a missing / junk clock reads as null rather than NaN in the UI
    assert.equal(readChatMessage({ id: 1, playerId: 'p', name: 'n', text: 'x' }).at, null);
    assert.equal(readChatMessage({ id: 1, playerId: 'p', name: 'n', text: 'x', at: NaN }).at, null);
    assert.equal(readChatMessage({ id: 1, playerId: 'p', name: 'n', text: 'x', at: '12' }).at, null);
  });

  test('readChatMessage refuses anything malformed (a forged frame cannot reach the log)', () => {
    const good = { id: 1, playerId: 'p_1', name: '甲', text: '你好' };
    const bad = [
      null, undefined, 42, 'x', [], {},
      { ...good, id: undefined }, { ...good, id: 0 }, { ...good, id: -1 }, { ...good, id: 1.5 },
      { ...good, id: '1' }, { ...good, id: Number.MAX_SAFE_INTEGER + 2 }, { ...good, id: NaN },
      { ...good, playerId: undefined }, { ...good, playerId: '' }, { ...good, playerId: 7 },
      { ...good, playerId: 'p'.repeat(65) },
      { ...good, text: undefined }, { ...good, text: 42 }, { ...good, text: '' },
      { ...good, text: '   ' }, { ...good, text: '\u0000\u202e' },
      { ...good, text: 'x'.repeat(CHAT.maxReceived + 1) },
    ];
    for (const raw of bad) assert.equal(readChatMessage(raw), null, JSON.stringify(raw)?.slice(0, 90));
    // exactly at the bounds is fine
    assert.ok(readChatMessage({ ...good, id: Number.MAX_SAFE_INTEGER, playerId: 'p'.repeat(64) }));
    assert.ok(readChatMessage({ ...good, text: 'x'.repeat(CHAT.maxReceived) }));
  });

  test('emptyChat is a fresh, empty log for a room (or for none)', () => {
    assert.deepEqual(emptyChat(), { code: null, messages: [], liveSeq: 0 });
    assert.deepEqual(emptyChat('ABCD'), { code: 'ABCD', messages: [], liveSeq: 0 });
    assert.notEqual(emptyChat().messages, emptyChat().messages, 'a new array each time');
  });

  test('mergeChat: a message lands once, ordered by id, and only news bumps the unread count', () => {
    const one = (id, playerId, text) => ({ t: 'room.chat', code: 'ABCD', message: { id, playerId, name: 'x', text, at: id } });
    let s = emptyChat('ABCD');
    s = mergeChat(s, one(1, 'p_1', 'a'), { myId: 'p_0', roomCode: 'ABCD' });
    assert.deepEqual(s.messages.map((m) => m.text), ['a']);
    assert.equal(s.liveSeq, 1, 'a teammate\'s message is news');

    // the SAME frame again (a reconnect replay, a duplicate push): no second line, no second unread
    s = mergeChat(s, one(1, 'p_1', 'a'), { myId: 'p_0', roomCode: 'ABCD' });
    assert.equal(s.messages.length, 1);
    assert.equal(s.liveSeq, 1);

    // our own message is stored but is not "unread"
    s = mergeChat(s, one(2, 'p_0', 'mine'), { myId: 'p_0', roomCode: 'ABCD' });
    assert.deepEqual(s.messages.map((m) => m.text), ['a', 'mine']);
    assert.equal(s.liveSeq, 1, 'our own line is not a notification');

    // an out-of-order arrival is sorted by id, not by arrival
    s = mergeChat(s, one(3, 'p_1', 'c'), { myId: 'p_0', roomCode: 'ABCD' });
    s = mergeChat(s, one(5, 'p_1', 'e'), { myId: 'p_0', roomCode: 'ABCD' });
    s = mergeChat(s, one(4, 'p_1', 'd'), { myId: 'p_0', roomCode: 'ABCD' });
    assert.deepEqual(s.messages.map((m) => m.id), [1, 2, 3, 4, 5]);
    assert.equal(s.liveSeq, 4, 'the three teammate lines since the first');
  });

  test('mergeChat: a history frame never bumps the unread count (a restored log is not news)', () => {
    const history = { t: 'room.chatHistory', code: 'ABCD', messages: [
      { id: 1, playerId: 'p_1', name: 'a', text: 'one' },
      { id: 2, playerId: 'p_1', name: 'b', text: 'two' },
      { id: 3, playerId: 'p_1', name: 'c', text: 'three' },
    ] };
    const s = mergeChat(emptyChat(), history, { myId: 'p_0', roomCode: 'ABCD' });
    assert.equal(s.messages.length, 3);
    assert.equal(s.liveSeq, 0, 'a late joiner reading the backlog has no unread badge');
    // …and it keeps the code it was told
    assert.equal(s.code, 'ABCD');
  });

  test('mergeChat: a frame of ANOTHER room is dropped, and a room change starts a fresh log', () => {
    const one = (code, id) => ({ t: 'room.chat', code, message: { id, playerId: 'p_1', name: 'x', text: `m${id}` } });
    const held = mergeChat(emptyChat('ABCD'), one('ABCD', 1), { myId: 'p_0', roomCode: 'ABCD' });
    assert.equal(held.messages.length, 1);
    // a frame of the room we just left must not bleed into this one
    const dropped = mergeChat(held, one('WXYZ', 2), { myId: 'p_0', roomCode: 'ABCD' });
    assert.equal(dropped, held, 'the same object: nothing changed at all');
    // a frame of the room we are now in replaces the log rather than appending to another room's
    const moved = mergeChat(held, one('WXYZ', 9), { myId: 'p_0', roomCode: 'WXYZ' });
    assert.equal(moved.code, 'WXYZ');
    assert.deepEqual(moved.messages.map((m) => m.text), ['m9'], 'not m1 + m9');
    assert.equal(moved.liveSeq, 1);
    // no room code on the frame at all → nothing to do
    assert.equal(mergeChat(held, { t: 'room.chat', message: { id: 3, playerId: 'p_1', text: 'x' } }, { myId: 'p_0', roomCode: 'ABCD' }), held);
    // and without a roomCode to check against, a frame is taken as-is
    assert.equal(mergeChat(emptyChat(), one('ANY', 1)).messages.length, 1);
  });

  test('mergeChat: junk prev / junk frames read as an empty log, and the log is capped at historyLimit', () => {
    for (const prev of [null, undefined, 42, {}, { messages: 'x' }]) {
      assert.deepEqual(mergeChat(prev, { t: 'room.chat', code: 'A', message: { id: 1, playerId: 'p', text: 'x' } }), {
        code: 'A', messages: [{ id: 1, playerId: 'p', name: '博士', text: 'x', at: null }], liveSeq: 1,
      });
    }
    // a frame whose `message` is missing / junk still establishes the room
    assert.equal(mergeChat(emptyChat(), { t: 'room.chat', code: 'A' }).code, 'A');
    assert.equal(mergeChat(emptyChat(), { t: 'room.chat', code: 'A', message: 'x' }).messages.length, 0);
    // over the cap: the OLDEST go, and the newest is always there
    const many = { t: 'room.chatHistory', code: 'A', messages: Array.from({ length: CHAT.historyLimit + 20 }, (_, i) => ({ id: i + 1, playerId: 'p', text: `m${i + 1}` })) };
    const s = mergeChat(emptyChat(), many, { roomCode: 'A' });
    assert.equal(s.messages.length, CHAT.historyLimit);
    assert.equal(s.messages[0].id, 21, 'the first 20 fell off');
    assert.equal(s.messages.at(-1).id, CHAT.historyLimit + 20);
  });

  test('latestChatPreview prefers a teammate\'s newest line, then our own', () => {
    const msg = (id, playerId, text) => ({ id, playerId, text });
    // nobody else has spoken: our own newest line is still a preview, not an empty box
    assert.equal(latestChatPreview([msg(1, 'p_0', 'mine')], 'p_0').text, 'mine');
    // a teammate's line wins even when it is older than ours
    assert.equal(latestChatPreview([msg(1, 'p_1', 'theirs'), msg(2, 'p_0', 'mine')], 'p_0').text, 'theirs');
    // the newest teammate line, not the first
    assert.equal(latestChatPreview([msg(1, 'p_1', 'old'), msg(2, 'p_0', 'mine'), msg(3, 'p_2', 'new')], 'p_0').text, 'new');
    assert.equal(latestChatPreview([], 'p_0'), null);
    assert.equal(latestChatPreview(null, 'p_0'), null);
  });
});

// ---------------------------------------------------------------------------------------------------
// shared/chat.js — the operator command
// ---------------------------------------------------------------------------------------------------

describe('the /chat operator command (shared/chat.js)', () => {
  test('both spellings, every sub-command, and what is not a command at all', () => {
    assert.deepEqual(parseChatCommand('/chat'), { action: 'status' });
    assert.deepEqual(parseChatCommand('/chat status'), { action: 'status' });
    assert.deepEqual(parseChatCommand('/chat 状态'), { action: 'status' });
    assert.deepEqual(parseChatCommand('聊天'), { action: 'status' });
    assert.deepEqual(parseChatCommand('/chat help'), { action: 'help' });
    assert.deepEqual(parseChatCommand('/chat HELP'), { action: 'help' });
    assert.deepEqual(parseChatCommand('/chat ?'), { action: 'help' });
    assert.deepEqual(parseChatCommand('聊天 帮助'), { action: 'help' });
    assert.deepEqual(parseChatCommand('/chat on'), { action: 'on' });
    assert.deepEqual(parseChatCommand('/chat 开'), { action: 'on' });
    assert.deepEqual(parseChatCommand('chat off'), { action: 'off' });
    assert.deepEqual(parseChatCommand('/CHAT OFF'), { action: 'off' });
    assert.deepEqual(parseChatCommand('/chat 关'), { action: 'off' });
    assert.deepEqual(parseChatCommand('/chat clear'), { action: 'clear' });
    assert.deepEqual(parseChatCommand('/chat 清空'), { action: 'clear' });
    // not a command: the console keeps the line for something else
    assert.equal(parseChatCommand('/announce hi'), null);
    assert.equal(parseChatCommand('hello'), null);
    assert.equal(parseChatCommand(''), null);
    assert.equal(parseChatCommand('   '), null);
    assert.equal(parseChatCommand(null), null);
    assert.equal(parseChatCommand('/chatter'), null, 'a longer word is a different command');
    assert.equal(parseChatCommand('聊天室'), null);
    assert.equal(parseChatCommand('say /chat off'), null, 'only a whole line is a command');
    // an unknown sub-command is an error, not a silent no-op
    const bad = parseChatCommand('/chat nope');
    assert.equal(bad.action, 'error');
    assert.match(bad.error, /nope/);
    assert.match(bad.error, /\/chat help/);
  });

  test('the help text documents every sub-command it enforces', () => {
    for (const word of ['/chat', 'off', 'on', 'clear', 'help']) assert.ok(CHAT_HELP.includes(word), word);
  });

  test('room.chat is a documented C2S intent and a documented S2C push', () => {
    assert.ok(C2S['room.chat'], 'room.chat is in shared/protocol.js C2S');
    assert.ok(S2C.includes('room.chat'), 'room.chat is in shared/protocol.js S2C');
    assert.ok(S2C.includes('room.chatHistory'), 'room.chatHistory is in shared/protocol.js S2C');
  });
});

// ---------------------------------------------------------------------------------------------------
// server/lobby.js — the console command, driven directly (no socket)
// ---------------------------------------------------------------------------------------------------

describe('Lobby.handleCommand for /chat', () => {
  const lobby = () => new Lobby({ registry: { byPlayerId: new Map() }, log: quietLog() });

  test('status / help / off / on / clear, and a foreign line is not handled', () => {
    const l = lobby();
    assert.deepEqual(l.handleCommand('ls -la'), { handled: false });
    assert.deepEqual(l.handleCommand('/announce hi'), { handled: false }, 'the announcement board owns that line');

    const help = l.handleCommand('/chat help');
    assert.equal(help.handled, true);
    assert.deepEqual(help.lines, CHAT_HELP.split('\n'));

    const status = l.handleCommand('/chat');
    assert.equal(status.handled, true);
    assert.match(status.lines[0], /开启/);
    assert.match(status.lines[0], new RegExp(String(CHAT.maxLen)));
    assert.match(status.lines[1], /房间 0 个/);

    assert.equal(l.chatEnabled, true);
    const off = l.handleCommand('/chat off');
    assert.equal(off.handled, true);
    assert.equal(l.chatEnabled, false);
    assert.match(off.lines[0], /关闭/);
    // turning it off twice is not an error, and says so instead of repeating the same line
    assert.match(l.handleCommand('/chat off').lines[0], /已经是关闭状态/);
    assert.match(l.handleCommand('/chat on').lines[0], /已开启/);
    assert.equal(l.chatEnabled, true);
    assert.match(l.handleCommand('/chat on').lines[0], /已经是开启状态/);

    assert.match(l.handleCommand('/chat clear').lines[0], /没有聊天记录/);
    assert.equal(l.handleCommand('/chat nope').handled, true);
    assert.ok(l.handleCommand('/chat nope').error);
  });

  test('clear empties every room\'s log and counts what it dropped', () => {
    const l = lobby();
    // a bare object with the two fields handleCommand reads: the rooms map is private, and the counting is the point
    l.rooms.set('A', { code: 'A', chat: [{ id: 1 }, { id: 2 }] });
    l.rooms.set('B', { code: 'B', chat: [{ id: 1 }] });
    assert.match(l.handleCommand('/chat').lines[1], /共 3 条/);
    const cleared = l.handleCommand('/chat clear');
    assert.match(cleared.lines[0], /3 条/);
    assert.equal(l.rooms.get('A').chat.length, 0);
    assert.equal(l.rooms.get('B').chat.length, 0);
    assert.match(l.handleCommand('/chat').lines[1], /共 0 条/);
  });
});

// ---------------------------------------------------------------------------------------------------
// server/console.js — several command sources, one console
// ---------------------------------------------------------------------------------------------------

describe('operator console with several command sources (server/console.js)', () => {
  function fakeStreams() {
    const out = [];
    const stream = () => ({
      isTTY: false, on() {}, once() {}, removeListener() {}, pause() {}, resume() {},
      write: (s) => { out.push(String(s)); return true; },
    });
    return { out, input: stream(), output: stream() };
  }

  test('a line is claimed by the first source that handles it; an unclaimed line reports the hint', () => {
    const s = fakeStreams();
    const calls = [];
    const announce = { handleCommand: (line) => { calls.push(['announce', line]); return line.startsWith('/announce') ? { handled: true, lines: ['announced'] } : { handled: false }; } };
    const chat = { handleCommand: (line) => { calls.push(['chat', line]); return line.startsWith('/chat') ? { handled: true, lines: ['chatted'] } : { handled: false }; } };
    const c = installConsole({ handlers: [announce, chat], hint: '未知命令。可用命令：/announce help、/chat help。', log: quietLog(), input: s.input, output: s.output, force: true });
    try {
      assert.equal(c.handleLine('/announce 公告内容'), true);
      assert.ok(s.out.some((l) => l.includes('announced')));
      // the first source claimed it, so the second was never asked
      assert.deepEqual(calls.at(-1), ['announce', '/announce 公告内容']);

      assert.equal(c.handleLine('/chat off'), true);
      assert.deepEqual(calls.at(-1), ['chat', '/chat off']);

      assert.equal(c.handleLine('nonsense'), false);
      assert.ok(s.out.some((l) => l.includes('未知命令')));
      assert.ok(s.out.some((l) => l.includes('/chat help')), 'the hint lists the sources');
    } finally {
      c.close();
    }
  });

  test('a source that throws is reported, never takes the server down, and the line stops there', () => {
    const s = fakeStreams();
    let secondAsked = false;
    const boom = { handleCommand() { throw new Error('boom'); } };
    const second = { handleCommand: () => { secondAsked = true; return { handled: true, lines: ['second source'] }; } };
    const c = installConsole({ handlers: [boom, second], log: quietLog(), input: s.input, output: s.output, force: true });
    try {
      assert.equal(c.handleLine('/chat'), true);
      assert.ok(s.out.some((l) => l.includes('boom')), 'the failure is reported, not swallowed');
      // Deliberate: a source that threw has already consumed the line as far as the operator is concerned, and asking
      // the next source to guess at the same line would only turn one error into two commands.
      assert.equal(secondAsked, false);
    } finally {
      c.close();
    }
  });

  test('handlers that are not command sources are ignored, and the console attaches without a TTY only when forced', () => {
    const s = fakeStreams();
    assert.equal(installConsole({ handlers: [null, undefined, {}, { handleCommand: 'x' }], log: quietLog(), input: s.input, output: s.output }), null);
    const c = installConsole({ handlers: [null, {}, { handleCommand: () => ({ handled: false }) }], log: quietLog(), input: s.input, output: s.output, force: true });
    assert.ok(c);
    assert.equal(c.handleLine('anything'), false);
    c.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// room.chat over a real socket
// ---------------------------------------------------------------------------------------------------

describe('room.chat over a real socket', () => {
  let srv;
  /** @type {Set<TestClient>} */
  const open = new Set();

  const player = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.add(c);
    const w = await c.hello(name, token);
    return { c, welcome: w };
  };

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log: quietLog() });
  });
  // One server for the whole describe (starting one per test would dominate the runtime), so every test starts from
  // the same place: no lingering sockets, no rooms, chat on. Otherwise a room a previous test left open shows up in
  // `/chat`'s message count and a `maxRooms` cap can turn a later `room.create` into an error.
  afterEach(async () => {
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    open.clear();
    srv.lobby.handleCommand('/chat on');
    srv.lobby.rooms.clear();
  });
  after(async () => {
    await srv?.close();
  });

  test('a co-op room advertises chatEnabled, and a send reaches every member (sender, player, spectator)', async () => {
    const { c: a } = await player('甲');
    const { c: b } = await player('乙');
    const { c: sp } = await player('观战');

    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const st = await a.waitFor('room.state');
    assert.equal(st.chatEnabled, true, 'the panel is only rendered for a true flag');
    const code = st.code;

    await b.request({ t: 'room.join', code });
    assert.equal((await b.waitFor('room.state')).chatEnabled, true);
    await sp.request({ t: 'room.spectate', code });
    assert.equal((await sp.waitFor('room.state')).chatEnabled, true);

    const rep = await a.request({ t: 'room.chat', text: '  大家  好\r\n第二行\u202e反转  ' });
    assert.equal(rep.t, 'ok', JSON.stringify(rep));
    const [ma, mb, ms] = await Promise.all([a.waitFor('room.chat'), b.waitFor('room.chat'), sp.waitFor('room.chat')]);
    // one stored message, broadcast verbatim to everyone — the sender included, so nothing can double up
    assert.deepEqual(ma, mb);
    assert.deepEqual(ma, ms);
    assert.equal(ma.code, code, 'the frame names the room');
    assert.equal(ma.message.text, '大家 好 第二行反转', 'sanitized on the server, not in the client');
    assert.equal(ma.message.name, '甲', 'the sender\'s name is snapshotted into the message');
    assert.equal(ma.message.id, 1, 'the room\'s message ids start at 1');
    assert.ok(Number.isFinite(ma.message.at));
    assert.equal(typeof ma.message.playerId, 'string');
    assert.ok(ma.message.playerId.length > 0);

    // …and the log the server holds is exactly that one message
    assert.equal(srv.lobby.rooms.get(code).chat.length, 1);
  });

  test('a solo room is chat-enabled too (the server accepts it; only the panel is not rendered)', async () => {
    const { c: a } = await player('独');
    await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const st = await a.waitFor('room.state');
    assert.equal(st.chatEnabled, true, 'the flag is the server\'s; the solo exception is the client\'s');
    const rep = await a.request({ t: 'room.chat', text: '一个人也能说' });
    assert.equal(rep.t, 'ok');
    assert.equal((await a.waitFor('room.chat')).message.text, '一个人也能说');
  });

  test('one message per session per second, and a refused message does not consume the budget', async () => {
    const { c: a } = await player('快');
    const { c: b } = await player('慢');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    await b.request({ t: 'room.join', code });
    await b.waitFor('room.state');

    assert.equal((await a.request({ t: 'room.chat', text: '第一条' })).t, 'ok');
    await a.waitFor('room.chat');
    const fast = await a.request({ t: 'room.chat', text: '太快了' });
    assert.equal(fast.t, 'error');
    assert.equal(fast.code, 'RATE');

    // another session has its own budget: the limit is per SESSION, not per room
    assert.equal((await b.request({ t: 'room.chat', text: '我也说' })).t, 'ok');
    await b.waitFor('room.chat');

    // a refused message must not consume the sender's budget — but the successful one still owns its second
    assert.equal((await b.request({ t: 'room.chat', text: '   ' })).code, 'BAD_MSG');
    assert.equal((await b.request({ t: 'room.chat', text: '字'.repeat(CHAT.maxLen + 1) })).code, 'BAD_MSG');
    assert.equal((await b.request({ t: 'room.chat', text: '字'.repeat(CHAT.maxInput + 1) })).code, 'BAD_MSG', 'refused by the protocol');
    // …so a good message one interval later still works, without the refusals having eaten the budget
    await new Promise((r) => setTimeout(r, CHAT.intervalMs + 50));
    assert.equal((await b.request({ t: 'room.chat', text: '现在可以了' })).t, 'ok');
  });

  test('the budget belongs to the SESSION: leaving and rejoining does not hand out a fresh one', async () => {
    const { c: a } = await player('反复');
    const { c: b } = await player('留守'); // keeps the room alive: a lone member leaving disposes it (see below)
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    await b.request({ t: 'room.join', code });
    await b.waitFor('room.state');

    assert.equal((await a.request({ t: 'room.chat', text: '一' })).t, 'ok');
    await a.waitFor('room.chat');
    await a.request({ t: 'room.leave' });
    a.clearInbox();
    await a.request({ t: 'room.join', code });
    await a.waitFor('room.state');

    const again = await a.request({ t: 'room.chat', text: '二' });
    assert.equal(again.t, 'error', 'a rejoin is not a new budget');
    assert.equal(again.code, 'RATE');
  });

  test('the last member leaving disposes the room, log and all (there is nobody left to read it)', async () => {
    const { c: a } = await player('独行');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    await a.request({ t: 'room.chat', text: '留个纪念' });
    await a.waitFor('room.chat');
    assert.equal(srv.lobby.rooms.get(code).chat.length, 1);

    await a.request({ t: 'room.leave' });
    assert.equal(srv.lobby.rooms.has(code), false, 'the room went with the last member');
    // …and the code is free again: a rejoin is a plain ROOM_NOT_FOUND, not a resurrection
    const back = await a.request({ t: 'room.join', code });
    assert.equal(back.t, 'error');
    assert.equal(back.code, 'ROOM_NOT_FOUND');
  });

  test('a late joiner, a spectator and a reconnect all get the log; a room that never chatted costs no frame', async () => {
    const { c: a } = await player('历史');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    await a.request({ t: 'room.chat', text: '第一句' });
    await a.waitFor('room.chat');
    await new Promise((r) => setTimeout(r, CHAT.intervalMs + 50));
    await a.request({ t: 'room.chat', text: '第二句' });
    await a.waitFor('room.chat');

    // a player who joins afterwards reads the backlog
    const { c: late } = await player('迟到');
    await late.request({ t: 'room.join', code });
    await late.waitFor('room.state');
    const hist = await late.waitFor('room.chatHistory');
    assert.equal(hist.code, code);
    assert.deepEqual(hist.messages.map((m) => m.text), ['第一句', '第二句']);
    assert.deepEqual(hist.messages.map((m) => m.id), [1, 2]);
    assert.equal(hist.messages[0].name, '历史', 'the sender\'s name travelled with the line');

    // a spectator too
    const { c: sp } = await player('旁观');
    await sp.request({ t: 'room.spectate', code });
    await sp.waitFor('room.state');
    assert.equal((await sp.waitFor('room.chatHistory')).messages.length, 2);

    // and a reconnect (a fresh session with the same token) is re-pushed the log
    const { c: b, welcome } = await player('重连');
    await b.request({ t: 'room.join', code });
    await b.waitFor('room.state');
    await b.terminate();
    open.delete(b);
    const { c: b2 } = await player('重连', welcome.token);
    assert.equal((await b2.waitFor('room.chatHistory')).messages.length, 2);

    // a room that never used chat: joining costs no frame at all
    const { c: fresh } = await player('干净');
    await fresh.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    const clean = (await fresh.waitFor('room.state')).code; // read the state BEFORE clearing the inbox
    fresh.clearInbox();
    const { c: joiner } = await player('进新');
    await joiner.request({ t: 'room.join', code: clean });
    await joiner.waitFor('room.state');
    await joiner.expectNone('room.chatHistory', () => true, 200);
  });

  test('a send outside any room is refused', async () => {
    const { c: a } = await player('散人');
    const rep = await a.request({ t: 'room.chat', text: 'hi' });
    assert.equal(rep.t, 'error');
    assert.equal(rep.code, 'NOT_IN_ROOM');
  });

  test('/chat off is a live kill switch: the next room.state carries false and sends are refused', async () => {
    const { c: a } = await player('开关');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await a.waitFor('room.state');
    try {
      const off = srv.lobby.handleCommand('/chat off');
      assert.equal(off.handled, true);
      assert.equal(srv.lobby.chatEnabled, false);
      a.clearInbox();
      const st = await a.waitFor('room.state');
      assert.equal(st.chatEnabled, false, 'the panel is hidden in every open client at once');
      const refused = await a.request({ t: 'room.chat', text: '还能发吗' });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, 'WRONG_PHASE');
      // a new joiner sees the same flag
      const { c: b } = await player('新来');
      await b.request({ t: 'room.join', code: st.code });
      assert.equal((await b.waitFor('room.state')).chatEnabled, false);
      await b.request({ t: 'room.leave' });

      const on = srv.lobby.handleCommand('/chat on');
      assert.equal(on.handled, true);
      assert.equal(srv.lobby.chatEnabled, true);
      a.clearInbox();
      assert.equal((await a.waitFor('room.state')).chatEnabled, true);
      await new Promise((r) => setTimeout(r, CHAT.intervalMs + 50));
      assert.equal((await a.request({ t: 'room.chat', text: '回来了' })).t, 'ok');
    } finally {
      srv.lobby.handleCommand('/chat on');
    }
  });

  test('/chat clear empties the logs; clients keep what they already have and a reconnect clears with it', async () => {
    const { c: a } = await player('清理');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    await a.request({ t: 'room.chat', text: '要被清掉' });
    await a.waitFor('room.chat');
    assert.equal(srv.lobby.rooms.get(code).chat.length, 1);

    const cleared = srv.lobby.handleCommand('/chat clear');
    assert.match(cleared.lines[0], /1 条/);
    assert.equal(srv.lobby.rooms.get(code).chat.length, 0);

    // a client that is already in the room keeps its own copy — nothing is pushed
    await a.expectNone('room.chatHistory', () => true, 200);
    // …but a fresh join gets an empty log, and an empty log is no frame at all
    const { c: b } = await player('新进');
    await b.request({ t: 'room.join', code });
    await b.waitFor('room.state');
    await b.expectNone('room.chatHistory', () => true, 200);
  });

  test('the log dies with the room, and the last CHAT.historyLimit lines are what a joiner reads', async () => {
    const { c: a } = await player('长聊');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const code = (await a.waitFor('room.state')).code;
    // fill past the cap through the Lobby directly (one per second over a socket would take a minute)
    const room = srv.lobby.rooms.get(code);
    for (let i = 1; i <= CHAT.historyLimit + 10; i++) room.chat.push({ id: i, playerId: 'p', name: 'n', text: `m${i}`, at: i });
    room.chat.splice(0, room.chat.length - CHAT.historyLimit);

    const { c: late } = await player('后到');
    await late.request({ t: 'room.join', code });
    await late.waitFor('room.state');
    const hist = await late.waitFor('room.chatHistory');
    assert.equal(hist.messages.length, CHAT.historyLimit);
    assert.equal(hist.messages[0].id, 11, 'the oldest ten fell off');

    // leaving the room releases the log (it is in memory only, and this is a small box)
    await late.request({ t: 'room.leave' });
    await a.request({ t: 'room.leave' });
    // the host leaving disposes the room once nobody is left
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.lobby.rooms.get(code)?.chat?.length ?? 0, 0);
  });
});
