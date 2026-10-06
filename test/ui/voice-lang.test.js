// test/ui/voice-lang.test.js — 配音语言切换：开关只认盘上真实素材，缺登记时退回中文而不是静音。
//
// 背景（实测）：官方语音的文件名**不带语言**（`cn_019.mp3` 在 voice_cn/voice/voice_en/voice_kr 四个目录里
// 都存在），所以「换配音」= 换清单路径里的语言段，不需要动 `data/assets.json` 的结构。我们仓里现在只有
// cn 与 jp 两份（`tools/fetch-voice-alt-langs.mjs jp`：1680 条，与 cn 逐文件比对 0 缺 0 多）。
//
// 要钉住的三件事：
//   1. 玩家选过日语之后，`AudioManager.voice()` 请求的是 `/voice/jp/…`，且**不再**请求 `/voice/cn/…`；
//   2. 没有 `data/voice-langs.json`（老包）或登记里没这门语言时，路径原样返回 —— 最坏继续放中文，绝不静音；
//   3. 设置页那一行的可见性来自登记（`availableLangs() < 2` 就不该出现），不是来自代码写了几个选项。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('data/assets.json'));

// 浏览器模块在 Node 里跑：只需要 storage 与 fetch 两件替身（这条不渲染 DOM）。
const prefs = new Map();
globalThis.localStorage = {
  getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
  setItem: (k, v) => prefs.set(k, String(v)),
  removeItem: (k) => prefs.delete(k),
};

/** 当前 `/data/voice-langs.json` 的内容；null = 这个包里没有这份登记。 */
let registry = null;
/** 除登记外的一切请求都当作素材请求，记下 URL 供断言。 */
const mediaUrls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.endsWith('/voice-langs.json')) {
    return registry ? { ok: true, status: 200, json: async () => registry } : { ok: false, status: 404 };
  }
  mediaUrls.push(url);
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
};

const { data } = await import('../../public/js/data.js');
const { voiceLang, voiceLangUrl, availableLangs, setVoiceLang, voiceLangsDoc, VOICE_LANG_PREF } = await import('../../public/js/ext/voiceLang.js');
const { AudioManager } = await import('../../public/js/audio.js');
const { mediaUrl } = await import('../../public/js/media.js');
const { buildDoc } = await import('../../tools/voice-langs.mjs');

/** 换一份登记并让 data.js 重新取（`ext/voiceLang.js` 读的就是这份缓存）。 */
async function useRegistry(doc) {
  registry = doc;
  prefs.delete(`sp.pref.${VOICE_LANG_PREF}`);
  mediaUrls.length = 0;
  await data.invalidate('voice-langs');
  return voiceLangsDoc();
}

const CN_URL = '/assets/audio/voice/cn/char_1012_skadi2/cn_019.mp3';
const JP_URL = '/assets/audio/voice/jp/char_1012_skadi2/cn_019.mp3';
const REG = { version: 1, default: 'cn', langs: { cn: { files: 1680, bytes: 1 }, jp: { files: 1680, bytes: 1 } } };
/** 这个 manifest 地址被请求过吗（/media/ 形式或 404 后的原始形式，同 test/ui/audio.test.js）。 */
const asked = (raw) => mediaUrls.includes(mediaUrl(raw)) || mediaUrls.includes(raw);

// 真 Chrome 的替身：audio.js 只用到 AudioContext / document.hidden / addEventListener。
function fakeWindow() {
  const listeners = new Map();
  class Param {
    constructor() { this.value = 1; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }
    cancelScheduledValues() {}
  }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node {
    constructor() { super(); this.playbackRate = new Param(); }
    start() {} stop() {}
  }
  class Ctx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    decodeAudioData(ab, ok) { ok({ duration: 1.5 }); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  return {
    win: { AudioContext: Ctx, document: { hidden: false, addEventListener() {} },
      addEventListener(t, fn) { listeners.set(t, fn); }, removeEventListener(t) { listeners.delete(t); } },
    fire(t) { listeners.get(t)?.(); },
  };
}

describe('没有登记时（老包 / 缺文件）', () => {
  test('语言退回中文，路径原样返回，切日语被拒绝', async () => {
    const doc = await useRegistry(null);
    assert.equal(doc, null, '没有 voice-langs.json 时登记为 null');
    assert.equal(voiceLang(), 'cn');
    assert.deepEqual(availableLangs(), [], '开关不该有任何可选项');
    assert.equal(voiceLangUrl(CN_URL), CN_URL, '不能改写出一个包里根本不存在的路径');
    assert.equal(setVoiceLang('jp'), false, '切到没登记的语言必须失败');
    assert.equal(prefs.get(`sp.pref.${VOICE_LANG_PREF}`), undefined, '被拒绝的切换不能留下偏好');
  });
});

describe('cn + jp 登记', () => {
  test('默认中文，切日语后改写语言段', async () => {
    await useRegistry(REG);
    assert.equal(voiceLang(), 'cn', '未选过时用登记的 default');
    assert.deepEqual(availableLangs(), ['cn', 'jp'], '两种都有才谈得上开关');
    assert.equal(voiceLangUrl(CN_URL), CN_URL);

    assert.equal(setVoiceLang('jp'), true);
    assert.equal(voiceLang(), 'jp');
    assert.equal(voiceLangUrl(CN_URL), JP_URL, '换配音 = 换清单路径里的语言段');
    assert.equal(voiceLangUrl(JP_URL), JP_URL, '已经是当前语言就不再动');
  });

  test('登记里没有的语言一律不接受（不留「切了但没声音」）', async () => {
    await useRegistry(REG);
    assert.equal(setVoiceLang('kr'), false, 'kr 素材没进包，不能出现在可选项里');
    assert.equal(setVoiceLang('cn'), true);
    assert.equal(voiceLang(), 'cn');
    assert.equal(voiceLangUrl(CN_URL), CN_URL);
  });

  test('只有一种素材时开关消失，且旧的日语偏好不会改写路径', async () => {
    await useRegistry({ version: 1, default: 'cn', langs: { cn: { files: 1680, bytes: 1 } } });
    assert.equal(availableLangs().length, 1, '单语言包：设置页那一行必须不出现（<2 项）');
    prefs.set(`sp.pref.${VOICE_LANG_PREF}`, JSON.stringify('jp')); // 玩家在别的包里选过日语
    assert.equal(voiceLang(), 'cn', '过期偏好退回登记里的 default');
    assert.equal(voiceLangUrl(CN_URL), CN_URL, '绝不改写到包里不存在的路径');
  });

  test('非语音路径（BGM / 音效）不碰', async () => {
    await useRegistry(REG);
    setVoiceLang('jp');
    for (const u of [manifest.audio.bgm.prep.loop, manifest.audio.sfx.ui.click, '/assets/audio/voice/cn_019.mp3', null, undefined, '']) {
      assert.equal(voiceLangUrl(u), u, `不该改写 ${u}`);
    }
  });
});

describe('AudioManager 走的就是改写后的路径', () => {
  const charId = Object.keys(manifest.audio.voice).sort().find((c) => typeof manifest.audio.voice[c]?.start === 'string');
  const raw = manifest.audio.voice[charId].start;

  test('选了日语：请求 /voice/jp/… 且不再请求 /voice/cn/…', async () => {
    await useRegistry(REG);
    setVoiceLang('jp');
    assert.match(raw, /\/voice\/cn\//, `前提：清单这条是中文路径（${raw}）`);
    const fw = fakeWindow();
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    assert.equal(a.voice(charId, 'start'), true, '这条台词存在并起播了');
    await new Promise((r) => setTimeout(r, 30));
    const jp = raw.replace('/voice/cn/', '/voice/jp/');
    assert.ok(asked(jp), `应请求日语路径 ${jp}，实际请求了 ${mediaUrls.join(' , ')}`);
    assert.ok(!asked(raw), '中文路径一次都不该被请求');
  });

  test('没选过（默认中文）：请求清单原路径', async () => {
    await useRegistry(REG);
    const fw = fakeWindow();
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    a.voice(charId, 'start');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(asked(raw));
    assert.ok(!mediaUrls.some((u) => u.includes('/voice/jp/')), '没选日语就不该碰日语目录');
  });

  test('老包（无登记）：请求清单原路径，不因缺登记而静音', async () => {
    await useRegistry(null);
    prefs.set(`sp.pref.${VOICE_LANG_PREF}`, JSON.stringify('jp'));
    const fw = fakeWindow();
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    assert.equal(a.voice(charId, 'start'), true, '登记缺失也要照常放中文');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(asked(raw));
    assert.ok(!mediaUrls.some((u) => u.includes('/voice/jp/')));
  });
});

describe('挂载点与登记本身', () => {
  test('上游两处挂载还在（audio.js 改写 + settings.js 一行开关）', () => {
    assert.match(read('public/js/audio.js'), /const url = voiceLangUrl\(/, 'voice() 的路径必须过改写');
    assert.match(read('public/js/ui/settings.js'), /<\$\{VoiceLangRow\} \/>/, '设置页必须挂这一行');
  });

  // 下面两条问的是**盘上文件**，而 public/assets/ 是 gitignore 的官方素材（CI 永远没有），
  // data/voice-langs.json 也按同一理由不入库（它描述的就是这台安装内容，同 data/local-assets.json）。
  // 所以这两条只在打包机上有效 —— 也就是真正会出事的那台机器。
  const haveVoice = existsSync(path.join(ROOT, 'public/assets/audio/voice/cn'))
    && existsSync(path.join(ROOT, 'public/assets/audio/voice/jp'))
    && existsSync(path.join(ROOT, 'data/voice-langs.json'));
  const skip = haveVoice ? false
    : '需要 public/assets/audio/voice/{cn,jp} 与 data/voice-langs.json：npm run assets && node tools/fetch-voice-alt-langs.mjs jp && node tools/voice-langs.mjs --write';

  test('data/voice-langs.json 与盘上真实文件一致（忘了 --write 就红）', { skip }, () => {
    const onDisk = JSON.parse(read('data/voice-langs.json'));
    assert.deepEqual(onDisk, buildDoc(), '改了素材目录后要跑：node tools/voice-langs.mjs --write');
    assert.deepEqual(Object.keys(onDisk.langs).sort(), ['cn', 'jp'], '本包实际内置的配音语言');
  });

  test('清单里每一条中文语音都有日语同名兄弟文件（缺一条就是静音事故）', { skip }, () => {
    const bank = manifest.audio.voice;
    const missing = [];
    let checked = 0;
    for (const [charId, slots] of Object.entries(bank)) {
      for (const line of Object.values(slots)) {
        for (const url of Array.isArray(line) ? line : [line]) {
          if (typeof url !== 'string' || !url.startsWith('/assets/audio/voice/cn/')) continue;
          checked++;
          const jp = path.join(ROOT, 'public', url.replace('/voice/cn/', '/voice/jp/'));
          if (!existsSync(jp)) missing.push(`${charId} → ${url}`);
        }
      }
    }
    assert.ok(checked >= 1000, `清单里的语音条目数异常（只扫到 ${checked} 条）`);
    assert.deepEqual(missing.slice(0, 10), [], `缺 ${missing.length} 个日语文件：${missing.slice(0, 10).join(', ')}`);
  });
});
