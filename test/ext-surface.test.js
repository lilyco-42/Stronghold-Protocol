// test/ext-surface.test.js — 我们压在上游文件上的每一行，必须还在。
//
// 本分支相对上游是「一百多个新文件 + 二十几个被改的上游文件」。新文件不会被合并冲掉；风险全在后者：
// 上游改了同一处时，`git merge` 可能安静地吃掉我们的挂载点（皮肤、跨版本能力、/media、字体镜像都住在这里）。
// docs/EXT-SURFACE.json 由 tools/ext-surface.mjs 生成，这里逐行反查 —— 把"静默丢失"变成指名道姓的红。
// 重新生成：node tools/ext-surface.mjs（改完那些文件后跑一次，和 test/packaging.test.js 的计数同性质）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSurface, checkSurface } from '../tools/ext-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'EXT-SURFACE.json');
const doc = existsSync(DOC) ? JSON.parse(readFileSync(DOC, 'utf8')) : null;

test('docs/EXT-SURFACE.json exists and is not empty', () => {
  assert.ok(doc, 'run: node tools/ext-surface.mjs');
  assert.ok(Object.keys(doc.files).length >= 10, `只记录了 ${Object.keys(doc.files || {}).length} 个文件，清单本身没生成对`);
});

test('every line we added to an upstream file is still there', () => {
  const problems = checkSurface(doc);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n\n→ 上游合并冲掉了我们的改动。把缺的行加回去，或确认该功能已进上游后重跑 node tools/ext-surface.mjs`);
});

test('the surface matches what the tree actually contains: no unrecorded mount points', () => {
  // 这条防的是"悄悄扩大耦合面"：往上游文件里加行而不更新清单，就等于绕过解耦的约定。
  const now = buildSurface();
  const before = Object.keys(doc.files).sort();
  const after = Object.keys(now.files).sort();
  assert.deepEqual(after, before, `被改的上游文件变了：只在新出现的文件里加行 —— 要么搬进我们自己的新文件，`
    + `要么跑 node tools/ext-surface.mjs 承认它并说明理由`);
  for (const f of before) {
    assert.ok(now.files[f].length >= doc.files[f].length,
      `${f}: 清单记 ${doc.files[f].length} 行，实际只剩 ${now.files[f].length} —— 重跑 node tools/ext-surface.mjs 之前先确认不是被合并吃掉了`);
  }
});
