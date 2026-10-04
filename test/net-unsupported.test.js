// A newer client will meet an older server: the packaged desktop / Android builds outlive a server deploy, and the
// two sides share PROTOCOL_VERSION, so nothing flags it up front. `server/lobby.js` answers a message shape it does
// not know with BAD_MSG + `unhandled type <verb>` — that reply IS the capability probe. No version table to keep
// current, no guessing what a later release implements, and a server that knows the verb never lands here at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NetError, unhandledVerb, serverLacks, CLIENT_ERR_TEXT, errorText } from '../public/js/net.js';
import { ERR } from '../shared/constants.js';

test('unhandledVerb: only a BAD_MSG shaped like `unhandled type <verb>` names a verb', () => {
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unhandled type room.spectate'), 'room.spectate');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unhandled type g.emote'), 'g.emote');
  assert.equal(unhandledVerb(ERR.BAD_MSG, '  unhandled type room.kick  '), 'room.kick', 'surrounding space is tolerated');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unknown chess char_128_plosis'), null, 'an ordinary validation detail');
  assert.equal(unhandledVerb(ERR.BAD_MSG, 'unhandled type '), null, 'no verb follows');
  assert.equal(unhandledVerb(ERR.BAD_MSG, ''), null);
  assert.equal(unhandledVerb(ERR.BAD_MSG, null), null);
  assert.equal(unhandledVerb(ERR.TIMEOUT, 'unhandled type room.kick'), null, 'only BAD_MSG can mean "unknown verb"');
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
