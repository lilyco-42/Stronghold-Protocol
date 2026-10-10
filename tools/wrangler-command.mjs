// Locate the Wrangler JS entry on Windows instead of spawning a .cmd shim.
// Node's execFile() refuses .cmd/.bat files (EINVAL on current Windows Node).
import { access } from 'node:fs/promises';
import { join, delimiter, dirname } from 'node:path';

export async function wranglerCommand({
  platform = process.platform,
  pathEnv = process.env.PATH || process.env.Path || '',
  nodeExe = process.execPath,
} = {}) {
  if (platform !== 'win32') return { command: 'wrangler', prefix: [] };
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry) continue;
    for (const dir of [entry, dirname(entry)]) {
      const js = join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
      try {
        await access(js);
        return { command: nodeExe, prefix: [js] };
      } catch { /* try another path location */ }
    }
  }
  throw new Error('Wrangler JS entry was not found on PATH. Install it with npm install -g wrangler.');
}
