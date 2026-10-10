import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WinningEpisodeRecorder, winningEpisodesFromEnv } from '../server/telemetry/winningEpisodes.js';
import { Lobby, Room } from '../server/lobby.js';
import { validateC2S } from '../shared/protocol.js';

const sampleMatch = () => {
  const ps = {
    playerId: 'secret-id', name: 'Private Nickname', seat: 2, isBot: false,
    alive: true, left: false, lp: 45, funds: 10, bandId: 'band_A',
    shop: { level: 3, frozen: false, slots: [{ kind: 'chess', id: 'op_001', price: 3, sold: false }] },
    hand: [{ kind: 'chess', id: 'op_002', uid: 93, items: [] }],
    temp: [], board: new Map([['0,0', { kind: 'chess', uid: 7, id: 'op_003' }]]),
    layers: { foo: 3 }, effects: [{ id: 'effectA', name: 'Private Nickname' }],
    priceOf: s => s.price,
  };
  return { players: new Map([['secret-id', ps]]), phase: 'PREP', round: 8, ps };
};
async function withRecorder(fn, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sp-winning-'));
  const log = { error() { throw Error('unexpected save error'); }, warn() {} };
  const recorder = new WinningEpisodeRecorder({ dir, log, ...opts });
  try { await fn(recorder, dir); } finally { await recorder.idle(); await rm(dir, { recursive: true, force: true }); }
}
const list = dir => readdir(dir);

test('explicit opt-in remains off by default', () => {
  assert.equal(winningEpisodesFromEnv({ env: {} }), null);
  assert.equal(winningEpisodesFromEnv({ env: { SP_WIN_EPISODES: 'yes' } }), null);
});

test('only server-accepted strategic decisions become anonymous winning episodes', async () => {
  await withRecorder(async (recorder, dir) => {
    const { players, ...m } = sampleMatch();
    const match = { ...m, players };
    const ep = recorder.start({ mode: 'coop', difficulty: 'HARD', seed: 987, consentedSeats: [2] });
    const msg = { t: 'g.buy', slot: 0, rid: 'private-rid', playerId: 'secret-id', name: 'Private Nickname' };
    const s = recorder.prepare(ep, match, 'secret-id', msg);
    assert.equal(s.state.funds, 10);
    assert.equal(s.state.shop.slots[0].id, 'op_001');
    assert.deepEqual(s.action, { type: 'g.buy', slot: 0 });
    recorder.accept(ep, s);
    assert.equal(recorder.prepare(ep, match, 'secret-id', { t: 'g.emote', id: 'secret' }), null);
    assert.equal(recorder.prepare(ep, match, 'secret-id', { t: 'b.result', privateData: true }), null);
    recorder.finish(ep, { victory: true, reason: 'victory', roundsPassed: 15 });
    await Promise.resolve();
    await recorder.idle();
    const files = await list(dir);
    assert.equal(files.length, 1);
    const data = JSON.parse(gunzipSync(await readFile(join(dir, files[0]))));
    assert.equal(data.schema, 'sp.winning-decisions.v1');
    assert.equal(data.outcome.victory, true);
    assert.equal(data.samples.length, 1);
    assert.equal(data.samples[0].seat, 2);
    assert(!JSON.stringify(data).includes('Private Nickname'));
    assert(!JSON.stringify(data).includes('secret-id'));
    assert(!JSON.stringify(data).includes('private-rid'));
  });
});

test('defeat or aborted match exports nothing', async () => {
  await withRecorder(async (recorder, dir) => {
    const match = sampleMatch();
    for (const verdict of [{ victory: false }, { victory: true, reason: 'error' }, null]) {
      const ep = recorder.start({ mode: 'solo', difficulty: 'NORMAL', seed: 4, consentedSeats: [2] });
      recorder.accept(ep, recorder.prepare(ep, match, 'secret-id', { t: 'g.refresh' }));
      recorder.finish(ep, verdict);
    }
    await Promise.resolve();
    await recorder.idle();
    assert.deepEqual(await list(dir), []);
  });
});

test('oversized episodes are discarded instead of exporting incomplete strategies', async () => {
  await withRecorder(async (recorder, dir) => {
    const match = sampleMatch();
    const ep = recorder.start({ mode: 'solo', difficulty: 'NORMAL', seed: 4, consentedSeats: [2] });
    for (let i = 0; i < 3; i++) recorder.accept(ep, recorder.prepare(ep, match, 'secret-id', { t: 'g.refresh' }));
    assert.equal(ep.truncated, true);
    recorder.finish(ep, { victory: true });
    await Promise.resolve();
    await recorder.idle();
    assert.deepEqual(await list(dir), []);
  }, { maxActions: 2 });
});

test('winning final action is accepted even when finish fires synchronously during match.handle', async () => {
  await withRecorder(async (recorder, dir) => {
    const match = sampleMatch();
    const ep = recorder.start({ mode: 'solo', difficulty: 'NORMAL', seed: 5, consentedSeats: [2] });
    const lobby = Object.create(Lobby.prototype);
    const ctx = { episode: ep };
    const room = { matchCtx: ctx, spectatorOf: () => false, match: Object.assign(match, {
      handle() {
        recorder.finish(ep, { victory: true, reason: 'victory' });
        return { ok: true };
      },
    }) };
    lobby.roomOf = () => room;
    lobby.winEpisodes = recorder;
    lobby.log = { error() {} };
    assert.deepEqual(lobby.routeGame({ playerId: 'secret-id' }, { t: 'g.buy', slot: 0 }), { ok: true });
    await Promise.resolve();
    await recorder.idle();
    assert.equal((await list(dir)).length, 1);
    assert.equal(ep.actions.length, 0);
  });
});

test('rejected server intent is not included in dataset', async () => {
  await withRecorder(async (recorder) => {
    const match = sampleMatch();
    const ep = recorder.start({ mode: 'solo', difficulty: 'NORMAL', seed: 5, consentedSeats: [2] });
    const lobby = Object.create(Lobby.prototype);
    const room = { matchCtx: { episode: ep }, spectatorOf: () => false, match: Object.assign(match, {
      handle() { return { error: 'BAD_MSG' }; },
    }) };
    lobby.roomOf = () => room;
    lobby.winEpisodes = recorder;
    lobby.log = { error() {} };
    assert.equal(lobby.routeGame({ playerId: 'secret-id' }, { t: 'g.buy', slot: 0 }).error, 'BAD_MSG');
    assert.equal(ep.actions.length, 0);
  });
});


test("non-consenting players cannot be included even when the server recorder is on", async () => {
  await withRecorder(async (recorder, dir) => {
    const match = sampleMatch();
    const ep = recorder.start({ mode: "coop", difficulty: "HARD", seed: 1, consentedSeats: [0] });
    assert.equal(recorder.prepare(ep, match, "secret-id", { t: "g.buy", slot: 0 }), null);
    recorder.finish(ep, { victory: true });
    await Promise.resolve(); await recorder.idle();
    assert.deepEqual(await list(dir), []);
  });
});

test("room consent is voluntary, disabled when collection is off, and cannot be changed mid-game", () => {
  const room = { match: null, spectatorOf: () => null, seatOf: () => seat };
  const seat = { playerId: "secret-id", isBot: false, trainingOptIn: false };
  const session = { playerId: "secret-id" };
  const lobby = Object.create(Lobby.prototype);
  lobby.roomOf = () => room;
  let broadcasts = 0;
  lobby.broadcastState = () => { broadcasts++; };
  lobby.winEpisodes = null;
  assert.equal(lobby.trainingOptIn(session, { on: true }).error, "BAD_MSG");
  assert.equal(seat.trainingOptIn, false);
  lobby.winEpisodes = {};
  assert.deepEqual(lobby.trainingOptIn(session, { on: true }), { ok: true });
  assert.equal(seat.trainingOptIn, true);
  assert.equal(broadcasts, 1);
  lobby.trainingOptIn(session, { on: true });
  assert.equal(broadcasts, 1);
  room.match = {};
  assert.equal(lobby.trainingOptIn(session, { on: false }).error, "ROOM_STARTED");
});


test("consent wire is boolean-only and room state defaults opt-out", () => {
  assert.equal(validateC2S({ t: "room.trainingOptIn", on: true }), null);
  assert.equal(validateC2S({ t: "room.trainingOptIn", on: false }), null);
  assert.equal(validateC2S({ t: "room.trainingOptIn", on: "true" }), "bad field on");
  const room = new Room("ABCD", "solo", "NORMAL", 0);
  room.seats[0] = { seat: 0, playerId: "human", name: "test", isBot: false,
    ready: true, connected: true, left: false };
  let view = room.toState();
  assert.equal(view.trainingAvailable, false);
  assert.equal(view.seats[0].trainingOptIn, false);
  room.trainingAvailable = true;
  room.seats[0].trainingOptIn = true;
  view = room.toState();
  assert.equal(view.trainingAvailable, true);
  assert.equal(view.seats[0].trainingOptIn, true);
});
