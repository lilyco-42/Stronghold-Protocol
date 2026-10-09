// public/dev/spine-probe.js — 把「立绘不显示、只剩头像」拆成四层分别测，玩家在自己手机上就能跑。
//
// 为什么要这一页：2026-10-08 的 iPhone 反馈（任务 #63）里，打包层已经排除（发出去的 ipa 内 13,968 个文件逐
// 大小写齐全、清单里 0 个缺失），CI 的 webkit 也排除了（同一批美术 chromium 与 webkit 127/127 一致）。剩下的
// 三个嫌疑人 —— pixi-spine 运行时、Capacitor 的自定义 scheme、手机内存 —— 只有设备本身能分辨。这一页把四件事
// 分开测，于是"头像有、立绘没有"能落到具体一层：
//   ① 静态图片（new Image）        —— 玩家说这一步是好的
//   ② fetch .skel / .atlas         —— 文件取取得到（scheme / 网络 / ATS）
//   ③ assets.spine.acquire()       —— 生产同一条路径（PIXI.Assets + pixi-spine）解析得到吗
//   ④ 连续 acquire 多个            —— 内存/驱逐
// 外加一条**阴性对照**：一个不存在的骨架必须失败。它要是不失败，上面所有"成功"都没有意义。
//
// 结果同时挂到 window.__SPINE_PROBE__，所以 `probe-art-engines.yml` 那条流水线可以在 CI 里跑同一页 —— 同一份
// 数字有两个来源（玩家的真机、CI 的引擎），谁的都不对时能互相照出来。
//
// Query: ?ids=<chessId,…> 指定要测的干员（默认取清单里前几个有 spine 的）；?many=<n> 改内存压力那一步的数量。

import { data } from '../js/data.js';
import { assets } from '../js/assets.js';

const q = new URLSearchParams(location.search);
const MANY = Math.max(1, Math.min(24, Number(q.get('many') || 8)));
const rowsEl = document.getElementById('rows');
const verdictEl = document.getElementById('verdict');
const reportEl = document.getElementById('report');

const rows = [];
function row(name, value, cls) {
  rows.push({ name, value: String(value), cls: cls || '' });
  const tr = document.createElement('tr');
  tr.innerHTML = `<th>${escapeHtml(name)}</th><td class="${cls}">${escapeHtml(String(value))}</td>`;
  rowsEl.appendChild(tr);
  return rows[rows.length - 1];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const ms = (t0) => `${Math.round(performance.now() - t0)}ms`;

/** 一层单独包起来：任何一层炸了都不该把整页带走 —— 那正是我们要读的那一行。 */
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const out = await fn();
    row(name, `${out.text}（${ms(t0)}）`, out.cls);
    return out;
  } catch (e) {
    row(name, `异常：${(e && (e.message || String(e))) || '未知'}（${ms(t0)}）`, 'bad');
    return { cls: 'bad', error: e };
  }
}

function plainImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const t0 = performance.now();
    // 超时是必须的：这一页要在真机上给出结论，而 iOS Safari 上"图片请求永远不返回"本身就是一种可能的故障形状，
    // 让它挂住就等于没有报告。
    const timer = setTimeout(() => { img.onload = img.onerror = null; resolve({ ok: false, timedOut: true, ms: Math.round(performance.now() - t0) }); }, 12000);
    img.onload = () => { clearTimeout(timer); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, ms: Math.round(performance.now() - t0) }); };
    img.onerror = () => { clearTimeout(timer); resolve({ ok: false, ms: Math.round(performance.now() - t0) }); };
    img.src = url;
  });
}

async function head(url) {
  // 同一条理由：fetch 在一个不通的 scheme 上可以永远悬着。
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    const buf = await res.arrayBuffer();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return { bytes: buf.byteLength, type: res.headers.get('content-type') || '(无 Content-Type)', protocol: new URL(url, location.href).protocol };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 有 spine 前视模型的干员，按 id 排序取前 n 个（排序是为了让不同人报的号能对上同一批）。 */
function candidates(n) {
  const wanted = (q.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.length) return wanted;
  const list = data.list('chess') || [];
  const out = [];
  for (const rec of list.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (assets.spineEntry(rec.id, { back: false })) out.push(rec.id);
    if (out.length >= n) break;
  }
  return out;
}

async function main() {
  row('环境 · 地址', `${location.protocol}//${location.host}${location.pathname}`);
  row('环境 · UA', navigator.userAgent);
  row('环境 · 屏幕', `${screen.width}×${screen.height} dpr=${devicePixelRatio || 1} touch=${navigator.maxTouchPoints || 0}`);

  row('① 运行时', globalThis.PIXI
    ? `PIXI 有（v${globalThis.PIXI.VERSION || '?'}）· PIXI.spine ${globalThis.PIXI.spine ? '有' : '缺失'}`
    : 'PIXI 缺失 —— 探针的脚本没加载，这一页的结论都不作数',
  globalThis.PIXI && globalThis.PIXI.spine ? 'ok' : 'bad');

  const glProbe = (() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, text: '拿不到 WebGL 上下文' };
      // `WebGL2RenderingContext` 这个全局在老 Safari 上可能根本不存在，直接 instanceof 会抛 ReferenceError ——
      // 那会被 catch 成"探针异常"，把真正的答案（拿不到上下文）盖掉。
      const kind = typeof WebGL2RenderingContext === 'function' && gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return { ok: true, text: `${kind} · 最大纹理 ${gl.getParameter(gl.MAX_TEXTURE_SIZE)} · ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '渲染器未知'}` };
    } catch (e) {
      return { ok: false, text: `异常：${e.message || e}` };
    }
  })();
  row('② WebGL', glProbe.text, glProbe.ok ? 'ok' : 'bad');

  // ① 与 ② 先跑完再去读清单：它们不依赖清单，而"① 说 PIXI 缺失"往往就是"清单为什么是空的"的答案。
  //
  // 两次载入分开 catch。原来那条 `data.loadAll('chess').then(() => assets.ready()).catch(() => null)`
  // 会把"清单根本没加载起来"伪装成"清单里没有带 spine 的干员" —— 而后者读起来像是数据问题，玩家和开发者
  // 都会去查错的地方（这一页存在的意义就是把层分开，它自己不能把两层混在一个 catch 里）。
  const boot = [];
  try { await data.loadAll('chess'); } catch (e) { boot.push(`chess:${(e && e.message) || e}`); }
  let release = null;
  try { release = await assets.ready(); } catch (e) { boot.push(`assets:${(e && e.message) || e}`); }
  const ids = candidates(3);
  const detail = `ready=${!!release}·棋盘 ${(data.list('chess') || []).length} 条${boot.length ? `·载入报错 ${boot.join(' / ')}` : ''}`;
  if (!ids.length) {
    row('清单', `没找到任何带 spine 的干员（${detail}）—— 这一步失败时下面的结论都不作数`, 'bad');
    return finish();
  }
  row('清单', `${detail}·测试对象 ${ids.join(', ')}`);

  const held = [];
  for (const id of ids) {
    const entry = assets.spineEntry(id, { back: false });
    if (!entry || !entry.skel) { row(`干员 ${id}`, '没有 spine 条目（跳过）', 'skip'); continue; }
    const tex = Array.isArray(entry.textures) ? entry.textures[0] : null;

    // ③ 静态图片：玩家报的是"头像能显示"，所以这一步必须是好的；它要是坏了，后面三层无从谈起。
    await step(`③ 图片 ${id}`, async () => {
      if (!tex) return { text: '该条目没有贴图页（跳过）', cls: 'skip' };
      const r = await plainImage(tex);
      return { text: `${r.ok ? '成功' : r.timedOut ? '12 秒没回（挂住）' : '失败'} ${r.ok ? `${r.w}×${r.h}` : ''} ${r.ms}ms ${tex}`, cls: r.ok ? 'ok' : 'bad' };
    });

    // ④ 取文件：scheme / ATS / 网络在这一层，与解析层分开。
    await step(`④ fetch .skel ${id}`, async () => {
      const r = await head(entry.skel);
      return { text: `${r.bytes} B · ${r.type} · ${r.protocol}`, cls: 'ok' };
    });
    if (entry.atlas) {
      await step(`④ fetch .atlas ${id}`, async () => {
        const r = await head(entry.atlas);
        return { text: `${r.bytes} B · ${r.type}`, cls: 'ok' };
      });
    }

    // ⑤ 生产那条路：assets.spine.acquire → PIXI.Assets.load + pixi-spine。
    await step(`⑤ acquire ${id}`, async () => {
      const d = await assets.spine.acquire(entry);
      const anims = Array.isArray(d && d.animations) ? d.animations.length : -1;
      if (anims < 0) throw new Error(`拿到的 spineData 没有 animations 数组：${entry.skel}`);
      held.push(d);
      return { text: `spineData 有 ${anims} 个动画`, cls: 'ok' };
    });
  }

  // ⑥ 阴性对照：一个不存在的骨架必须失败。它要是成功了，说明 ⑤ 的"成功"根本没在解析东西。
  await step('⑥ 阴性对照（不存在的骨架）', async () => {
    // 从**真实条目**改文件名，而不是自己造一个对象：`validSpine`（assets.js:227）还要求 `anims` 是对象，
    // 自造的条目会被它先拦下来说 `no spine entry` —— 那样这一行报的"如期失败"是校验器的功劳，
    // 而不是加载器真的失败了，等于白测。
    const real = ids.map((id) => assets.spineEntry(id, { back: false })).find((e) => e && e.atlas && e.textures);
    if (!real) return { text: '没有可用的真实条目，阴性对照跳过（上面少一条支撑）', cls: 'skip' };
    const bogus = {
      ...real,
      skel: real.skel.replace(/[^/]+$/, '__nope__.skel'),
      atlas: real.atlas.replace(/[^/]+$/, '__nope__.atlas'),
      textures: real.textures.map((u) => u.replace(/[^/]+$/, '__nope__.png')),
    };
    try {
      await assets.spine.acquire(bogus);
      return { text: `竟然成功了（${bogus.skel}）—— 上面所有"成功"都不可信`, cls: 'bad' };
    } catch (e) {
      return { text: `如期失败：${(e && e.message) || '未知'}`, cls: 'ok' };
    }
  });

  // ⑦ 内存压力：一口气 acquire 多个并都 held 住（不释放），这是手机上最容易炸的形状。
  const manyIds = candidates(MANY);
  await step(`⑦ 连续加载 ${manyIds.length} 个（不释放）`, async () => {
    let okCount = 0;
    let lastErr = '';
    for (const id of manyIds) {
      const e = assets.spineEntry(id, { back: false });
      if (!e) continue;
      try { held.push(await assets.spine.acquire(e)); okCount++; } catch (err) { lastErr = (err && err.message) || String(err); }
    }
    const st = assets.spine.stats ? assets.spine.stats() : null;
    const mem = performance.memory ? ` · JS 堆 ${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}/${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB` : '';
    const text = `成功 ${okCount}/${manyIds.length}${st ? ` · 缓存 ${st.size ?? '?'}（${st.bytes ?? '?'} B）` : ''}${mem}${lastErr ? ` · 最后失败：${lastErr}` : ''}`;
    return { text, cls: okCount === manyIds.length && !lastErr ? 'ok' : 'bad' };
  });

  finish();
}

function finish() {
  const bad = (re) => rows.filter((r) => r.cls === 'bad' && re.test(r.name));
  const anyBad = (re) => bad(re).length > 0;
  let verdict = '';
  let cls = 'ok';
  if (anyBad(/清单|探针异常/)) {
    // 这两行是"其它结论的前置"。它们红的时候后面全是空的，而空的读起来像"没出问题"——
    // CI 第一次跑就是这样：清单没起来，页面却报「四层全通过」。
    verdict = '清单没加载（或探针自己炸了）—— 这一页什么都没证明，别把它当"正常"。';
    cls = 'bad';
  } else if (anyBad(/① 运行时/)) {
    verdict = '探针自己没起来（PIXI 或 pixi-spine 没加载）。这一页的其它结论都不可读。';
    cls = 'bad';
  } else if (anyBad(/③ 图片/)) {
    verdict = '连静态图片都取不到 → 问题在取文件这一层（路径 / scheme / 网络），不在 Spine 解析。';
    cls = 'bad';
  } else if (anyBad(/④ fetch/)) {
    verdict = '图片能显示、但 .skel/.atlas 取不到 → 问题在自定义 scheme 或传输层，不在 pixi-spine。';
    cls = 'bad';
  } else if (anyBad(/⑤ acquire/)) {
    verdict = '文件取得到、Spine 解析失败 → 问题在运行时（pixi-spine / PIXI.Assets / WebGL），不是打包也不是网络。';
    cls = 'bad';
  } else if (anyBad(/⑥ 阴性对照/)) {
    verdict = '阴性对照没失败 = 探针不 load-bearing，上面的"成功"没有意义。';
    cls = 'bad';
  } else if (anyBad(/⑦ 连续加载/)) {
    verdict = '单个能解析、连续多个就失败 → 内存 / 缓存驱逐这一层。';
    cls = 'bad';
  } else if (anyBad(/② WebGL/)) {
    verdict = '没有可用 WebGL 上下文，但 Spine 解析成功了 —— 显示层的问题，不是加载层。';
    cls = 'warn';
  } else {
    verdict = '四层全通过：这台设备上图片、取文件、Spine 解析、连续加载都正常。「立绘不显示」不在这些层里。';
  }
  verdictEl.className = cls;
  verdictEl.textContent = verdict;
  reportEl.value = `${verdict}\n\n${rows.map((r) => `${r.cls === 'bad' ? '✗' : r.cls === 'skip' ? '·' : '✓'} ${r.name}: ${r.value}`).join('\n')}`;
  window.__SPINE_PROBE__ = { done: true, verdict, cls, rows, ua: navigator.userAgent, protocol: location.protocol };
  document.dispatchEvent(new Event('spine-probe-done'));
}

document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportEl.value);
    row('复制', '已复制到剪贴板', 'ok');
  } catch {
    reportEl.select();
    row('复制', '浏览器不允许直接复制，已全选文本框，长按复制即可', 'skip');
  }
});

main().catch((e) => {
  row('探针异常', (e && (e.stack || e.message)) || String(e), 'bad');
  finish();
});
