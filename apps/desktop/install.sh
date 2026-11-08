#!/bin/sh
# Builds Voidmesh and installs it as ~/Applications/Voidmesh.app (Finder, Spotlight, the Dock),
# relaunching it if it's running. Uses Rune's own bundler from Cargo's checkout of the pinned
# Rune revision, so it always matches the Rune this app builds against.
set -eu
cd "$(dirname "$0")"
cargo build --release
rune_manifest=$(cargo metadata --format-version 1 | python3 -c '
import json, sys
print(next(p["manifest_path"] for p in json.load(sys.stdin)["packages"] if p["name"] == "rune"))')
rune_root=$(dirname "$(dirname "$(dirname "$rune_manifest")")")
"$rune_root/scripts/mac-app" --name Voidmesh --id dev.voidmesh.desktop --exe voidmesh \
  --bin target/release/voidmesh --icon assets/Voidmesh.icns "$@"
