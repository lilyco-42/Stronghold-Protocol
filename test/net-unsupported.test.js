// A newer client will meet an older server: the packaged desktop / Android builds outlive a server deploy, and the
// two sides share PROTOCOL_VERSION, so nothing flags it up front. `server/lobby.js` answers a message shape it does
// not know with BAD_MSG + `unhandled type <verb>` — that reply IS the capability probe. No version table to keep
// current, no guessing what a later release implements, and a server that knows the verb never lands here at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NetError, unhandledVerb, serverLacks, CLIENT_ERR_TEXT, errorText,
  Net, VERB_MIN_APP, versionAtLeast, healthUrl, serverHttpOrigin,
} from '../public/js/net.js';
import { ERR } from '../shared/constants.js';

test('unhandledVerb: only a BAD_MSG shaped like `unknown type <verb>` names a verb', () => {
  // server/net.js answers a type missing from shared/protocol.js — the real reply an older server gives.
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown type room.spectate'), 'room.spectate');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown type room.kick'), 'room.kick');
  // server/lobby.js answers a verb the table knows but its own switch does not dispatch.
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unhandled type g.emote'), 'g.emote');
  assert.equal(unhandledVerb(ERR.BAD_MSG, '  unknown type room.kick  '), 'room.kick', 'surrounding space is tolerated');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown chess char_128_plosis'), null, 'an ordinary validation detail');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown type '), null, 'no verb follows');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown type nodots'), null, 'a verb is always namespaced');
  assert.equal(unhandledVerb(ERR.BAD_MSG, ''), null);
  assert.equal(unhandledVerb(ERR.BAD_MSG, null), null);
  assert.equal(unhandledVerb(ERR.TIMEOUT, 'unknown type room.kick'), null, 'only BAD_MSG can mean "unknown verb"');
});

test('a refusal names the missing verb, reads as a sentence, and is remembered for that server only', () => {
  const url = 'ws://older-server.test/ws';
  const err = new NetError(ERR.BAD_MSG, '请求格式错误', 'unhandled type room.kick', url);
  assert.equal(err.missingVerb, 'room.kick');
  assert.equal(err.message, CLIENT_ERR_TEXT.UNSUPPORTED, 'the player is not shown a developer detail');
  assert.equal(serverLacks(url, 'room.kick'), true);
  assert.equal(serverLacks(url, 'room.spectate'), false, 'only the verb the server actually refused');
  assert.equal(serverLacks('ws://another-server.test/ws', 'room.kick'), false, 'a different server starts clean');
  assert.equal(serverLacks(null, 'room.kick'), false, 'no url, no claim');
});

test('the detail shapes that already worked keep their answers', () => {
  const version = new NetError(ERR.BAD_MSG, 'x', 'protocol version mismatch');
  assert.equal(version.message, CLIENT_ERR_TEXT.VERSION, 'the version detail still wins');
  assert.equal(version.missingVerb, null);

  const offline = new NetError('OFFLINE');
  assert.equal(offline.message, CLIENT_ERR_TEXT.OFFLINE);
  assert.equal(offline.missingVerb, null);

  const plain = new NetError(ERR.BAD_MSG, '房间不存在', 'no such room');
  assert.equal(plain.missingVerb, null);
  assert.equal(plain.message, errorText(ERR.BAD_MSG, '房间不存在'), 'an ordinary reply keeps errorText()');
});

test('a locally rejected request never claims the server lacks anything', () => {
  // net.request() rejects with BAD_MSG + a validation string before the socket sees the message (shared/protocol.js).
  const local = new NetError(ERR.BAD_MSG, '请求格式错误', 'seat must be an integer');
  assert.equal(local.missingVerb, null);
  assert.equal(serverLacks(undefined, 'room.kick'), false);
});

test('versionAtLeast compares the dotted app versions /healthz reports', () => {
  assert.equal(versionAtLeast('0.1.3', '0.1.3'), true);
  assert.equal(versionAtLeast('0.1.4', '0.1.3'), true);
  assert.equal(versionAtLeast('0.2.0', '0.1.3'), true);
  assert.equal(versionAtLeast('0.1.2', '0.1.3'), false);
  assert.equal(versionAtLeast('0.1', '0.1.3'), false, 'a shorter older version is still older');
  assert.equal(versionAtLeast('v0.1.3-dirty', '0.1.3'), true, 'a describe-style suffix does not demote it');
  assert.equal(versionAtLeast(null, '0.1.3'), false, 'nothing read is not "new enough"');
});

test('healthUrl stays relative for the web build and follows the socket for a packaged client', () => {
  // The web page is served BY the game server, so a relative path is the right (and long-tested) answer.
  assert.equal(healthUrl('ws://host.test/ws', { protocol: 'http:', host: 'host.test' }), '/healthz');
  assert.equal(healthUrl('wss://sp.lain42.top/ws', { protocol: 'https:', host: 'sp.lain42.top' }), '/healthz');
  // A packaged client: the page comes from the app's own loopback file server, the socket goes elsewhere.
  assert.equal(healthUrl('wss://sp.lain42.top/ws', { protocol: 'https:', host: '127.0.0.1:47821' }), 'https://sp.lain42.top/healthz');
  assert.equal(healthUrl('ws://192.168.1.9:3000/ws', { protocol: 'http:', host: '127.0.0.1:47821' }), 'http://192.168.1.9:3000/healthz');
  assert.equal(healthUrl('not a ws url', { protocol: 'https:', host: 'x.test' }), '/healthz', 'a junk url asks the page origin');
  assert.equal(serverHttpOrigin('wss://sp.lain42.top/ws'), 'https://sp.lain42.top');
});

test('a connection reads the server version once and greys only what that server is too old for', async () => {
  const page = globalThis.location;
  const asked = [];
  const net = new Net({
    url: 'ws://old-server.test/ws',
    fetchFn: (u) => { asked.push(u); return Promise.resolve({ ok: true, json: async () => ({ app: '0.1.1', protocol: 1 }) }); },
  });
  try {
    // A packaged client: the page is the app's own loopback origin, the socket goes to the game server.
    globalThis.location = { protocol: 'https:', host: '127.0.0.1:47821' };
    await net._probeServerInfo();
  } finally { globalThis.location = page; }
  assert.deepEqual(asked, ['http://old-server.test/healthz'], 'the probe goes to the socket host, not the page host');
  assert.equal(net.serverApp, '0.1.1');
  assert.equal(net.verbAvailable('room.spectate').ok, false, 'spectate needs 0.1.3');
  assert.equal(net.verbAvailable('room.kick').reason, 'older-server');
  assert.equal(net.verbAvailable('room.create').ok, true, 'every older verb stays available');
  assert.match(net.verbUnavailableText('room.spectate'), /0\.1\.1/, 'the reason quotes the server it found');

  const fresh = new Net({ url: 'ws://new.test/ws', fetchFn: async () => ({ ok: true, json: async () => ({ app: '0.1.3' }) }) });
  await fresh._probeServerInfo();
  assert.equal(fresh.verbAvailable('room.spectate').ok, true);
  assert.equal(fresh.verbUnavailableText('room.spectate'), '');
});

test('the web build probes its own origin relatively, exactly as ui/buildGuard.js expects', async () => {
  const page = globalThis.location;
  const asked = [];
  const net = new Net({
    url: 'wss://sp.lain42.top/ws',
    fetchFn: (u) => { asked.push(u); return Promise.resolve({ ok: true, json: async () => ({ app: '0.1.3' }) }); },
  });
  try {
    globalThis.location = { protocol: 'https:', host: 'sp.lain42.top' };
    await net._probeServerInfo();
  } finally { globalThis.location = page; }
  assert.deepEqual(asked, ['/healthz'], 'same origin → the relative path, no CORS question at all');
  assert.equal(net.serverApp, '0.1.3');
});

test('an unreadable /healthz locks nothing away, and the server own refusal still wins', async () => {
  const blind = new Net({ url: 'ws://self-hosted.test/ws', fetchFn: async () => { throw new Error('CORS'); } });
  await blind._probeServerInfo();
  assert.equal(blind.serverApp, null);
  assert.equal(blind.serverInfoFailed, true);
  assert.equal(blind.verbAvailable('room.spectate').ok, true, 'unknown version is not treated as an old server');

  // The reply is the authority: even a server that reported a new version can tell us it has no such verb (a fork).
  new NetError(ERR.BAD_MSG, '请求格式错误', 'unhandled type room.spectate', 'ws://self-hosted.test/ws');
  assert.equal(blind.verbAvailable('room.spectate').ok, false);
  assert.equal(blind.verbAvailable('room.spectate').reason, 'server-refused');
  assert.equal(blind.verbUnavailableText('room.spectate'), '这台服务器不支持该操作，请更新服务器版本');

  // A version too old for one verb never marks the others: the table only lists what is actually newer than the server.
  assert.equal(Object.keys(VERB_MIN_APP).every((v) => v.startsWith('room.')), true, 'only room verbs are pinned');
});
