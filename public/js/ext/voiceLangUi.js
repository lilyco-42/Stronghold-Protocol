// ext/voiceLangUi.js — 设置页里的「配音语言」一行。
//
// 这一行**只在包里真有第二种配音时出现**：可见性来自 `data/voice-langs.json`（`tools/voice-langs.mjs`
// 按盘上 mp3 真实数量生成），不是来自这里写了几个选项。所以老包/只装中文的包不会长出这个开关，
// 也就不会出现「切了日语然后静音」。
//
// 上游挂载点只有 `ui/settings.js` 里的一行 `<${VoiceLangRow} />`；逻辑都在 ext/voiceLang.js。
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel } from '../ui/components.js';
import { data } from '../data.js';
import { audio } from '../audio.js';
import { loadVoiceLangs, availableLangs, voiceLang, setVoiceLang, VOICE_LANG_LABELS, voiceLangsDoc } from './voiceLang.js';

/** 试听用的干员：清单里第一个有 `select` 台词的（按 id 排序，稳定）。换语言时播同一句，玩家听得出差别。 */
function previewChar() {
  const bank = data.get('assets')?.audio?.voice || {};
  const id = Object.keys(bank).sort().find((c) => typeof bank[c]?.select === 'string' || Array.isArray(bank[c]?.select));
  return id || null;
}

export function VoiceLangRow() {
  const [, bump] = useState(0);

  // 登记是异步的（data.js 的 no-cache 请求）：到货后重渲染一次，这一行才会在素材存在时出现。
  useEffect(() => {
    let dead = false;
    const off = data.subscribe?.(() => { if (!dead) bump((n) => n + 1); });
    loadVoiceLangs().then(() => { if (!dead) bump((n) => n + 1); });
    return () => { dead = true; off?.(); };
  }, []);

  const langs = availableLangs();
  if (langs.length < 2) return null;
  const cur = voiceLang();
  const doc = voiceLangsDoc();

  return html`<div class="set-row" data-testid="voice-lang-row">
    <span class="set-row__label">配音语言<${MicroLabel}>VOICE LANG<//></span>
    <div class="set-seg" role="radiogroup" aria-label="配音语言">
      ${langs.map((id) => html`<button key=${id} type="button" role="radio" data-voice-lang=${id}
        aria-checked=${cur === id ? 'true' : 'false'} class=${cur === id ? 'is-on' : ''}
        title=${`${VOICE_LANG_LABELS[id] || id} · ${doc?.langs?.[id]?.files ?? '?'} 条`}
        onClick=${() => {
          if (!setVoiceLang(id)) return;
          bump((n) => n + 1);
          const char = previewChar();
          if (char) audio.voice(char, 'select'); // 换完立刻听见差别；audio 从不抛错
        }}>${VOICE_LANG_LABELS[id] || id}</button>`)}
    </div>
  </div>`;
}
