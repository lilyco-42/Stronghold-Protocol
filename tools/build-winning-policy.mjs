#!/usr/bin/env node
// Offline baseline, NOT an agent wired into game play. Episodes, not decisions,
// are split into train/holdout to avoid evaluating on decisions of the same game.
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const defaultSpool = fileURLToPath(new URL('../var/winning-episodes/', import.meta.url));
const defaultOut = fileURLToPath(new URL('../var/winning-policy/', import.meta.url));
const inDir = resolve(process.argv[2] || process.env.SP_WIN_EPISODES_DIR || defaultSpool);
const outDir = resolve(process.argv[3] || defaultOut);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$/i;
const ACTIONS = new Set(['g.band', 'g.bandSkip', 'g.buy', 'g.refresh', 'g.freeze', 'g.levelUp',
  'g.sell', 'g.move', 'g.equip', 'g.art', 'g.destroy', 'g.reward', 'g.choice']);
const counts = new Map();
const stats = { trainEpisodes: 0, holdoutEpisodes: 0, trainDecisions: 0,
  holdoutDecisions: 0, invalidEpisodes: 0, correctHoldout: 0, fallbackOnly: 0 };
function feature(sample, ep) {
  const state = sample.state || {};
  const funds = Number(state.funds);
  const round = Number(state.round);
  const level = Number(state.shop?.level);
  return [
    ep.mode, ep.difficulty, state.phase ?? '?',
    Number.isFinite(round) ? Math.floor(round / 3) : '?',
    Number.isFinite(level) ? level : '?',
    Number.isFinite(funds) ? Math.max(0, Math.min(20, Math.floor(funds / 5))) : '?',
    typeof state.bandId === 'string' ? state.bandId.slice(0, 80) : '',
  ].join('|');
}
function label(action) {
  // Predict an intent type only: never replay arbitrary args (e.g. sell UID)
  // against a live match without legal-action validation.
  return action?.type && ACTIONS.has(action.type) ? action.type : null;
}
async function write(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}
function split(id) {
  return createHash('sha256').update(id).digest()[0] % 5 === 0 ? 'holdout' : 'train';
}
async function listEpisodes() {
  const paths = [];
  for (const dir of [inDir, join(inDir, 'sent')]) {
    const names = await readdir(dir).catch(err => err.code === 'ENOENT' ? [] : Promise.reject(err));
    for (const name of names) if (ID.test(name)) paths.push(join(dir, name));
  }
  return paths.sort();
}
await mkdir(outDir, { recursive: true, mode: 0o700 });
const train = createWriteStream(join(outDir, 'train.jsonl'), { flags: 'w', mode: 0o600 });
const holdout = createWriteStream(join(outDir, 'holdout.jsonl'), { flags: 'w', mode: 0o600 });
const seen = new Set();
try {
  for (const file of await listEpisodes()) {
    let ep;
    try {
      const content = await readFile(file);
      if (content.length > 5_000_000) throw Error('compressed input too large');
      ep = JSON.parse(gunzipSync(content, { maxOutputLength: 50_000_000 }));
      if (!ep || ep.schema !== 'sp.winning-decisions.v1' || ep.outcome?.victory !== true ||
          !Array.isArray(ep.samples) || ep.samples.length > 1500 ||
          typeof ep.episodeId !== 'string' || !file.endsWith(ep.episodeId + '.json.gz')) {
        throw Error('episode schema invalid');
      }
      if (seen.has(ep.episodeId)) continue; // retry-upload copy, never duplicate
      seen.add(ep.episodeId);
    } catch (err) {
      stats.invalidEpisodes++;
      console.warn('Skip invalid episode ' + file + ': ' + err.message);
      continue;
    }
    const group = split(ep.episodeId);
    stats[group === 'train' ? 'trainEpisodes' : 'holdoutEpisodes']++;
    for (const sample of ep.samples) {
      const type = label(sample.action);
      if (!type) continue;
      const key = feature(sample, ep);
      const row = { episodeId: ep.episodeId, context: key,
        state: sample.state, action: sample.action };
      await write(group === 'train' ? train : holdout, JSON.stringify(row) + '\n');
      stats[group === 'train' ? 'trainDecisions' : 'holdoutDecisions']++;
      if (group === 'train') {
        if (!counts.has(key)) counts.set(key, new Map());
        const bucket = counts.get(key);
        bucket.set(type, (bucket.get(type) || 0) + 1);
      }
    }
  }
} finally {
  train.end(); holdout.end();
  await Promise.all([once(train, 'finish'), once(holdout, 'finish')]);
}
const model = {};
for (const [context, distribution] of counts) {
  const sorted = [...distribution].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  model[context] = { topActionType: sorted[0][0], n: sorted.reduce((acc, [, n]) => acc + n, 0),
    counts: Object.fromEntries(sorted) };
}
const rd = createInterface({ input: createReadStream(join(outDir, 'holdout.jsonl')), crlfDelay: Infinity });
for await (const line of rd) {
  if (!line) continue;
  const row = JSON.parse(line);
  const prediction = model[row.context]?.topActionType;
  if (!prediction) { stats.fallbackOnly++; continue; }
  if (prediction === label(row.action)) stats.correctHoldout++;
}
const report = {
  schema: 'sp.winning-policy-baseline.v1',
  warning: 'Offline action-type frequency baseline, not an optimal policy or a playable bot.',
  ...stats,
  coverage: stats.holdoutDecisions ? (stats.holdoutDecisions - stats.fallbackOnly) / stats.holdoutDecisions : null,
  accuracyOnCovered: stats.holdoutDecisions > stats.fallbackOnly
    ? stats.correctHoldout / (stats.holdoutDecisions - stats.fallbackOnly) : null,
};
await writeFile(join(outDir, 'policy-baseline.json'), JSON.stringify({ schema: report.schema, model }, null, 2) + '\n', { mode: 0o600 });
await writeFile(join(outDir, 'metrics.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
