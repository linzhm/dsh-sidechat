# dsh-sidechat

Codex `/side`-style side chats for the DSH web GUI.

A side chat forks the current session at its latest completed turn into a **lineage
child** (same workspace/cwd, full history copied). The child then receives a boundary
message that marks the inherited history as **reference-only**: the model answers side
questions without treating the parent's plans/tool calls as its own active task, and
defaults to non-mutating exploration. While you work in the side chat, the UI keeps
showing the **parent's live status** (running / needs input / needs approval /
finished), and you can jump back to the parent with one click. Closing the side chat
archives the child instead of deleting it.

## Layout

```
src/index.ts        node half: cordis plugin (fork+inject API, projection unit, model tool)
src/client.ts       browser half: UI (entry button, status chip, jump-back, close)
cordis.patch.yml    bundle patch (inserts `dsh-sidechat` into the cordis tree)
scripts/install-profile.sh   manual install (symlink + bundles entry)
scripts/build-client.mjs     client bundle build + __ModuleLoader__ wrap
```

## Build

```
pnpm install        # local toolchain (tsdown), store under the workspace
pnpm bundle         # src/*.ts -> lib/index.js (ESM) + lib/client.js (wrapped CJS)
pnpm watch          # rebuild client bundle on change (HMR picks it up, no refresh)
```

## Install (two forms)

### A. Native `dsh plugin` (recommended — managed, upgrade-friendly)

From a local checkout:

```
dsh plugin --profile web add /absolute/path/to/plugins/dsh-sidechat
```

Directly from this repository (pnpm resolves git dependencies; requires the
installed `dsh` CLI on PATH):

```
dsh plugin --profile web add https://github.com/<owner>/dsh-sidechat
```

pnpm records the dependency in the profile `package.json` and the plugin CLI
auto-appends the bundle to `dsh.profile.bundles`. Removal is
`dsh plugin --profile web remove dsh-sidechat`.

### B. Manual (no CLI)

```
./scripts/install-profile.sh
```

symlinks the package into the profile `node_modules` and appends the bundles entry.

Either way: **restart the Engine** (relaunch Octopus Workbench) for the server half to
load. Client-bundle rebuilds after that are hot-reloaded by the running
client-plugin HMR receiver (`pnpm watch`).

## Compatibility across DSH upgrades

The plugin rides documented seams only, so an engine upgrade has good odds of working
unchanged — but nothing is automatic:

| Surface the plugin uses | Stability |
|---|---|
| `session.fork` RPC + `session` event log (incl. `user/message`, `session/end-seed`) | wire contract, `SESSION_FORMAT_VERSION`-guarded — stable |
| `ctx.apiProxy`, `ctx.webServer.register`, `ctx.sessionProjections.register`, `ctx.tools.register` | documented host seams — stable |
| `session` projections in client summaries | stable wire shape |
| client slots `conversation.session.header.actions` / `.utilities`, `ctx.sessions`/`ctx.workspaces` | UI internals of `dsh-web-app` — most likely to change in a major UI refactor |

Practice after an upgrade:
1. `pnpm install` + `pnpm bundle` (peer ranges in `package.json` already cover
   `>=0.1.0-rc.6 <0.2.0`, so pnpm peer checks stay green through the 0.1.x rc line).
2. Boot a scratch profile (`DSH_HOME=<tmp> dsh web`) with the plugin installed and
   probe `/api/sidechat.start` + `/plugins/dsh-sidechat/client.js` (see below).
3. If a slot name or service seam moved, the fix is localized to `src/`.

### Quick smoke test on a scratch profile

```sh
mkdir -p /tmp/dsh-test/home /tmp/dsh-test/ws
cd /tmp/dsh-test/ws
DSH_HOME=/tmp/dsh-test/home <runtime-node> <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 19321
# then in another shell:
DSH_HOME=/tmp/dsh-test/home <runtime-node> <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add /abs/path/plugins/dsh-sidechat
# restart the test instance, then:
curl -X POST http://127.0.0.1:19321/api/sidechat.start -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"smoke","method":"sidechat.start","payload":{"sessionId":"x"}}'
# expect {"result":{"ok":false,"error":{"code":"sidechat-error","message":"session \"x\" not found"}}}
curl -s http://127.0.0.1:19321/ | grep -o 'dsh-sidechat/client.js?rev=[a-f0-9]*'
```

## Design

- Fork: `sidechat.start` delegates to the official `session.fork` path (boundary at
  the latest completed turn; never inside an open turn; source session unaffected).
- Boundary: the child log gets a `user/message` with
  `source: {kind:"plugin", plugin:"side-chat", form:"boundary", parentId}` — inherited
  history is reference-only for the child agent, and the side chat defaults to
  non-mutating exploration with sub-agents off-limits.
- Marker: a `sidechat` session projection (registered by the node half) makes every
  client summary carry `projectionValues.sidechat = {parentId}` — no DSH header
  schema change (header `origin` is a closed union).
- Status: the client half reads the parent's live `running` / `pendingInteraction`
  from the shared sessions list (host/session-status + mux frames push it for every
  session, open or not).
- Progress: the `sidechat_check_parent` model tool lets the side-chat agent pull the
  parent's live surface on demand.

## Verified (isolated engine, port 19321, scratch DSH_HOME)

- Plugin boots inside the web profile without errors; `lib/client.js` is served at
  `/plugins/dsh-sidechat/client.js` and listed in the `window.__DSH_BOOT__` roster
  with the declared `inject` edges.
- Client bundle executes in a mock window and exports `apply` / `inject` per the
  module contract.
- `/api/sidechat.start` full wire path: envelope parse → trust fence (cross-site
  403) → fork → error mapping (session-not-found / no-completed-turn).
- **Full fork + boundary injection**: source session with a completed (error) turn →
  child created with `parentSessionId` lineage, full history copy ending at
  `session/end-seed`, then the boundary `user/message`
  (`source: {kind:"plugin", plugin:"side-chat", form:"boundary", parentId}`).
- Projection marker: child summary carries
  `projectionValues.sidechat = {parentId}`; ordinary sessions report `null`.
- HMR: rebuild → `/plugins/events` broadcasts `{type:"rebuilt", id, rev}` → manifest
  rev updates (no page refresh).

