// The web build (the same `public/` the node service serves to browsers) has to deliver the mirrored fonts without
// ever asking a remote host. `webfonts-local.test.js` proves the files are on disk and referenced locally; this file
// proves the *server* actually hands them out in a usable shape — the browser-side half of "零外部请求".
// Why a test rather than the one-off curl session it came from: the fork has no CI, and dropping 'webfonts' from
// LONG_CACHE_DIRS or losing the .woff2 mime in server/index.js is silent — the page still renders, just re-fetching
// a 455 KB sheet on every load or falling back to a system CJK face.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-webfonts-serve-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const handler = createStaticHandler({ publicDir: PUBLIC, dataDir: dir, sharedDir: path.join(ROOT, 'shared') });
  const srv = http.createServer((req, res) => {
    const [p, q] = req.url.split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, dir })));
}

function get(srv, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, method }, (res) => {
      let body = Buffer.alloc(0);
      res.on('data', (d) => { body = Buffer.concat([body, d]); });
      res.on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body: body.toString('latin1'), bytes: body.length,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sheet = fs.readFileSync(path.join(PUBLIC, 'webfonts', 'google', 'google.css'), 'utf8');
const slice = /url\(\/webfonts\/google\/([^)]+\.woff2)\)/.exec(sheet)[1];

test('the node service serves the mirrored sheet as a stylesheet, long-cached', async () => {
  const { srv, dir } = await serve();
  try {
    const r = await get(srv, '/webfonts/google/google.css');
    assert.equal(r.status, 200, 'index.html 引用的那张本地样式表必须能取到');
    assert.match(r.type || '', /text\/css/, 'Chromium 只按 text/css 认这张表');
    assert.equal(r.cache, 'public, max-age=86400', '421 个 @font-face 的表每次都重取是回归');
    assert.ok(r.bytes > 200_000, `表太小(${r.bytes} B)，读到的大概不是生成物`);
    assert.match(r.body, /font-display: *swap/, '不阻塞渲染的时序要跟着字节一起出厂');
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(r.body), '发出去的表里不许有远程地址');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a slice is served as a real woff2 with the same long cache', async () => {
  const { srv, dir } = await serve();
  try {
    const r = await get(srv, `/webfonts/google/${slice}`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'font/woff2', 'mime 错了浏览器会直接落回系统字体');
    assert.equal(r.cache, 'public, max-age=86400');
    assert.equal(r.body.slice(0, 4), 'wOF2', 'magic 必须是 woff2');
    const h = await get(srv, `/webfonts/google/${slice}`, 'HEAD');
    assert.equal(h.status, 200, 'HEAD 也要 200：字体预取与某些 WebView 会先 HEAD');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the long cache belongs to the mirrored dirs only (positive control)', async () => {
  // Without this, marking *everything* long-cacheable would keep the two assertions above green — and a stale
  // index.html on a self-hosted install is exactly what the docs warn about.
  const { srv, dir } = await serve();
  try {
    const page = await get(srv, '/index.html');
    assert.equal(page.status, 200);
    assert.notEqual(page.cache, 'public, max-age=86400', '入口页不能被长缓存');
    const app = await get(srv, '/js/net.js');
    assert.equal(app.status, 200);
    assert.notEqual(app.cache, 'public, max-age=86400');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a dotted path into the mirror does not read outside public/', async () => {
  // %2e is not normalized by the HTTP client, so the server has to be the one that refuses it.
  const { srv, dir } = await serve();
  try {
    for (const probe of [
      '/webfonts/google/%2e%2e%2f%2e%2e%2f%2e%2e%2fserver%2findex.js',
      '/webfonts/google/../../../server/index.js',
      '/webfonts/google/%2e%2e/%2e%2e/%2e%2e/package.json',
    ]) {
      const r = await get(srv, probe);
      if (r.status === 200) {
        assert.ok(!/createStaticHandler|\"main\":\s*\"server/.test(r.body),
          `逃逸拿到根外内容（${probe} → 200）：多挂一个长缓存目录就开了口子`);
      } else {
        assert.ok([400, 403, 404].includes(r.status), `${probe} 应当被拒（拿到 ${r.status}）`);
      }
    }
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
