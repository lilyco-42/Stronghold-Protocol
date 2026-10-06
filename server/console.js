// Operator console on stdin, for a foreground run (`npm start` / `node server/index.js` in a terminal).
//
// ▸ Why a console at all: an announcement is issued by the person running the server, and the terminal is the shortest
//   path to it ("服务器 终端命令"). It is also the only interface that needs no port, no token and no HTTP client.
//
// ▸ A service (systemd) has no interactive stdin, so this is NOT the production interface — see the
//   `POST /admin/announce` endpoint in server/index.js, which is what a systemd deployment uses. Both end up in the
//   same AnnouncementBoard, so the two are interchangeable and can coexist.
//
// ▸ Attached only when stdin is a TTY (or SP_CONSOLE=1 forces it): a server whose stdin is a pipe or /dev/null — a
//   container, a service, a `node … < /dev/null` run — must not sit with a half-open readline waiting for EOF.
//   A closed stdin ends the console, never the server: readline's 'close' is handled by detaching, not exiting.

import readline from 'node:readline';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Lines longer than this are refused unread (a paste accident, not a command). */
const MAX_LINE = 2000;

/**
 * Attach the operator console.
 *
 * @param {{
 *   board: import('./announcement.js').AnnouncementBoard,
 *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   force?: boolean,
 * }} opts
 * @returns {{ close: () => void, handleLine: (line: string) => boolean } | null}
 *   null when no console was attached (stdin is not interactive).
 */
export function installConsole({ board, log = noopLog, input = process.stdin, output = process.stdout, force = false }) {
  const interactive = force || (input.isTTY === true && output.isTTY === true);
  if (!interactive) return null;

  const write = (line = '') => { try { output.write(`${line}\n`); } catch { /* the pipe went away */ } };

  /**
   * Run one line. Exported shape (returned below) so tests can drive the console without a TTY.
   * @param {string} line
   * @returns {boolean} whether the line was an announcement command
   */
  const handleLine = (line) => {
    const raw = String(line ?? '').trim();
    if (!raw) return false;
    if (raw.length > MAX_LINE) { write(`命令行过长（上限 ${MAX_LINE} 字符）。`); return true; }
    let res;
    try {
      res = board.handleCommand(raw);
    } catch (err) {
      log.error('[console] command failed', err);
      write(`命令执行失败：${err && err.message ? err.message : String(err)}`);
      return true;
    }
    if (!res.handled) {
      write('未知命令。输入 /announce help 查看公告用法。');
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
  write('操作台已就绪。输入 /announce help 查看公告用法。');
  write('');

  return {
    handleLine,
    close: () => { try { rl.close(); } catch { /* ignore */ } },
  };
}
