# Client-only winning decision dataset

This opt-in experiment runs **entirely in the browser/Electron/Android/iOS WebView client**.
It does not change the Node game server, shared network protocol, production services,
rooms, or the deterministic battle engine. There are no background uploads.

## Player workflow

1. Open the waiting room and enable 自愿保存本机匿名胜局（仅本局）.
2. The browser takes a bounded snapshot of its own `m.private` plus a few fields of
   `m.public` immediately before a strategic `g.*` request is sent. **Only actions
   confirmed by `ok`** are included; errors/timeouts are ignored.
3. A final `m.result` must contain `victory: true` and the local player in `players`.
   Failed games and incomplete/disconnected browser sessions are discarded. The
   consent switch resets at result, room leave, and new-room entry.
4. The complete victory is saved in **this device's IndexedDB**, at most 40 games
   and 1200 decisions per episode. Export via `导出胜局训练数据` in the room: downloads
   `stronghold-winning-decisions.jsonl`. This is a local file; no automatic upload.

The dataset contains only allowlisted action arguments (piece IDs, positions, shop
choices), the local player's own board, shop, funds, effects, and match metadata.
Never persist room codes, playerId, username, IP, session or reconnect token,
chat, or other players' private game views. The in-memory room code is only used
for resetting consent on a room switch. No personally identifying fields belong
in the exported JSONL file.

Browser export uses one JSON object per line, with `schema:
sp.client-winning-decisions.v1`, `episodeId` (random UUID), `samples: [{state,
action}]`, mode, difficulty, seed and victory/rounds. A deterministic split of
whole episodes into train/validation sets is required to avoid leakage.

## Trust and storage

Client-side results are **not authenticated training evidence**: a modified
client may fabricate actions or wins. Treat the export as untrusted; validate
schema/size, de-duplicate, and compare proposed policies in seeded simulations
before claiming improved win rate. A team win is not proof every step was optimal.
Users can delete this site's/app's IndexedDB data in browser storage settings.
Disclose the purpose and offer an opt-out; browser storage and downloads remain
under the player's control. Never include an R2 API key in shipped JavaScript.

## Optional Cloudflare R2 transfer

Players may voluntarily share their downloaded JSONL with the operator, who can
upload it directly using authenticated Wrangler, for example:

    wrangler r2 object put <private-bucket>/training/client-wins/<batch-id>.jsonl \
      --file ./stronghold-winning-decisions.jsonl --remote --content-type application/x-ndjson

Replace `<batch-id>` with a unique operator-generated batch ID, never the
player's name. This transfers **client → operator → R2**, not through the game
server. Direct automated client-to-R2 uploads require a separately managed
Cloudflare Worker ingress with access control, abuse limits, schema validation,
and a per-user consent process; they are intentionally out of scope here.

## Test

    node --test test/client-winning-recorder.test.js

No server-side module or protocol change is necessary. A fresh web-client build
or payload/desktop-client package is needed before the new UI appears to players.
