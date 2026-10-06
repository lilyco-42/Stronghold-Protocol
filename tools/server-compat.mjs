// tools/server-compat.mjs — 我们的客户端能不能连这台服务器？用**发空字段**的方式问出来。
//
// 原理：`shared/protocol.js` 是先查动词表、再校验字段的。所以对不存在的动词会回
// `BAD_MSG / unknown type <动词>`，对存在的动词会回字段校验错（或业务错）。两者一对，
// 就知道对方有没有这个动词 —— 而且**不会真的执行任何操作**，不会建房、不会开局、不会踢人。
//
// ⚠️ 两个坑，都是踩过才知道的：
//   1. `rid` 必须是整数（protocol.js:346 `isInt(msg.rid, 0, 2**31)`）。传字符串会在**动词查表之前**
//      就被 `bad rid` 挡掉，于是连一台完全支持的服务器看起来也"没有这个动词"。
//   2. 所以本工具自带两个对照：`zzz.nope`（一定不存在，必须报"没有"）和调用方给的阳性目标。
//      缺任何一个对照，结果一律标成不可信，不印成结论。
//
//   node tools/server-compat.mjs wss://sp.lain42.top/ws            # 单台
//   node tools/server-compat.mjs ws://a/ws ws://b/ws               # 多台，打矩阵
//   node --test test/server-compat.test.js                          # 对着本地服务器跑对照
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一定不存在的动词：用来证明"没有"这个判定本身是有效的（阴性对照）。 */
export const NEGATIVE_CONTROL = 'zzz.nope';

function* walkJs(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) yield* walkJs(p);
    else if (/\.(js|mjs)$/.test(n)) yield p;
  }
}

/**
 * 我们的客户端会发出去的全部动词。**从代码里抓**，不手抄 —— 手抄的那份会在有人新加一个
 * `net.request('room.xxx')` 之后继续报"全兼容"，那种矩阵比没有更坏。
 * @param {string} [root]
 * @returns {string[]} 排序后的动词名
 */
export function clientVerbs(root = ROOT) {
  const out = new Set();
  for (const file of walkJs(path.join(root, 'public', 'js'))) {
    const src = readFileSync(file, 'utf8');
    // 只认 `net.request('x.y')`：那才是**客户端发出去**的。早先还匹配过 `t: 'x.y'`，结果把
    // `b.ev` / `b.snap` / `m.field` 这些"服务器发给客户端"的帧名也收了进来 —— 探针去问服务器
    // "你支持 b.snap 吗"当然是"不支持"，矩阵就假报缺项。
    for (const m of src.matchAll(/\.request\(\s*'([a-z]+\.[a-zA-Z]+)'/g)) out.add(m[1]);
  }
  return [...out].sort();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 问一台服务器：这些动词你认不认。
 * @param {string} url @param {string[]} verbs @param {{greetMs?:number, perVerbMs?:number, handshakeMs?:number}} [opts]
 * @returns {Promise<{url:string, connected:boolean, app:string|null, present:string[], missing:string[], unknownAnswer:string[], controlOk:boolean, note:string}>}
 */
export async function probeVerbs(url, verbs, opts = {}) {
  const greetMs = opts.greetMs ?? 1500;
  const perVerbMs = opts.perVerbMs ?? 500;
  const all = [...new Set([...verbs, NEGATIVE_CONTROL])];
  const res = { url, connected: false, app: null, present: [], missing: [], unknownAnswer: [], controlOk: false, note: '' };
  let ws;
  try { ws = new WebSocket(url, { handshakeTimeout: opts.handshakeMs ?? 15000 }); } catch (e) { res.note = `握手失败 ${e.message}`; return res; }
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* 非 JSON 不算应答 */ } });
  try { await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }); }
  catch (e) { res.note = `连不上 ${e && e.message ? e.message : String(e)}`; try { ws.terminate(); } catch { /* 已断 */ } return res; }
  res.connected = true;
  ws.send(JSON.stringify({ t: 'hello', name: '兼容探测', version: 1 }));
  await wait(greetMs);
  res.app = msgs.find((m) => m.t === 'welcome')?.app || null;

  let rid = 1000;
  for (const v of all) {
    const id = ++rid;                       // 必须是整数：字符串 rid 会在查表前就被挡掉
    try { ws.send(JSON.stringify({ t: v, rid: id })); } catch { res.note = '发送失败，结果不完整'; break; }
    await wait(perVerbMs);
    const rep = msgs.find((m) => m.rid === id);
    const detail = (rep?.detail || rep?.msg || '').toString();
    if (v === NEGATIVE_CONTROL) {
      res.controlOk = !!rep && /unknown type/i.test(detail);
      continue;
    }
    if (!rep) { res.unknownAnswer.push(v); continue; }
    if (/unknown type/i.test(detail)) res.missing.push(v);
    else res.present.push(v);
  }
  try { ws.close(); } catch { /* 已关 */ }
  if (!res.controlOk) res.note = `${res.note} 阴性对照失败：${NEGATIVE_CONTROL} 没有被报成 unknown type，这份结果不可信。`;
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!urls.length) { console.error('用法: node tools/server-compat.mjs <ws://…> [更多服务器…]'); process.exit(2); }
  const verbs = clientVerbs();
  console.log(`客户端会发的动词（从 public/js 现抓）：${verbs.length} 个`);
  console.log(verbs.join(' ') + '\n');
  const rows = [];
  for (const u of urls) { const r = await probeVerbs(u, verbs); rows.push(r); console.log(`· ${u} → ${r.connected ? `缺 ${r.missing.length}${r.missing.length ? '：' + r.missing.join(',') : ''}` : '未连上 ' + r.note}`); }
  const head = ['动词', ...urls.map((u) => new URL(u).host)];
  console.log('\n' + head.join('\t'));
  for (const v of verbs) console.log([v, ...rows.map((r) => (r.connected ? (r.missing.includes(v) ? '✗' : '✓') : '?'))].join('\t'));
  const bad = rows.filter((r) => !r.controlOk || r.unknownAnswer.length);
  if (bad.length) { console.log('\n⚠ 有服务器的对照没过/有未应答动词，上面那列按未知处理：' + bad.map((b) => b.url).join(', ')); process.exit(1); }
}
