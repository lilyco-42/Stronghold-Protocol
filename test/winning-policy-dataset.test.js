import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const tool = fileURLToPath(new URL('../tools/build-winning-policy.mjs', import.meta.url));

test('winning-policy dataset keeps matches isolated, de-duplicates sent files, excludes losses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sp-policy-'));
  const input = join(root, 'spool');
  const output = join(root, 'dataset');
  try {
    await mkdir(join(input, 'sent'), { recursive: true });
    for (let i = 0; i < 30; i++) {
      const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
      const ep = {
        schema: 'sp.winning-decisions.v1', episodeId: id,
        mode: 'solo', difficulty: 'NORMAL', outcome: { victory: true },
        samples: [{
          seat: 0,
          state: { round: 6, phase: 'PREP', funds: 10, bandId: 'band_x', shop: { level: 2 } },
          action: { type: 'g.buy', slot: 1 },
        }],
      };
      const bytes = gzipSync(JSON.stringify(ep));
      await writeFile(join(input, id + '.json.gz'), bytes);
      if (i === 0) await writeFile(join(input, 'sent', id + '.json.gz'), bytes);
    }
    const badId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await writeFile(join(input, badId + '.json.gz'),
      gzipSync(JSON.stringify({ schema: 'sp.winning-decisions.v1', episodeId: badId,
        outcome: { victory: false }, samples: [{ action: { type: 'g.buy' } }] })));
    const { stdout } = await run(process.execPath, [tool, input, output], { timeout: 10000 });
    const report = JSON.parse(stdout.trim());
    assert.equal(report.invalidEpisodes, 1);
    assert.equal(report.trainEpisodes + report.holdoutEpisodes, 30);
    assert(report.trainEpisodes > 0 && report.holdoutEpisodes > 0);
    assert.equal(report.trainDecisions + report.holdoutDecisions, 30);
    assert.equal(report.coverage, 1);
    assert.equal(report.accuracyOnCovered, 1);
    const train = (await readFile(join(output, 'train.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const holdout = (await readFile(join(output, 'holdout.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(train.length + holdout.length, 30);
    const trainIds = new Set(train.map(row => row.episodeId));
    assert(holdout.every(row => !trainIds.has(row.episodeId)));
    assert(holdout.every(row => row.action.type === 'g.buy'));
    assert(holdout.every(row => row.context.includes('NORMAL')));
    const baseline = JSON.parse(await readFile(join(output, 'policy-baseline.json'), 'utf8'));
    assert(Object.values(baseline.model).every(value => value.topActionType === 'g.buy'));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('empty input produces explicit no-data metrics rather than invented accuracy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sp-policy-empty-'));
  try {
    const input = join(root, 'empty');
    const output = join(root, 'out');
    const { stdout } = await run(process.execPath, [tool, input, output], { timeout: 10000 });
    const report = JSON.parse(stdout.trim());
    assert.equal(report.trainDecisions, 0);
    assert.equal(report.holdoutDecisions, 0);
    assert.equal(report.accuracyOnCovered, null);
    assert.equal(report.coverage, null);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
