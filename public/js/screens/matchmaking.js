// 快速匹配等待屏 (public/js/screens/matchmaking.js) — what a waiting room shows instead of its seat grid.
//
// ▸ Why a screen and not a state of screens/room.js: the waiting room IS a room (server/lobby.js matchmake — it has a
//   code, a host, a chat log and 干员调配), and the only difference is what the queue decides. Swapping the whole body
//   keeps the room screen honest about its own job (seats, ready, start) while the queue shows what it knows: who is
//   here, how long we have waited, and how to leave. The benchmark reached the same shape (`MatchmakingScreen` replaces
//   the room screen), and the diversion is one line in screens/room.js.
//
// ▸ The queue's numbers come from the server, never from a client guess: `matchmakingSince` is a SERVER timestamp (the
//   clock is derived from store.serverNow(), like the announcement strip) and `matchmakingTimeoutSec` is the wait in
//   force for THIS queue (`/match timeout` can change it while we wait). The rule sentence itself is shared with the
//   server (shared/matchmaking.js `matchmakingRule`), so the screen cannot promise a rule the server does not play.
//
// ▸ 等待期间照常可用: the room chat panel (ui/roomChat.js) and 干员调配 (LoadoutButton below) both keep working while
//   queued — talking the team over and picking operators is exactly what a waiting doctor should be doing. Only what
//   shapes the lobby room (ready / difficulty / AI seats / start) is refused, by the server.
//
// ▸ A doctor who drops keeps their seat for the lobby grace (the server says so by leaving them in `seats` with
//   connected:false), so the screen says 连接中断 and keeps counting them out loud instead of quietly shrinking the
//   queue. Reconnecting puts them back in the same queue.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { MAX_SEATS, DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { matchmakingClock, matchmakingCount, matchmakingRule } from '../../../shared/matchmaking.js';
import { html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, Tooltip } from '../ui/components.js';
import { toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { useStore, shallowEqual, serverNow } from '../store.js';

/**
 * The waiting screen's status line: how many doctors are here, out of how many, and what happens next.
 * @param {number} count connected doctors
 * @param {number} capacity doctors that start the match at once
 * @param {{ online?: boolean }} [opts]
 * @returns {string}
 */
export function queueStatusText(count, capacity, { online = true } = {}) {
  if (!online) return '连接已中断，重连后自动回到队列';
  if (count >= capacity) return `已找到 ${count} / ${capacity} 名博士，正在进入模拟…`;
  return `已找到 ${count} / ${capacity} 名博士，满员自动开始`;
}

/** Seconds since a server timestamp, ticking once a second (this screen's own timer — the store holds no clock tick). */
function useElapsed(since) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return Number.isFinite(since) && since > 0 ? Math.max(0, now - since) : 0;
}

/**
 * The waiting screen. Mounted by screens/room.js while `room.matchmaking` is set and no match runs.
 * @param {{ room: any, seats: (any|null)[] }} props `seats` = the padded seat grid of screens/room.js `roomFacts`
 */
export function MatchmakingScreen({ room, seats }) {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsed(room.matchmakingSince);
  const online = conn.status === 'online';
  const capacity = room.mode === 'solo' ? 1 : MAX_SEATS;
  const grid = Array.isArray(seats) ? seats : [];
  const count = matchmakingCount(grid);
  const timeoutSec = Number.isFinite(room.matchmakingTimeoutSec) && room.matchmakingTimeoutSec > 0
    ? room.matchmakingTimeoutSec
    : undefined;

  const cancel = async () => {
    if (busy || !online) return;
    setBusy(true);
    try {
      await net.request('room.cancelMatchmaking');
      // The server answers room.closed {matchmaking_cancelled} and main.js returns us to the lobby; the local clear is
      // only the safety net for a frame that never arrives (the same reasoning as screens/room.js leave()).
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
      return;
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="screen mm-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${PingPill} ms=${conn.ping} online=${online} />
        <${MicroLabel}>QUICK MATCH<//>
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">ALLIANCE SIMULATION · AUTO MATCHING<//>
        <h1 class="topbar__title">正在匹配队友</h1>
      </div>
      <div class="topbar__right">
        <${GuideButton} class="mm-guide" variant="secondary" />
      </div>
    </header>

    <main class="mm-body">
      <section class="mm-card brackets">
        <header class="mm-card__head">
          <${DifficultyTag} difficulty=${room.difficulty} size="lg" />
          <span class="mm-card__clock num" title="已等待时间">${matchmakingClock(elapsed)}</span>
        </header>

        <p class="mm-card__status" role="status">${queueStatusText(count, capacity, { online })}</p>

        <div class="mm-progress" role="progressbar" aria-label="匹配进度"
          aria-valuemin=${0} aria-valuemax=${capacity} aria-valuenow=${count}
          aria-valuetext=${`${count} / ${capacity} 名博士`}>
          <span class="mm-progress__fill" style=${`width:${Math.min(100, (count / capacity) * 100)}%`}></span>
        </div>

        <ol class="mm-seats" aria-label="匹配队伍">
          ${grid.map((s, i) => {
            const mine = !!s && s.playerId === me.playerId;
            const offline = !!s && s.connected === false;
            return html`<li key=${s ? `p${s.playerId}` : `e${i}`}
              class=${`mm-seat${s ? ' is-filled' : ''}${mine ? ' is-me' : ''}${offline ? ' is-offline' : ''}`}>
              <${AvatarFrame} size="lg" name=${s?.name || ''} seat=${i} self=${mine} offline=${offline} empty=${!s} />
              <span class="mm-seat__name">${s ? (s.name || '博士') : '等待博士'}</span>
              <span class="mm-seat__state">
                ${!s ? '空缺席位' : mine ? '你 · 已加入' : offline ? '连接中断' : '已加入'}
              </span>
            </li>`;
          })}
        </ol>

        <p class="mm-card__hint"><${Icon} name="info" />${matchmakingRule(timeoutSec, capacity)}</p>

        <div class="mm-card__actions">
          <${LoadoutButton} from="room" size="lg" class="mm-loadout" />
          <${Tooltip} text=${online ? '离开匹配队列，回到大厅（不影响其他正在等待的博士）' : '连接已中断，重连后自动回到队列'}>
            <${Button} variant="danger" size="lg" icon="exit" loading=${busy} disabled=${!online} onClick=${cancel}>取消匹配<//>
          <//>
        </div>

        <p class="mm-card__note">
          等待期间可以继续调配干员、在同盟频道聊天；匹配成功后自动进入模拟，无需再点开始。
        </p>
      </section>
    </main>
  </div>`;
}
