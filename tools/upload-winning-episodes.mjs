#!/usr/bin/env node
// Manual/offline uploader. Never called from the match loop.
// Requires an authenticated Wrangler CLI and a private R2 bucket.
import { readdir, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wranglerCommand } from './wrangler-command.mjs';

const exec = promisify(execFile);
const dir = resolve(process.env.SP_WIN_EPISODES_DIR ||
  fileURLToPath(new URL('../var/winning-episodes/', import.meta.url)));
const upload = process.argv.includes('--upload');
const bucket = process.env.SP_R2_BUCKET || '';
const batch = Number(process.env.SP_R2_BATCH || 50);
const max = Number.isInteger(batch) && batch >= 1 && batch <= 1000 ? batch : 50;
const files = (await readdir(dir).catch(err => err.code === 'ENOENT' ? [] : Promise.reject(err)))
  .filter(name => /^[\da-f-]{36}\.json\.gz$/.test(name)).sort().slice(0, max);
if (upload && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) {
  console.error('Set SP_R2_BUCKET to a private R2 bucket name.');
  process.exitCode = 2;
} else {
  const sent = join(dir, 'sent');
  if (upload) await mkdir(sent, { recursive: true, mode: 0o700 });
  for (const name of files) {
    const key = 'training/wins/v1/' + name;
    const args = ['r2', 'object', 'put', bucket + '/' + key,
      '--file', join(dir, name), '--remote', '--content-type', 'application/json',
      '--content-encoding', 'gzip'];
    if (!upload) {
      console.log('DRY RUN: ' + name + ' -> ' + (bucket || '<bucket>') + '/' + key);
      continue;
    }
    try {
      const { command, prefix } = await wranglerCommand();
      const { stdout } = await exec(command, [...prefix, ...args], { timeout: 120000, maxBuffer: 1024 * 1024 });
      if (stdout) console.log(stdout.trim());
      await rename(join(dir, name), join(sent, basename(name)));
      console.log('uploaded: ' + name);
    } catch (err) {
      console.error('upload failed (spool retained): ' + name + ': ' + err.message);
      process.exitCode = 1;
      break;
    }
  }
  console.log('selected ' + files.length + ' winning episodes' + (upload ? '' : ' (no upload; pass --upload)'));
}
