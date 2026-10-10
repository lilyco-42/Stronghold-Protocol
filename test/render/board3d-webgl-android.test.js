import test from 'node:test';
import assert from 'node:assert/strict';
import { webgl2Available } from '../../public/js/render/board3d/load.js';

function withMockWebGL(ua, factory, fn) {
  const doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement(name) {
        assert.equal(name, 'canvas');
        return { getContext: factory };
      },
    } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ua } });
    return fn();
  } finally {
    if (doc) Object.defineProperty(globalThis, 'document', doc);
    else delete globalThis.document;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  }
}

test('Android WebView: WebGL2 can be used when strict performance caveat check rejects it (#8)', () => {
  const options = [];
  let lost = 0;
  const gl = { getExtension: name => {
    assert.equal(name, 'WEBGL_lose_context');
    return { loseContext() { lost++; } };
  } };
  withMockWebGL('Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36', (_, opts) => {
    options.push(opts);
    return opts?.failIfMajorPerformanceCaveat ? null : gl;
  }, () => assert.equal(webgl2Available(), true));
  assert.deepEqual(options, [{ failIfMajorPerformanceCaveat: true }, {}]);
  assert.equal(lost, 1, 'release the probe context before creating the Pixi and THREE contexts');
});

test('Desktop automatic mode still refuses caveat-blocked WebGL2', () => {
  let attempts = 0;
  withMockWebGL('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', (_, opts) => {
    attempts++;
    return opts?.failIfMajorPerformanceCaveat ? null : { getExtension: () => null };
  }, () => assert.equal(webgl2Available(), false));
  assert.equal(attempts, 1);
});

test('Explicit ?board=3d may use WebGL2 with a performance caveat on desktop', () => {
  withMockWebGL('Mozilla/5.0 (Windows NT 10.0)', (_, opts) => (
    opts?.failIfMajorPerformanceCaveat ? null : { getExtension: () => null }
  ), () => assert.equal(webgl2Available(true), true));
});

test('Unavailable or failing WebGL2 still falls back to 2D on Android', () => {
  withMockWebGL('Android 14; wv', () => null, () => assert.equal(webgl2Available(), false));
  withMockWebGL('Android 14; wv', () => { throw Error('GPU failed'); },
    () => assert.equal(webgl2Available(), false));
});



test("Android retries plain WebGL2 when strict getContext throws", () => {
  let tries = 0;
  withMockWebGL("Mozilla/5.0 (Linux; Android 13; wv)", (_, opts) => {
    tries++;
    if (opts?.failIfMajorPerformanceCaveat) throw Error("Rejected by Android WebView");
    return { getExtension: () => null };
  }, () => assert.equal(webgl2Available(), true));
  assert.equal(tries, 2);
});
