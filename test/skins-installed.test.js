// data/assets.json 是**一整行** JSON（1 MB+），所以它是最容易被上游合并吃掉的地方：冲突时随手取一侧，
// 皮肤条目就整块没了，而 `docs/EXT-SURFACE.json` 对这种文件只能记一个「opaque 整行」条目（前缀还在就算过），
// 挡不住「行还在、我们的键被换掉了」。这条测试直接按结构查，是那道缺口的正面补法。
// 另一次教训见 AGENTS.md：合并 assets.json 要按叶子路径 diff 解，解完必须重跑 fetch-assets / 注入器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const installed = readJson('data/skins-installed.json');
const assets = readJson('data/assets.json');
const catalogue = readJson('data/skins.json');

const withSkins = Object.entries(assets.chars).filter(([, r]) => Object.keys(r.skins || {}).length);

test('清单里点名的每一款皮肤，都在 data/assets.json 里有对应条目', () => {
  assert.ok(Array.isArray(installed), 'data/skins-installed.json 必须是数组');
  const have = new Set(withSkins.flatMap(([, r]) => Object.keys(r.skins)));
  const missing = installed.filter((id) => !have.has(id));
  assert.deepEqual(missing, [], `assets.json 丢了 ${missing.length} 款皮肤条目（合并时取错一侧？）: ${missing.join(', ')}`);
  assert.equal(assets.stats.skins, installed.length, `stats.skins=${assets.stats.skins} 与清单的 ${installed.length} 不符`);
  assert.equal(assets.stats.charsWithSkins, withSkins.length, 'stats.charsWithSkins 与实际带皮肤的干员数不符');
});

test('每条皮肤条目引用的文件都在盘上（素材没下全就别装）', (t) => {
  // public/assets/ 被 .gitignore，所以干净 checkout 上必然全缺 —— 这条查的是「本机打包前」的状态。
  if (!existsSync(path.join(ROOT, 'public/assets/spine/op'))) t.skip('没有 public/assets，跳过（素材是本地拉的）');
  const dead = [];
  for (const [cid, rec] of Object.entries(assets.chars)) {
    for (const [skinId, sk] of Object.entries(rec.skins || {})) {
      const urls = [sk.avatar, ...Object.values(sk.spine || {}).flatMap((s) => [s.skel, s.atlas, ...(s.textures || [])])]
        .filter(Boolean);
      assert.ok(urls.length >= 2, `${skinId}: 一条引用都没有，注入器写坏了`);
      for (const u of urls) if (!existsSync(path.join(ROOT, 'public', u))) dead.push(`${skinId} → ${u}`);
      assert.ok(!Object.values(sk).some((v) => typeof v === 'string' && /^https?:/.test(v)), `${skinId}: 条目里混进了绝对外链 URL`);
      for (const s of Object.values(sk.spine || {})) {
        for (const x of [s.skel, s.atlas, ...(s.textures || [])]) {
          if (x && /^https?:/.test(x)) dead.push(`${skinId}: spine 用了外链 ${x}`);
        }
      }
    }
  }
  assert.deepEqual(dead, [], `assets.json 引用了盘上不存在的文件（打包出去就是 404）:\n  ${dead.join('\n  ')}`);
});

test('已装皮肤必须是目录里真实存在的款（不能凭空造 id）', () => {
  const known = new Set(Object.values(catalogue.chars).flat().map((s) => s.id));
  const bogus = installed.filter((id) => !known.has(id));
  assert.deepEqual(bogus, [], `清单里有 data/skins.json 不认识的 id: ${bogus.join(', ')}`);
});
