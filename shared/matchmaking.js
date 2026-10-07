// shared/matchmaking.js — the quick-match queue: its rules, and the sentences that state them. Pure ESM, no Node APIs.
//
// ▸ Why a shared module for two numbers and one sentence: the start rule is told to the PLAYER on the waiting screen
//   and to the OPERATOR in `/match status`, and both must be the sentence the server actually implements. A rule that
//   drifts from its description is worse than no description — so the text and the numbers live here, next to
//   `matchmakingCount`, which is the single definition of "how many doctors are queued".
//
// ▸ The rule (owner's decision 2026-10-07, "满员或超时"): a full queue (MAX_SEATS doctors) starts at once; a queue that
//   is not full starts with the doctors it has once `timeoutMs` has passed, as long as at least `minPlayers` are there;
//   a single doctor keeps waiting — a one-doctor co-op run is what 独立模拟 / a private room is for, and starting one
//   from 快速匹配 would be a surprise. The server re-arms the wait after every round, so a second doctor arriving late
//   waits one round, not the whole of the previous one.
//
// ▸ `matchmakingCount` counts CONNECTED HUMANS on both sides of the wire: the number on the waiting screen is the
//   number the server starts with, and a seat whose doctor dropped (still inside the lobby grace) is shown and counted
//   as offline rather than as a teammate.

import { MAX_SEATS } from './constants.js';

/** Tunables of the matching queue (server/lobby.js options, `SP_MATCH_TIMEOUT`). */
export const MATCHMAKING = Object.freeze({
  /** Doctors that must be queued before a wait that timed out may start a match (a lone doctor keeps waiting). */
  minPlayers: 2,
  /** Default wait before a not-yet-full queue starts with the doctors it has (ms). */
  timeoutMs: 60_000,
  /** Bounds `/match timeout` accepts (seconds) — a live lever, so it may not be set to something absurd. */
  minTimeoutSec: 5,
  maxTimeoutSec: 600,
});

/**
 * How many doctors a waiting room is counting: its connected human seats. Accepts the server's raw seats
 * (`server/lobby.js` Room.seats) and the `room.state.seats` payload a client holds, which is what keeps the two counts
 * identical. Bots never queue (a queue room refuses them) and a seat whose doctor left reads `connected: false`.
 * @param {any[] | null | undefined} seats
 * @returns {number}
 */
export const matchmakingCount = (seats) => (Array.isArray(seats) ? seats : [])
  .filter((s) => s && !s.isBot && s.connected !== false).length;

/**
 * The queue's start rule, as one sentence (the waiting screen's hint and `/match status` both print it).
 * @param {number} [timeoutSec] the wait in force, in seconds
 * @param {number} [capacity] doctors that make the queue start at once
 * @returns {string}
 */
export function matchmakingRule(timeoutSec = MATCHMAKING.timeoutMs / 1000, capacity = MAX_SEATS) {
  const sec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.round(timeoutSec) : MATCHMAKING.timeoutMs / 1000;
  return `满 ${capacity} 名博士立即开始；已有 ${MATCHMAKING.minPlayers} 名以上时，等待 ${sec} 秒也会按当前人数开始。`;
}

/**
 * Elapsed waiting time as `m:ss` (`0:07`), for a queue that started at a server timestamp.
 * @param {number} ms
 * @returns {string}
 */
export function matchmakingClock(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * What a client says when a queue ends — `room.closed { reason }` with one of the queue's three reasons
 * (server/lobby.js matchmake). `null` means "say nothing": 取消匹配 is what the player just asked for, and a toast
 * there would be noise. The wording lives here rather than in main.js so that a queue reason can never be renamed on
 * one side only (the client's own map is spread with this one, and an unknown reason falls back to the generic text).
 */
export const MATCHMAKING_CLOSE = Object.freeze({
  matchmaking_cancelled: null,
  matchmaking_disconnected: '长时间未连接，已退出匹配队列',
  matchmaking_failed: '本次匹配未能开局，请稍后重新匹配',
});

// ---- operator console commands (server/lobby.js handleCommand) -------------------------------------
//
// ▸ Why an operator command when the benchmark has none: `SP_MATCH_TIMEOUT` only decides at boot, and the wait a small
//   server wants is not a constant — an empty evening wants a long one, a Friday night a short one. `/match timeout`
//   changes it on a running server (the queues in flight adopt it on their next wait) and `/match status` answers
//   "is anybody queued right now", which is otherwise invisible from outside.

const MATCH_COMMAND = /^(?:\/?match|匹配)(?:\s+([\s\S]*))?$/i;

/** The `/match` subcommands, as the console prints them. */
export const MATCH_HELP = [
  '/match                  查看匹配队列：等待中的人数、难度与等待时间',
  `/match timeout <秒>     设置等待时间（${MATCHMAKING.minTimeoutSec}–${MATCHMAKING.maxTimeoutSec}，默认 ${MATCHMAKING.timeoutMs / 1000}）`,
  '/match help             显示本帮助',
].join('\n');

/**
 * Parse one operator console line.
 * @param {unknown} line
 * @returns {{ action: 'status'|'help' } | { action: 'timeout', sec: number } | { action: 'error', error: string } | null}
 *   null when the line is not a match command at all (the console may offer it to something else).
 */
export function parseMatchCommand(line) {
  const m = MATCH_COMMAND.exec(String(line ?? '').trim());
  if (!m) return null;
  const arg = String(m[1] ?? '').trim();
  const lower = arg.toLowerCase();
  if (!arg || lower === 'status' || arg === '状态') return { action: 'status' };
  if (lower === 'help' || arg === '帮助' || lower === '?' || lower === '-h' || lower === '--help') return { action: 'help' };
  const tm = /^(?:timeout|wait|超时|等待)\s*(\d+)$/i.exec(arg);
  if (tm) {
    const sec = Number(tm[1]);
    if (!Number.isInteger(sec) || sec < MATCHMAKING.minTimeoutSec || sec > MATCHMAKING.maxTimeoutSec) {
      return { action: 'error', error: `等待时间需在 ${MATCHMAKING.minTimeoutSec}–${MATCHMAKING.maxTimeoutSec} 秒之间，输入 /match help 查看用法。` };
    }
    return { action: 'timeout', sec };
  }
  return { action: 'error', error: `未知的匹配子命令「${arg.slice(0, 32)}」，输入 /match help 查看用法。` };
}
