#!/bin/bash
# install-profile.sh — link dsh-sidechat into the Octopus Workbench web profile and
# register it as a profile bundle. Prefer the native flow instead:
#   dsh plugin --profile web add /abs/path/to/plugins/dsh-sidechat
# (pnpm-managed dependency + automatic bundles registration; removal is
#  `dsh plugin --profile web remove dsh-sidechat`).
#
# Usage: ./scripts/install-profile.sh [profile-dir]
# Default profile: $DSH_HOME/profiles/web (DSH_HOME defaults to the app's data dir).
#
# After this script succeeds, restart the Engine (relaunch Octopus Workbench or
# stop/start the Engine) for the server half to load. Client-bundle rebuilds are
# picked up by the running client-plugin HMR receiver without a page refresh.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-}"
if [[ -z "$PROFILE" ]]; then
  DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/Octopus Workbench/dsh}"
  PROFILE="$DSH_HOME/profiles/web"
fi

[[ -f "$PROFILE/package.json" ]] || { echo "profile not found: $PROFILE" >&2; exit 1; }
[[ -f "$PKG_DIR/lib/index.js" ]] || { echo "lib/index.js missing — run \`pnpm bundle\` first" >&2; exit 1; }

mkdir -p "$PROFILE/node_modules"
ln -sfn "$PKG_DIR" "$PROFILE/node_modules/dsh-sidechat"
echo "linked  $PROFILE/node_modules/dsh-sidechat -> $PKG_DIR"

node -e '
const fs = require("fs");
const [p] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
const bundles = pkg.dsh?.profile?.bundles ?? [];
if (!bundles.includes("dsh-sidechat")) {
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = [...bundles, "dsh-sidechat"];
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  console.log("added  dsh-sidechat to dsh.profile.bundles in", p);
} else {
  console.log("ok     dsh-sidechat already in dsh.profile.bundles");
}
' "$PROFILE/package.json"

echo "done — restart the Engine to load dsh-sidechat (server half); client half hot-reloads."
