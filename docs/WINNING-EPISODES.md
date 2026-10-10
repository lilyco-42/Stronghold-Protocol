# Optional winning-decision dataset for a policy bot

This fork feature only **collects** server-accepted player decisions. It does not
train a model, deploy a bot or change game mechanics.

## Safety and consent

- Disabled by default. Operators must inform players and obtain appropriate consent
  **before** enabling this experiment. Never enable silently on a public server.
- Set SP_WIN_EPISODES=1 on the Node game server to capture. Removing it disables
  capture. No client modification, token or R2 credentials are required to play.
- The server stores decisions in memory until match end. **Only actual victories**
  become gzip JSON episodes. Losses, failed commands, spectators, chat, room codes,
  names, player IDs, reconnect tokens and IP addresses are not included.
- A co-op victory is a **team-level label**, not proof that each individual action
  was optimal; train and evaluate with fresh seeds, difficulties and held-out matches.
- Every episode is limited to 1500 decisions; truncated episodes are discarded to
  avoid exporting incomplete "winning" examples. Unfinished matches are discarded
  on restart. Capturing only victories introduces selection bias; do not advertise
  imitation learning as proof of an optimal strategy.
- Samples include public game state and the acting player's own shop, board and
  resources, but no teammate private info. This is training data, not a fully
  deterministic replay (not every engine transition is logged).
- By default, local encrypted-disk access and private R2 bucket access should be
  limited to authorized operators. Plan retention/deletion before collecting.
  A random episode UUID has no stable player association, so individual
  retrieval/deletion by player is not possible in this minimal anonymous dataset.

## Configuration

Node server:

    SP_WIN_EPISODES=1
    SP_WIN_EPISODES_DIR=/var/lib/stronghold/win-episodes   # optional

Each winning episode is a UUID-named json.gz in that directory. The collector
uses atomic writes. Keep the directory out of any web server static root and
back it up / monitor free space as needed.

**R2 upload is a separate explicit operator action.** Create a private R2
bucket in Cloudflare and log into Wrangler. No R2 secret goes into the game or
the client. In the server repo (with Wrangler installed and logged in):

    SP_WIN_EPISODES_DIR=/var/lib/stronghold/win-episodes SP_R2_BUCKET=sp-training \
      node tools/upload-winning-episodes.mjs
    SP_WIN_EPISODES_DIR=/var/lib/stronghold/win-episodes SP_R2_BUCKET=sp-training \
      node tools/upload-winning-episodes.mjs --upload

The first invocation is a dry run; the second calls
wrangler r2 object put <bucket>/training/wins/v1/<uuid>.json.gz
--file ... --remote --content-encoding gzip.
On successful upload, files are moved to the local sent/ directory, and on
failure they remain queued for retry. There is no upload or outbound network
operation inside the game process. SP_R2_BATCH limits the batch size (default 50).
Configure scheduled runs if needed; do not schedule by default. Keep R2 private.

## Dataset v1

An episode has {schema, gameVersion, episodeId, mode, difficulty, seed,
outcome:{victory:true,roundsPassed}, samples:[{seat,state,action}]}.

Capture point: server/lobby.js routeGame() after match.handle() accepts the
intent, snapshotting the **pre-action** state first; onMatchEnd() decides whether
to persist. This design is isolated from deterministic server/sim/ and remains
disabled unless explicitly enabled. Changing the protocol or training target
requires a version bump and new tests.
