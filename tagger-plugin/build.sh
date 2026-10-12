#!/usr/bin/env bash
# Builds the Navidrome plugin package, dist/aonsoku-bs-tagger.ndp (a zip of
# manifest.json and plugin.wasm).
#
# The plugin may only connect to the hosts its manifest names, so the
# Aonsoku-BS server's host is built in:
#   TAGGER_SYNC_HOST    the server's host name (default mus.bsums.xyz)
#   TAGGER_EXTRA_HOSTS  more allowed WebSocket hosts, comma-separated: an IP
#                       or CIDR is needed for a server on a private network
#                       (e.g. the local test bed uses '*')
set -euo pipefail
cd "$(dirname "$0")"

SYNC_HOST=${TAGGER_SYNC_HOST:-mus.bsums.xyz}
EXTRA_HOSTS=${TAGGER_EXTRA_HOSTS:-}
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)

cargo build --release --target wasm32-wasip1

rm -rf dist/package
mkdir -p dist/package
cp target/wasm32-wasip1/release/aonsoku_bs_tagger.wasm dist/package/plugin.wasm
python3 - "$SYNC_HOST" "$EXTRA_HOSTS" "$VERSION" <<'EOF'
import json, sys
host, extra, version = sys.argv[1:4]
text = open('manifest.template.json').read()
manifest = json.loads(text.replace('@SYNC_HOST@', host).replace('@VERSION@', version))
hosts = manifest['permissions']['websocket']['requiredHosts']
hosts += [h.strip() for h in extra.split(',') if h.strip()]
json.dump(manifest, open('dist/package/manifest.json', 'w'), indent=2, ensure_ascii=False)
EOF
rm -f dist/aonsoku-bs-tagger.ndp
(cd dist/package && zip -q -X ../aonsoku-bs-tagger.ndp manifest.json plugin.wasm)
echo "Built dist/aonsoku-bs-tagger.ndp ($VERSION, connects to $SYNC_HOST${EXTRA_HOSTS:+, $EXTRA_HOSTS})"
