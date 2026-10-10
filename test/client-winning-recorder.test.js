import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientWinningRecorder, trainingSnapshot, SCHEMA } from '../public/js/ui/winningRecorder.js';
const state = () => ({
  room: { code: 'SECRETCODE', inMatch: true, mode: 'solo', difficulty: 'NORMAL' },
  match: {
    public: { phase: 'PREP', round: 8, modeId: 'solo_mode', difficulty: 'NORMAL',
      players: [{ playerId: 'alice', name: 'secret' }] },
    private: { playerId: 'alice', name: 'secret', seat: 0, funds: 13, lp: 80,
      bandId: 'band_blue', shop: { level: 4, frozen: false,
        slots: [{ kind: 'chess', id: 'c1', price: 3 }, null] },
      hand: [{ id: 'c2', kind: 'chess', uid: 123, name: 'private' }],
      board: [{ id: 'c3', kind: 'chess', uid: 456, row: 0, col: 1 }],
      effects: [{ id: 'effect_x', desc: 'Private Nick' }] },
  },
});
function setup() {
  const saved = [];
  let i = 0;
  const recorder = new ClientWinningRecorder({
    save: async record => { saved.push(record); },
    randomUUID: () => 'episode-' + ++i,
    maxDecisions: 3,
  });
  return { recorder, saved };
}
const result = { victory: true, players: [{ playerId: 'alice', isBot: false }],
  seed: 17, roundsPassed: 15 };

test('requires manual opt-in and server ok; records own pre-decision only', async () => {
  const { recorder, saved } = setup();
  const s = state();
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.onRoom(s.room);
  recorder.onOutgoing({ t: 'g.buy', slot: 1, rid: 1 }, s);
  recorder.onReply({ t: 'ok', rid: 1 });
  recorder.onResult(result, 'alice');
  await recorder.idle();
  assert.deepEqual(saved, []);
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  recorder.onOutgoing({ t: 'g.buy', slot: 1, rid: 2, name: 'Private Nick', token: 'secret' }, s);
  const snapshot = trainingSnapshot(s.match.public, s.match.private);
  assert.equal(snapshot.funds, 13);
  s.match.private.funds = 0; // capture must be from BEFORE the server action
  recorder.onReply({ t: 'ok', rid: 2 });
  recorder.onResult(result, 'alice');
  await recorder.idle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].schema, SCHEMA);
  assert.deepEqual(saved[0].samples[0].action, { type: 'g.buy', slot: 1 });
  assert.equal(saved[0].samples[0].state.funds, 13);
  assert.equal(recorder.consent, false);
  const json = JSON.stringify(saved[0]);
  for (const forbidden of ['SECRETCODE', 'alice', 'Private Nick', 'secret', 'token', 'chat']) {
    assert(!json.includes(forbidden), forbidden);
  }
});

test('errors, unconfirmed requests, team loss and spectators cannot produce stored wins', async () => {
  const { recorder, saved } = setup();
  const s = state();
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  recorder.onOutgoing({ t: 'g.refresh', rid: 1 }, s);
  recorder.onReply({ t: 'error', rid: 1 });
  recorder.onOutgoing({ t: 'g.buy', slot: 0, rid: 2 }, s);
  recorder.onResult(result, 'alice');
  await recorder.idle();
  assert.equal(saved.length, 0);
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  recorder.onOutgoing({ t: 'g.refresh', rid: 3 }, s);
  recorder.onReply({ t: 'ok', rid: 3 });
  recorder.onResult({ ...result, victory: false }, 'alice');
  await recorder.idle();
  assert.equal(saved.length, 0);
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  recorder.onOutgoing({ t: 'g.refresh', rid: 4 }, s);
  recorder.onReply({ t: 'ok', rid: 4 });
  recorder.onResult(result, 'spectator');
  await recorder.idle();
  assert.equal(saved.length, 0);
});

test('drops overflow and resets consent across room switches', async () => {
  const { recorder, saved } = setup();
  const s = state();
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  for (let rid = 1; rid <= 4; rid++) {
    recorder.onOutgoing({ t: 'g.refresh', rid }, s);
    recorder.onReply({ t: 'ok', rid });
  }
  recorder.onResult(result, 'alice');
  await recorder.idle();
  assert.deepEqual(saved, []);
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom({ ...s.room, code: 'DIFFERENT' });
  assert.equal(recorder.consent, false);
});

test('rejects non-policy actions and strips arbitrary strings and identity fields', () => {
  const { recorder } = setup();
  const s = state();
  recorder.onRoom({ ...s.room, inMatch: false });
  recorder.setConsent(true);
  recorder.onRoom(s.room);
  for (const msg of [{ t: 'g.emote', id: 'secret', rid: 10 },
    { t: 'b.result', rid: 11 }, { t: 'hello', name: 'Player Name', token: 'x', rid: 12 },
    { t: 'g.watch', playerId: 'other', rid: 13 }]) recorder.onOutgoing(msg, s);
  assert.equal(recorder.pending.size, 0);
  recorder.onOutgoing({ t: 'g.move', uid: 99, rid: 14,
    to: { area: 'board', row: 1, col: 2, token: 'private' } }, s);
  recorder.onReply({ t: 'ok', rid: 14 });
  assert.deepEqual(recorder.match.samples[0].action,
    { type: 'g.move', uid: 99, to: { area: "board", row: 1, col: 2 } });
});
test('browser export reads IndexedDB, downloads JSONL and never posts to a server', async () => {
  const { exportWinningEpisodes } = await import('../public/js/ui/winningRecorder.js');
  const stored = [{ schema: SCHEMA, episodeId: 'abc', samples: [{ action: { type: 'g.buy' } }] }];
  const db = {
    close() {},
    transaction: () => ({
      objectStore: () => ({
        getAll: () => {
          const req = {};
          queueMicrotask(() => { req.result = stored; req.onsuccess?.(); });
          return req;
        },
      }),
    }),
  };
  const indexedDB = {
    open: () => {
      const req = { result: db };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  const downloads = [];
  const document = { createElement: () => ({ click() { downloads.push(this.download); } }) };
  const URL = { createObjectURL: () => 'blob:local', revokeObjectURL: () => {} };
  assert.equal(await exportWinningEpisodes({ indexedDB, document, URL }), 1);
  assert.deepEqual(downloads, ['stronghold-winning-decisions.jsonl']);
});

test('net outgoing observation does not add a second socket message', async () => {
  const { Net } = await import('../public/js/net.js');
  const net = new Net();
  const sent = [];
  const observed = [];
  net.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
  net.on('outgoing', msg => observed.push(msg));
  assert.equal(net._sendRaw({ t: 'g.buy', rid: 5, slot: 2 }), true);
  assert.deepEqual(sent, [{ t: 'g.buy', rid: 5, slot: 2 }]);
  assert.deepEqual(observed, sent);
});
