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
