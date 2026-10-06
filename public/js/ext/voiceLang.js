// ext/voiceLang.js — 配音语言切换（我们自己的扩展，不在上游文件里放逻辑）。
//
// 设计取舍：清单 `data/assets.json` 的 `audio.voice[charId][slot]` 保持上游那份**只写中文**的样子，
// 日语/英语/韩语靠"同名不同目录"推导 —— 这是实测出来的事实（140 个干员 × 12 个槽位，cn 与 jp 目录
// 逐文件比对 0 缺 0 多，文件名都是 `cn_019.mp3`，语言不体现在文件名里）。这样不用改 `tools/fetch-assets.mjs`
// 的清单结构，上游改了素材清单也不会撞掉我们的东西；代价是"这个包里到底有没有日语"不能靠清单回答，
// 必须问 `data/voice-langs.json`（由 `tools/voice-langs.mjs --write` 按**盘上真实文件**生成）。
//
// 所以开关的可见性来自那份登记，而不是来自代码写了几个选项：只装中文的包里根本不会出现这个设置行。
// 这一点是「时装页摆出来却一款都没有」那个坑的直接教训。
import { data } from '../data.js';
import { loadPref, savePref } from '../store.js';

/** `data/voice-langs.json` 在 data.js 里的名字（文件名同名的连字符形式）。 */
export const VOICE_LANGS_FILE = 'voice-langs';
export const VOICE_LANG_PREF = 'voiceLang';
/** 清单里的中文语音路径形状；不匹配（比如上游换了目录）就原样返回，绝不猜。 */
const VOICE_RE = /^\/assets\/audio\/voice\/([a-z]{2})\/(.+)$/;
/** 界面文案。只在这里列，设置行与提示共用一份。 */
export const VOICE_LANG_LABELS = Object.freeze({ cn: '中文', jp: '日语', en: '英语', kr: '韩语' });
const FALLBACK = 'cn';

/** 预热登记（一次，走 data.js 的重试与降级）。 */
export function loadVoiceLangs() {
  return data.load(VOICE_LANGS_FILE);
}

// 本模块被 audio.js 引入，于是这句在页面启动时就跑到了：玩家上次选的语言要在**第一句台词之前**就生效，
// 不能等到设置弹窗第一次渲染。data.js 缓存这条请求，重复调用不会重发；缺失/断网时按 data.js 的降级返回 null，
// 届时一切照旧（放中文）。
loadVoiceLangs();

/** 盘上真有素材的登记；未加载或缺失时为 null。 */
export function voiceLangsDoc() {
  const v = data.get(VOICE_LANGS_FILE);
  return v && typeof v === 'object' && v.langs && typeof v.langs === 'object' ? v : null;
}

/** 包内真的有几种配音，顺序照登记（`tools/voice-langs.mjs` 按 cn→jp→en→kr 写）。少于 2 时设置页不该出现开关。 */
export function availableLangs() {
  return Object.keys(voiceLangsDoc()?.langs || {});
}

/** 当前生效的语言。没登记（老包/没这文件）时一律中文。 */
export function voiceLang() {
  const doc = voiceLangsDoc();
  if (!doc) return FALLBACK;
  const stored = loadPref(VOICE_LANG_PREF, null);
  if (typeof stored === 'string' && doc.langs[stored]) return stored;
  if (doc.default && doc.langs[doc.default]) return doc.default;
  return Object.keys(doc.langs)[0] || FALLBACK;
}

/**
 * 玩家切换。不在登记里的语言一律拒绝 —— 不做「切了但没声音」那种事。
 * @returns {boolean} 是否被接受
 */
export function setVoiceLang(lang) {
  if (typeof lang !== 'string' || !voiceLangsDoc()?.langs?.[lang]) return false;
  savePref(VOICE_LANG_PREF, lang);
  return true;
}

/**
 * 把清单里的语音路径改写成当前语言的那份。认不出来、或当前语言根本没登记，就**原样返回**，
 * 于是最坏情况是「继续放中文」，不会是「没声音」。
 * @param {string|null|undefined} url
 * @returns {string|null|undefined}
 */
export function voiceLangUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const lang = voiceLang();
  const m = VOICE_RE.exec(url);
  if (!m || m[1] === lang || !voiceLangsDoc()?.langs?.[lang]) return url;
  return `/assets/audio/voice/${lang}/${m[2]}`;
}
