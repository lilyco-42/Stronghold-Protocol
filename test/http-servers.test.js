// test/http-servers.test.js — GET /servers.json (fork addition; docs/SERVER-LIST.md in the client repository).
//
// The endpoint exists so a client can ask whichever server it already talks to for "what else is out there",
// instead of that list being a constant compiled into the client. The three rules the tests below pin:
//
//   P1 — absent / unreadable / malformed data/servers.json answers 404, never 500 and never an empty object:
//        "no list" has to be distinguishable from "an empty list", and almost every server on the network has none.
//   P2 — the body is third-party data: one broken entry must not hide the others, an unknown format version must
//        be refused outright, and the entry count is capped.
//   P3 — additive: with the file absent nothing else about the server changes (covered by the untouched suite).
//
// ONE server instance for the whole file, with the list rewritten between cases: `serveServers` re-reads the file on
// every request, so a per-test server would buy nothing and cost a full data/ copy each time (a whole-suite `node
// --test` run is already minutes long — this file must not make it worse).
//
// The client half of the contract (re-validating every entry, de-duplicating, honouring `caps`) lives in
// lilyco-42/StrongholdProtocolClient — test/server-list.test.js there. This file only pins the server side.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { parseServers, SERVERS_FORMAT_VERSION, SERVERS_MAX } from '../server/http/servers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{ handle: any, port: number, dataDir: string, listPath: string }} */
let ctx;

before(async () => {
  // A scratch dataDir over a copy of the game data, so the list can be written without touching the repository.
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-servers-'));
  for (const f of await fsp.readdir(path.join(ROOT, 'data'))) {
    if (f.endsWith('.json') && f !== 'servers.json') await fsp.copyFile(path.join(ROOT, 'data', f), path.join(dataDir, f));
  }
  // startServer resolves to `{ port, host, url, server, wss, …, close }` (server/index.js) — not a bare http.Server.
  const handle = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  ctx = { handle, port: handle.port, dataDir, listPath: path.join(dataDir, 'servers.json') };
});

after(async () => {
  if (!ctx) return;
  // close() already stops the lobby and the network timers. Its `server.close()` callback only fires once every
  // connection has ended, and node's global agent keeps sockets alive — so drop them explicitly or the test run
  // hangs for minutes waiting on sockets nobody will close (the thing that made this file look slow).
  try { ctx.handle.server?.closeAllConnections?.(); } catch { /* ignore */ }
  await ctx.handle.close();
  await fsp.rm(ctx.dataDir, { recursive: true, force: true });
});

/** GET (or HEAD) a path on the one test server. `agent: false` so no keep-alive socket outlives the request. */
function request(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, path: p, method, agent: false, headers: { Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const writeList = (obj) => fsp.writeFile(ctx.listPath, JSON.stringify(obj));
const writeRaw = (text) => fsp.writeFile(ctx.listPath, text);
const removeList = () => fsp.rm(ctx.listPath, { force: true });
const getJson = async () => JSON.parse((await request('/servers.json')).body);

test('no data/servers.json → 404, not a 500 and not an empty list', async () => {
  await removeList();
  assert.equal((await request('/servers.json')).status, 404, 'P1: a server with no list must look like any other absent file');
});

test('a usable list is served with the CORS header a packaged client needs', async () => {
  await writeList({ v: 1, name: 'lilyco', servers: [{ name: '网友服 · nekotc', address: 'https://sp.nekotc.cn' }] });
  const r = await request('/servers.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], '*', 'without this the exe/apk can never read the body');
  assert.match(r.headers['content-type'], /application\/json/);
  assert.match(r.headers['cache-control'], /no-store/, 'a stale list keeps showing the server that just died');
  const body = JSON.parse(r.body);
  assert.equal(body.v, 1);
  assert.equal(body.name, 'lilyco');
  assert.deepEqual(body.servers, [{ name: '网友服 · nekotc', address: 'https://sp.nekotc.cn' }]);
});

test('one broken entry does not hide the good ones', async () => {
  await writeList({
    v: 1,
    servers: [
      { name: 'good', address: 'https://ok.example' },
      { name: 'no address' },                        // dropped
      { address: 'https://no-name.example' },        // dropped
      'nonsense',                                    // dropped
      null,                                          // dropped
      { name: '  ', address: 'https://blank.example' }, // dropped (blank name)
      { name: 'later', address: 'https://later.example' },
    ],
  });
  assert.deepEqual((await getJson()).servers.map((s) => s.name), ['good', 'later'], 'P2: keep the survivors');
});

test('an unknown format version is refused outright (404), never guessed at', async () => {
  await writeList({ v: SERVERS_FORMAT_VERSION + 1, servers: [{ name: 'x', address: 'https://x.example' }] });
  assert.equal((await request('/servers.json')).status, 404, 'reading a shape we do not know is how clients read data wrong');
});

test('malformed JSON / a non-object / a missing servers array → 404, never 500', async () => {
  for (const body of ['{ not json', '[]', '"text"', 'null', '{"v":1}', '{"v":1,"servers":"nope"}']) {
    await writeRaw(body);
    assert.equal((await request('/servers.json')).status, 404, `for ${body}`);
  }
});

test('the entry count is capped', async () => {
  const many = Array.from({ length: SERVERS_MAX + 25 }, (_, i) => ({ name: `s${i}`, address: `https://s${i}.example` }));
  await writeList({ v: 1, servers: many });
  // 50 rows max: a server must not be able to push a thousand into a player's picker.
  assert.equal((await getJson()).servers.length, SERVERS_MAX);
});

test('name / note are truncated here, and capabilities are de-duplicated', async () => {
  await writeList({
    v: 1,
    servers: [{ name: 'x'.repeat(80), address: 'https://long.example', note: 'y'.repeat(200), caps: ['skins', 'skins', 'diy', 7, ''] }],
  });
  const s = (await getJson()).servers[0];
  assert.equal(s.name.length, 32, 'the picker caps names at 32; truncate once, here');
  assert.equal(s.note.length, 40);
  assert.deepEqual(s.caps, ['skins', 'diy'], 'unknown or duplicate capabilities are the client\'s business to ignore');
});

test('an edit to data/servers.json is live with no restart', async () => {
  await writeList({ v: 1, servers: [{ name: 'first', address: 'https://first.example' }] });
  assert.equal((await getJson()).servers[0].name, 'first');
  await writeList({ v: 1, servers: [{ name: 'second', address: 'https://second.example' }] });
  assert.equal((await getJson()).servers[0].name, 'second', 'the whole point is not shipping a client');
});

test('parseServers accepts the documented minimum and refuses the rest', () => {
  assert.deepEqual(parseServers('{"v":1,"servers":[]}'), { v: 1, servers: [] }, 'an empty list is valid (unlike no file)');
  assert.equal(parseServers('{"v":2,"servers":[]}'), null);
  assert.equal(parseServers('not json'), null);
});

test('HEAD /servers.json answers the same status without a body', async () => {
  await writeList({ v: 1, servers: [{ name: 'x', address: 'https://x.example' }] });
  const r = await request('/servers.json', 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, '', 'HEAD never carries a body (server/http/common.js)');
});

test('neighbouring routes are untouched', async () => {
  await writeList({ v: 1, servers: [] });
  // The endpoint is exact-match only, and nothing else on the server may change because of it.
  assert.equal((await request('/servers')).status, 404, '/servers is not the route');
  assert.equal((await request('/servers.json/')).status, 404, 'no trailing slash');
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/', 'HEAD')).status, 200);
});
