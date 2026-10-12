#!/usr/bin/env bash
# Local test bed for the tagger: a Navidrome in Podman with a small generated
# library covering every format the plugin writes.
#
#   testbed.sh library   (re)create the sample library
#   testbed.sh start     start Navidrome on http://localhost:4533
#   testbed.sh stop      stop and remove the container
#   testbed.sh logs      follow Navidrome's log
#   testbed.sh sync      (re)start the sync server from this checkout on :7548
#   testbed.sh plugin    build the plugin for the test bed, install and enable it
#   testbed.sh api …     call Navidrome's native API as the admin (ndadmin.py)
#
# Everything lives in $TESTBED (default ~/aonsoku-tagger-testbed): music/,
# data/ (Navidrome's database, plugins/), admin.env (the test admin's and a
# non-admin "guest"'s credentials), sync.env (the plugin secret) and
# sync.log.
set -euo pipefail

TESTBED=${TESTBED:-$HOME/aonsoku-tagger-testbed}
IMAGE=${IMAGE:-docker.io/deluan/navidrome:0.64.2}
NAME=aonsoku-tagger-navidrome
PORT=${PORT:-4533}

library() {
  local music=$TESTBED/music
  rm -rf "$music"
  mkdir -p "$music"
  local cover=$TESTBED/cover.png
  ffmpeg -loglevel error -y -f lavfi -i "color=c=teal:s=300x300" -frames:v 1 "$cover"

  # make <dir> <file> <ext> <title> <track> <disc> [extra ffmpeg args...]
  make() {
    local dir=$music/$1 file=$2 ext=$3 title=$4 track=$5 disc=$6
    shift 6
    mkdir -p "$dir"
    ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=8" "$@" \
      -metadata title="$title" -metadata artist="Test Artist" \
      -metadata album_artist="Test Artist" -metadata album="${dir##*/}" \
      -metadata track="$track" -metadata disc="$disc" -metadata date=2020 \
      -metadata genre=Rock "$dir/$file.$ext"
  }

  make "Test Artist/Formats" "01 - MP3 song" mp3 "MP3 song" 1/5 1/1 -c:a libmp3lame
  make "Test Artist/Formats" "02 - FLAC song" flac "FLAC song" 2/5 1/1 -c:a flac
  make "Test Artist/Formats" "03 - M4A song" m4a "M4A song" 3/5 1/1 -c:a aac
  make "Test Artist/Formats" "04 - Ogg song" ogg "Ogg song" 4/5 1/1 -c:a libvorbis
  make "Test Artist/Formats" "05 - Opus song" opus "Opus song" 5/5 1/1 -c:a libopus
  # Non-ASCII text, and an embedded cover in a FLAC.
  make "Test Artist/Ünïcödé Älbum" "01 - Café Ñandú 東京" flac "Café Ñandú 東京" 3/12 2/2 -c:a flac
  ffmpeg -loglevel error -y -i "$music/Test Artist/Ünïcödé Älbum/01 - Café Ñandú 東京.flac" \
    -i "$cover" -map 0:a -map 1:v -c copy -disposition:v attached_pic \
    "$music/Test Artist/Ünïcödé Älbum/02 - With cover.flac"
  echo "Library: $(find "$music" -type f | wc -l) files in $music"
}

start() {
  mkdir -p "$TESTBED/data" "$TESTBED/music"
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  podman run -d --name "$NAME" -p "127.0.0.1:$PORT:4533" \
    -e ND_LOGLEVEL=debug -e ND_SCANNER_SCHEDULE=0 \
    -e ND_PLUGINS_ENABLED=true -e ND_PLUGINS_AUTORELOAD=true \
    -v "$TESTBED/music:/music:Z" -v "$TESTBED/data:/data:Z" \
    --userns=keep-id --user "$(id -u):$(id -g)" \
    "$IMAGE" >/dev/null
  until curl -sf "http://localhost:$PORT/ping" >/dev/null; do sleep 1; done

  # A new database needs its first admin.
  if [ ! -f "$TESTBED/admin.env" ]; then
    local pass
    pass=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
    curl -sf -X POST -H 'Content-Type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$pass\"}" \
      "http://localhost:$PORT/auth/createAdmin" >/dev/null
    printf 'TESTBED_USER=admin\nTESTBED_PASS=%s\n' "$pass" > "$TESTBED/admin.env"
    chmod 600 "$TESTBED/admin.env"
  fi
  echo "Navidrome on http://localhost:$PORT (admin credentials in $TESTBED/admin.env)"
}

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

secret() {
  if [ ! -f "$TESTBED/sync.env" ]; then
    printf 'TAGGER_PLUGIN_SECRET=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > "$TESTBED/sync.env"
    chmod 600 "$TESTBED/sync.env"
  fi
  sed -n 's/^TAGGER_PLUGIN_SECRET=//p' "$TESTBED/sync.env"
}

sync_server() {
  local pidfile=$TESTBED/sync.pid
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")"
    sleep 1
  fi
  mkdir -p "$TESTBED/sync-data"
  (cd "$REPO/jam-sync-server" && [ -d node_modules ] || npm install --no-audit --no-fund --silent)
  cd "$REPO/jam-sync-server"
  TAGGER_PLUGIN_SECRET=$(secret) NAVIDROME_URL=http://127.0.0.1:$PORT \
    SYNC_DATA_DIR=$TESTBED/sync-data nohup node index.js > "$TESTBED/sync.log" 2>&1 &
  echo $! > "$pidfile"
  echo "Sync server on :7548 (log: $TESTBED/sync.log)"
}

plugin() {
  (cd "$REPO/tagger-plugin" && TAGGER_SYNC_HOST=host.containers.internal TAGGER_EXTRA_HOSTS='*' ./build.sh)
  mkdir -p "$TESTBED/data/plugins"
  cp "$REPO/tagger-plugin/dist/aonsoku-bs-tagger.ndp" "$TESTBED/data/plugins/"
  # Navidrome unloads a changed plugin and leaves it disabled.
  sleep 4
  local config
  config=$(python3 -c "import json,sys; print(json.dumps(json.dumps({'syncServerUrl':'http://host.containers.internal:7548','secret':sys.argv[1],'scanUser':'admin'})))" "$(secret)")
  "$HERE/ndadmin.py" PUT /api/plugin/aonsoku-bs-tagger \
    "{\"config\": $config, \"allUsers\": true, \"allLibraries\": true, \"allowWriteAccess\": true}" >/dev/null
  "$HERE/ndadmin.py" PUT /api/plugin/aonsoku-bs-tagger '{"enabled": true}' | grep -o '"enabled": [a-z]*\|"lastError": "[^"]*"'
}

case "${1:-}" in
  library) library ;;
  start) start ;;
  stop) podman rm -f "$NAME" >/dev/null && echo stopped ;;
  logs) podman logs -f "$NAME" ;;
  sync) sync_server ;;
  plugin) plugin ;;
  api) shift; "$HERE/ndadmin.py" "$@" ;;
  *) echo "usage: $0 library|start|stop|logs|sync|plugin|api" >&2; exit 1 ;;
esac
