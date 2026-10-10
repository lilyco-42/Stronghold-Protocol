import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wranglerCommand } from '../tools/wrangler-command.mjs';

test('Unix Wrangler invokes executable without shell', async () => {
  assert.deepEqual(await wranglerCommand({ platform: 'linux' }),
    { command: 'wrangler', prefix: [] });
});

test('Windows Wrangler bypasses .cmd (Node execFile EINVAL) using global JS entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sp-wrangler-path-'));
  try {
    const bin = join(root, 'node_modules', 'wrangler', 'bin');
    await mkdir(bin, { recursive: true });
    const js = join(bin, 'wrangler.js');
    await writeFile(js, 'console.log("ok")');
    assert.deepEqual(await wranglerCommand({ platform: 'win32', pathEnv: root, nodeExe: 'node-test.exe' }),
      { command: 'node-test.exe', prefix: [js] });
    await assert.rejects(wranglerCommand({ platform: 'win32', pathEnv: join(root, 'missing', 'nested') }),
      /Wrangler JS entry was not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
