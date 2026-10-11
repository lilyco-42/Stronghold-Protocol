// Field-host ownership under cancellation and timeout. Browser tests cover the actual renderer; this fixture runs
// the production orchestration with controlled imports and timers, without a DOM or GPU dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import vm from 'node:vm';

const sourcePath = new URL('../../public/js/ui/fieldHost.js', import.meta.url);
const source = readFileSync(sourcePath, 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '')
  .replace("import('../assets.js')", 'importAssets()')
  .replace("import('../render/app.js')", 'importApp()');
const METHODS = ['setStage', 'setCamera', 'setPrep', 'enterBattle', 'pushSnapshot', 'pushEvents', 'highlightTiles', 'on', 'resize'];
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function fixture() {
  const timers = new Map(), requests = [], fallbacks = [], warnings = [];
  let timerId = 0;
  const unrelated = { name: 'unrelated' };
  const host = {
    children: [unrelated],
    get firstChild() { return this.children[0] || null; },
    appendChild(node) { this.children.push(node); },
    removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); },
  };
  function view(name, valid = true) {
    const node = { name };
    host.appendChild(node);
    return {
      ...(valid ? Object.fromEntries(METHODS.map((k) => [k, () => {}])) : {}),
      node, destroyCalls: 0,
      destroy() { this.destroyCalls++; host.removeChild(node); },
    };
  }
  const context = vm.createContext({
    AbortController, DOMException, URLSearchParams, Promise,
    console: { warn: (...args) => warnings.push(args) },
    audio: {}, data: { get() { return null; } }, settingsStore: { get() { return {}; } },
    // A fired timer is no longer pending (real setTimeout semantics); `clearTimeout` removes a cancelled one.
    setTimeout(fn) { const id = ++timerId; timers.set(id, () => { timers.delete(id); fn(); }); return id; },
    clearTimeout(id) { timers.delete(id); },
    importAssets: async () => null,
    importApp: async () => ({
      createFieldView(_host, opts) {
        // Deliberately ignore cancellation: the host must still dispose a factory's late return value.
        return new Promise((resolve, reject) => requests.push({ resolve, reject, signal: opts.signal }));
      },
    }),
    createFallbackView() {
      const fallback = view('fallback');
      fallbacks.push({ view: fallback, rendererAborted: requests.at(-1)?.signal?.aborted });
      return fallback;
    },
  });
  vm.runInContext(source + '\nglobalThis.mount = mountFieldView;', context, { filename: sourcePath.pathname });
  return {
    host, unrelated, timers, requests, fallbacks, warnings, view, context,
    mount: (signal) => context.mount(host, { signal }),
    /** Fire the newest pending timer (the initialization deadline, or the pause between engine attempts). */
    fireLast() { const fn = [...timers.values()].at(-1); assert.ok(fn, 'a timer is pending'); fn(); },
    timeout() { this.fireLast(); },
    /** The dev hook `mountFieldView` leaves behind when it settles on the simplified view (F12 diagnosis). */
    diagnostics() { return vm.runInContext('globalThis.__SP_FIELD_FALLBACK__', context); },
  };
}

function settled(promise) {
  const result = { state: 'pending', value: null };
  promise.then((value) => { result.state = 'fulfilled'; result.value = value; }, (error) => { result.state = 'rejected'; result.value = error; });
  return result;
}

test('successful initialization releases deadlines and cancellation listeners', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.mount(controller.signal);
  await flush();
  const raw = f.view('engine');
  f.requests[0].resolve(raw);
  const mounted = await pending;
  assert.equal(mounted.kind, 'engine');
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(f.requests[0].signal, 'abort').length, 0);
  mounted.destroy();
  assert.equal(raw.destroyCalls, 1);
});

test('cancelling a pending mount rejects without fallback and disposes a late result', async () => {
  const f = fixture(), controller = new AbortController();
  const result = settled(f.mount(controller.signal));
  await flush();
  controller.abort();
  await flush();
  assert.equal(result.state, 'rejected');
  assert.equal(result.value.name, 'AbortError');
  assert.equal(f.fallbacks.length, 0);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const late = f.view('late');
  f.requests[0].resolve(late);
  await flush();
  assert.equal(late.destroyCalls, 1);
  assert.deepEqual(f.host.children, [f.unrelated]);
});

test('cancellation between factory resolution and mount continuation disposes the resolved view', async () => {
  const f = fixture(), controller = new AbortController();
  const result = settled(f.mount(controller.signal));
  await flush();
  const raw = f.view('settling');
  f.requests[0].resolve(raw);
  await Promise.resolve();
  controller.abort();
  await flush();
  assert.equal(result.state, 'rejected');
  assert.equal(result.value.name, 'AbortError');
  assert.equal(raw.destroyCalls, 1);
  assert.equal(f.fallbacks.length, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.children, [f.unrelated]);
});

test('an invalid renderer API is disposed and aborted before fallback mounts', async () => {
  const f = fixture();
  const pending = f.mount();
  await flush();
  const invalid = f.view('invalid', false);
  f.requests[0].resolve(invalid);
  const fallback = await pending;
  assert.equal(fallback.kind, 'fallback');
  assert.equal(invalid.destroyCalls, 1);
  assert.equal(f.fallbacks[0].rendererAborted, true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.children, [f.unrelated, f.fallbacks[0].view.node]);
  fallback.destroy();
});

test('a timed-out engine mount is retried once and the retry mounts the engine', async () => {
  const f = fixture();
  const pending = f.mount();
  await flush();
  assert.equal(f.requests.length, 1, 'the first attempt reaches the factory');
  f.timeout(); // attempt 1 misses the createFieldView deadline (public issue #8: a slow phone)
  await flush();
  assert.equal(f.requests[0].signal.aborted, true, 'the abandoned attempt is cancelled');
  assert.equal(f.fallbacks.length, 0, 'a timeout is not yet a reason for the simplified view');
  f.fireLast(); // the pause between attempts
  await flush();
  assert.equal(f.requests.length, 2, 'the engine is attempted a second time');
  const raw = f.view('engine');
  f.requests[1].resolve(raw);
  const mounted = await pending;
  assert.equal(mounted.kind, 'engine');
  assert.equal(raw.destroyCalls, 0);
  assert.equal(f.fallbacks.length, 0);
  assert.equal(f.warnings.length, 0, 'a recovered mount warns about nothing');
  assert.equal(f.diagnostics(), undefined, 'no fallback diagnostic on a recovered mount');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.children, [f.unrelated, raw.node]);
  mounted.destroy();
});

test('a timed-out factory returning late cannot remove a replacement view or unrelated children', async () => {
  const f = fixture();
  const first = f.mount();
  await flush();
  f.timeout();
  await flush();
  f.fireLast(); // the pause between attempts
  await flush();
  const replacement = f.view('replacement');
  f.requests[1].resolve(replacement);
  const mounted = await first;
  assert.equal(mounted.kind, 'engine');
  // the abandoned first attempt finally returns — it must dispose itself, never touch the mounted view
  const late = f.view('late');
  f.requests[0].resolve(late);
  await flush();
  assert.equal(late.destroyCalls, 1);
  assert.equal(replacement.destroyCalls, 0);
  assert.equal(f.fallbacks.length, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.children, [f.unrelated, replacement.node]);
  mounted.destroy();
});

test('the simplified view mounts only after every attempt times out, and records why', async () => {
  const f = fixture();
  const pending = f.mount();
  await flush();
  f.timeout(); // attempt 1
  await flush();
  f.fireLast(); // the pause between attempts
  await flush();
  f.timeout(); // attempt 2
  const fallback = await pending;
  assert.equal(fallback.kind, 'fallback');
  assert.equal(f.requests.length, 2, 'exactly two attempts, no more');
  assert.equal(f.fallbacks.length, 1);
  assert.equal(f.fallbacks[0].rendererAborted, true);
  assert.equal(f.warnings.length, 1, 'the fallback is logged once');
  // public issue #8 had no screenshot of this: the reason must be readable from the dev panel alone
  const diag = f.diagnostics();
  assert.equal(diag.attempts, 2);
  assert.match(diag.reason, /createFieldView timed out$/);
  assert.ok(Number.isFinite(diag.at));
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.children, [f.unrelated, f.fallbacks[0].view.node]);
  fallback.destroy();
});

test('a failing (non-timeout) engine mount is not retried', async () => {
  const f = fixture();
  const pending = f.mount();
  await flush();
  // an API-shape failure is a capability answer, not a budget one: the fallback mounts at once
  f.requests[0].resolve(f.view('invalid', false));
  const fallback = await pending;
  assert.equal(fallback.kind, 'fallback');
  assert.equal(f.requests.length, 1, 'no second attempt');
  assert.match(f.diagnostics().reason, /^view lacks /);
  assert.equal(f.diagnostics().attempts, 1);
  assert.equal(f.timers.size, 0);
  fallback.destroy();
});
