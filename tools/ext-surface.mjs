// tools/ext-surface.mjs — 记录"我们压在上游文件上的每一行"，供 test/ext-surface.test.js 反查。
//
// 为什么要有它：本分支相对上游是「131 个新文件 + 30 个被改的上游文件」。新文件不会被合并冲掉，
// 风险全在那 30 个 —— 上游一改同一处，`git merge` 可能静默吃掉我们的挂载点（2026-10-06 合 0.1.4
// 零冲突是运气，不是保证）。这个清单把"我们的行还在不在"变成一条会指名道姓报错的闸门。
//
// 用法：
//   node tools/ext-surface.mjs            # 重新生成 docs/EXT-SURFACE.json（改了上游文件后跑一次）
//   node tools/ext-surface.mjs --check    # 不写文件，只报告与清单的差异（CI/自查）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'EXT-SURFACE.json');
const UPSTREAM = 'upstream/master';
// 只关心会被上游覆盖的那一侧：我们自己新增的文件不需要记录（合并不会删它们）。
//  - docs/ 与 test/ 是我们的地盘；
//  - data/assets.json 是 tools/fetch-assets.mjs 生成的**一整行** JSON：按「行」记账时记下来的其实是
//    `{"version":1,"hash":"…","stats":{"files":…,"bytes":…` 这一串每次都变的机器值，于是每次正常刷新素材
//    （或每次按叶子路径合并上游那份）都会报"我们的行不见了"。它自己就在注释里承认这是假红 —— 一条**每次必红**
//    的闸门比没有闸门更糟：它会把真信号（皮肤条目被合并吃掉）训练成噪音去忽略。
//    真正的覆盖在 test/skins-installed.test.js：它按结构查"清单里点名的每款皮肤都在 assets.json 里有条目"、
//    stats.skins 与清单一致、引用的文件在盘上、条目里没混进外链 —— 比行前缀强得多，而且不受 hash/bytes 变动影响。
const SKIP = [/^docs\//, /^test\//, /^NOTICE\.md$/, /^data\/assets\.json$/];

const git = (args, quiet = false) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
});

/** Files upstream also has, i.e. ones we edited rather than created. The base is upstream/master's tip, not the
 merge-base: we merge upstream continuously, so anything the merge-base predates is upstream's own work, not ours. */
function editedFiles() {
  return git(['diff', '--name-only', `${UPSTREAM}..HEAD`])
    .split('\n').filter(Boolean)
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .filter((f) => { try { return fs.statSync(path.join(ROOT, f)).isFile(); } catch { return false; } })
    // upstream 也有这个文件才需要记录：我们自己新建的文件合并永远不会冲掉它们，列进来只会淹没信号。
    .filter((f) => { try { git(['cat-file', '-e', `${UPSTREAM}:${f}`], true); return true; } catch { return false; } });
}

/** The `+` lines we added to one upstream file, per hunk, with the hunk's enclosing anchor. */
function ourLines(file) {
  const diff = git(['diff', '-U0', `${UPSTREAM}..HEAD`, '--', file]);
  const out = [];
  let hunk = null;
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { hunk = { at: Number(m[1]), context: m[2].trim() }; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    // 单行大文件（整份 JSON 就是一行）：按「行」记账没有意义，截断存下并标 opaque，让读报告的人知道这是
    // 一个文件级的挂载点，而不是一条可逐行复核的补丁。
    // ⚠ 但**不要**用它记生成物：opaque 条目存的是行首 120 字符，而生成物的行首就是 hash/bytes 这些每次都变的机器值，
    //   记进去等于装一条每次必红的闸门（data/assets.json 因此已经进了 SKIP，理由见上面那段）。
    //   要查生成物的结构有没有被合并吃掉，写按结构断言的测试（skins-installed.test.js 那种），不是这里。
    const opaque = trimmed.length > 4000;
    out.push({
      line: opaque ? `${trimmed.slice(0, 120)}…（整行 ${trimmed.length} 字符）` : trimmed,
      anchor: hunk?.context || '',
      ...(opaque ? { opaque: true } : {}),
    });
  }
  return out;
}

export function buildSurface() {
  const files = {};
  for (const f of editedFiles()) {
    const ours = ourLines(f);
    if (ours.length) files[f] = ours;
  }
  return { generated: new Date().toISOString().slice(0, 10), upstream: UPSTREAM, files };
}

export function checkSurface(doc) {
  const problems = [];
  for (const [f, ours] of Object.entries(doc.files)) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { problems.push(`${f}: 文件不见了`); continue; }
    // opaque 条目存的是截断前缀（整份单行 JSON 不可能逐行复核），所以拿前缀查在不在。
    const missing = ours.filter((o) => !text.includes(o.opaque ? o.line.split('…（整行')[0] : o.line));
    if (missing.length) {
      problems.push(`${f}: 我们加的 ${missing.length}/${ours.length} 行已不在文件里（上游合并冲掉了？）`);
      for (const m of missing.slice(0, 6)) problems.push(`    缺: ${m.line}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const doc = buildSurface();
  if (process.argv.includes('--check')) {
    const problems = checkSurface(JSON.parse(fs.readFileSync(OUT, 'utf8')));
    console.log(problems.length ? problems.join('\n') : `EXT-SURFACE 一致（${Object.keys(doc.files).length} 个上游文件）`);
    process.exit(problems.length ? 1 : 0);
  }
  const n = Object.values(doc.files).reduce((a, v) => a + v.length, 0);
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(`wrote docs/EXT-SURFACE.json: ${Object.keys(doc.files).length} 个上游文件、${n} 行属于我们`);
}
