// tools/skin-selection.mjs — the single source of truth for which skins a build may touch.
//
// The upstream skin tools (fetch-skin-{avatars,spines}.mjs, inject-skins-assets.mjs) iterate the whole 174-skin
// research table, which would download ~190 MB and write 174 manifest entries whose files are absent — and
// `test/assets.test.js` fails when the manifest names a path that is not on disk. All three therefore filter
// through this list, so an empty file means "no skin art at all" and a skin only appears once it is installed.
//
// data/skins-installed.json is a JSON array of skinIds (`char_002_amiya@winter#1`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKINS_INSTALLED_PATH = path.join(ROOT, 'data', 'skins-installed.json');

/** @returns {Set<string>} the installed skinIds; empty when the file is missing, empty or unreadable. */
export function installedSkinIds() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SKINS_INSTALLED_PATH, 'utf8')); } catch { return new Set(); }
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v) => typeof v === 'string' && v));
}

/** Whether `skinId` may be downloaded / injected / listed in the manifest. */
export const isInstalled = (ids, skinId) => ids.has(skinId);

/**
 * Is this skeleton a **battle** model, or a 宿舍 / 基建 one?
 *
 * Measured 2026-10-07: fexli ships `spine/<char>/<stem>/Spine/` for some outfits and that copy is the
 * *dorm / interact* skeleton (`Default/Interact/Move/Relax/Sit/Sleep/Special`), while `Front|Back/` next to it
 * holds the real battle model (`Attack/Default/Die/Idle/Start`). A directory-preference rule cannot tell those
 * apart — only the animation set can. `resolveRoles` happily aliases a missing attack onto the idle clip, so the
 * check has to be "the attack clip is its own animation", not merely "attack resolved".
 *
 * @param {string[]} animationNames names straight out of the .skel
 * @param {Record<string, string|null>} [roles] a resolveRoles() result for those names
 */
export function isBattleSkeleton(animationNames, roles) {
  const names = Array.isArray(animationNames) ? animationNames : [];
  if (!names.length) return false;
  const r = roles;
  if (!r) return false;
  if (!r.idle) return false;
  const attackLoop = r.attack?.loop;
  return !!attackLoop && attackLoop !== r.idle;
}

/**
 * A hint for a machine that reaches GitHub only through a local proxy, or null when there is nothing to say.
 *
 * Node's global fetch ignores HTTP(S)_PROXY unless the process started with NODE_USE_ENV_PROXY=1 (Node 24+), so on
 * such a machine every candidate URL fails with ECONNRESET while `curl` on the same URL returns 200 — a download tool
 * that just reports "failed" here looks like a dead upstream URL. Measured on the dev machine 2026-10-06.
 */
export function proxyHint(env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!proxy || env.NODE_USE_ENV_PROXY) return null;
  return `所有地址都连不上，而本机设了代理 ${proxy}：Node 的 fetch 默认不走代理，请用 ` +
    `NODE_USE_ENV_PROXY=1 node tools/fetch-skin-… 重跑（curl 走代理所以能通，别误判成源站失效）`;
}
