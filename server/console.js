// Operator console on stdin, for a foreground run (`npm start` / `node server/index.js` in a terminal).
//
// ▸ Why a console at all: an announcement is issued by the person running the server, and the terminal is the shortest
//   path to it ("服务器 终端命令"). It is also the only interface that needs no port, no token and no HTTP client.
//   The chat switch (`/chat off`, shared/chat.js) is the same kind of lever — an operator reaching for it is reacting to
//   something happening right now, and a restart would be the wrong answer.
//
// ▸ A service (systemd) has no interactive stdin, so this is NOT the production interface for announcements — see the
//   `POST /admin/announce` endpoint in server/index.js, which is what a systemd deployment uses. Both end up in the
//   same AnnouncementBoard, so the two are interchangeable and can coexist. `/chat` has no HTTP twin: it is a
//   kill switch, and the person who needs it has a shell.
//
// ▸ Attached only when stdin is a TTY (or SP_CONSOLE=1 forces it): a server whose stdin is a pipe or /dev/null — a
//   container, a service, a `node … < /dev/null` run — must not sit with a half-open readline waiting for EOF.
//   A closed stdin ends the console, never the server: readline's 'close' is handled by detaching, not exiting.
//
// ▸ One console, several command sources: `board` (the announcement board) and `handlers` (e.g. the Lobby's `/chat`)
//   are tried in order and a line is claimed by the first source that recognises it. A source is any object with a
//   `handleCommand(line) → { handled, lines?, error? }` method, so adding a command never means touching this file.

import readline from 'node:readline';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Lines longer than this are refused unread (a paste accident, not a command). */
const MAX_LINE = 2000;

/** @typedef {{ handleCommand: (line: string) => { handled: boolean, lines?: string[], error?: string } }} CommandSource */

/**
 * Attach the operator console.
 *
 * @param {{
 *   board?: CommandSource | null,
 *   handlers?: CommandSource[],
 *   hint?: string,
 *   banner?: string,
 *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   force?: boolean,
 * }} opts
 * @returns {{ close: () => void, handleLine: (line: string) => boolean } | null}
 *   null when no console was attached (stdin is not interactive).
 */
export function installConsole({
  board = null, handlers = [], hint = null, banner = null,
  log = noopLog, input = process.stdin, output = process.stdout, force = false,
}) {
  const interactive = force || (input.isTTY === true && output.isTTY === true);
  if (!interactive) return null;

  /** @type {CommandSource[]} */
  const sources = [...(board ? [board] : []), ...handlers.filter((h) => h && typeof h.handleCommand === 'function')];
  const unknown = hint || (sources.length ? '未知命令。输入 /announce help 查看公告用法。' : '未知命令。');

  const write = (line = '') => { try { output.write(`${line}\n`); } catch { /* the pipe went away */ } };

  /**
   * Run one line. Exported shape (returned below) so tests can drive the console without a TTY.
   * @param {string} line
   * @returns {boolean} whether the line was claimed by a command source
   */
  const handleLine = (line) => {
    const raw = String(line ?? '').trim();
    if (!raw) return false;
    if (raw.length > MAX_LINE) { write(`命令行过长（上限 ${MAX_LINE} 字符）。`); return true; }
    let res = { handled: false };
    for (const source of sources) {
      try {
        res = source.handleCommand(raw);
      } catch (err) {
        log.error('[console] command failed', err);
        write(`命令执行失败：${err && err.message ? err.message : String(err)}`);
        return true;
      }
      if (res && res.handled) break;
    }
    if (!res || !res.handled) {
      write(unknown);
      return false;
    }
    if (res.error) write(`✗ ${res.error}`);
    for (const l of res.lines || []) write(l);
    return true;
  };

  const rl = readline.createInterface({ input, output, terminal: output.isTTY === true, historySize: 50 });
  rl.on('line', handleLine);
  // A closed stdin (EOF) or a destroyed stream detaches the console; the server keeps running.
  rl.on('close', () => { try { input.pause?.(); } catch { /* ignore */ } });
  rl.on('SIGINT', () => { /* Ctrl+C is the server's own shutdown (server/index.js main) */ });

  write('');
  write(banner);
  write('');
  return {
    handleLine,
    close: () => { try { rl.close(); } catch { /* ignore */ } },
  };
}
