# Aonsoku-BS Tagger: plan

Based on TAGGER_SPEC.md, changed for this fork and the user's setup. Where the two
disagree, this plan wins.

## Setup it is built for

- Navidrome runs in Docker (Synology Container Manager) on a DS420j: ARM64, 1 GB RAM,
  HDD. Its music is only reachable on that NAS.
- The Aonsoku-BS container (web app + Node sync server) runs on another machine
  (mus.bsums.xyz).
- Navidrome is upgraded to the latest release (0.64.2 today). The plugin requires 0.64+.

## Changes from the spec

| Spec | This plan | Why |
|---|---|---|
| Go helper in the web container writes the files | A **Navidrome plugin** writes them, on the NAS | The music is on another machine |
| Spec 2: plugins are read-only and can't help | Plugins can write library files once an admin turns on "Allow write access" (0.61+) | Checked in Navidrome's source |
| Helper HTTP API under /api/tagger | The **sync server** serves /api/tagger and passes write jobs to the plugin over a WebSocket the plugin opens | Plugins can't receive requests |
| Browser reads tags with taglib-wasm | Not used | The dialog prefills from Subsonic data, and the plugin does all reading and writing |
| Song path from getSong | Navidrome's Matcher service (0.63+) gives library id + real relative path | getSong reports a made-up path |
| startScan from the helper | The plugin asks for a scan of the changed folder (as an admin user), if the file watcher hasn't already picked the change up | |

## Parts

1. **Plugin `aonsoku-bs-tagger`** (Rust, Navidrome's `nd-pdk`, wasm32-wasip1, `lofty` ≥ 0.25.4).
   - Permissions: library (filesystem, write access granted by the admin), matcher,
     websocket (requiredHosts: the sync server), subsonicapi + users (for startScan),
     scheduler (reconnect), taskqueue (one file at a time), http (cover image download).
   - Settings (Navidrome's plugin settings form): sync server URL, shared secret, admin
     user for scans.
   - Opens `wss://<sync server>/tagger-plugin`, authenticates with the secret, and keeps
     the connection alive. A scheduler job reconnects it when it drops.
   - Each write job becomes a task (queue concurrency 1). The task resolves the song
     with Matcher, writes the tags with lofty, and sends the result back.
2. **Sync server** (jam-sync-server, Node):
   - `GET /api/tagger/capabilities`: enabled only while a plugin is connected.
   - `POST /api/tagger/write`: Subsonic credentials checked against Navidrome (ping,
     then getUser: admin only). Splits the batch into jobs for the plugin, waits for
     the results, and returns one result per song.
   - Lookup proxies with the spec's limits: MusicBrainz (1/s, 10-minute cache), Cover
     Art Archive (sizes 250/500/1200), AcoustID (3/s, key from the environment). Only
     these hosts are allowed.
   - Cover images to write are held briefly at a one-time URL the plugin downloads
     (plugin HTTP responses are capped at 10 MB, so covers are capped at 10 MB).
   - Env: `TAGGER_PLUGIN_SECRET` (the feature is off when unset), `ACOUSTID_API_KEY`,
     `TAGGER_USER_AGENT`.
3. **App** (shared web UI, so web, desktop, Android and iOS all get it):
   - Checks capabilities at start. Nothing new shows unless the plugin is connected and
     the user is an admin.
   - "Edit tags" on songs and albums opens a dialog. Single and batch mode, "multiple
     values" for fields that differ, changed fields highlighted with a reset each, and
     only edited fields sent.
   - MusicBrainz lookup with track mapping, a cover picker, and fingerprint Identify
     (chromaprint WASM in a worker, in the last phase).
   - Caches refresh after a write.

## Writing a file safely in a plugin

- Every plugin call is limited to 30 seconds. A lofty write that fits in the existing tag
  space (padding) is done in place and is instant.
- A write that needs a full rewrite (e.g. a bigger cover) goes to a temp file in the same
  folder, then fsync, then rename over the original. If one call can't finish the copy, it
  continues across several queued task runs, resumable, and the original stays untouched
  until the rename.
- Every path is checked against the library mount. Symlinks are refused.
- Optional backup copy before a write (plugin setting: a folder inside the library).
- Each write is logged: user, song, fields changed, result.

## Testing

- Local test bed: Navidrome 0.64.2 in Podman with a generated sample library (MP3, FLAC,
  M4A, Ogg, Opus; non-ASCII, `3/12` track numbers), plus the local sync server.
- Rust unit tests run natively on sample files: round trips, clearing a field, audio data
  unchanged, path escapes refused, interrupted rewrite leaves the original.
- Node tests for the sync server: auth, admin check, the batch with one failed item,
  rate limits.

## Phases (one commit or more each)

1. Local test bed (Navidrome 0.64.2, sample library, sync server).
2. Plugin skeleton: manifest, settings, WebSocket connect/auth/reconnect.
3. Sync server: plugin socket, capabilities, write route with auth.
4. Plugin: resolve and write tags (no cover), scan.
   **Stop here and show an end-to-end tag edit on the local Navidrome.**
5. Cover art write (staging URL, resumable rewrite).
6. Lookup proxies (MusicBrainz, CAA).
7. App: capability gate and "Edit tags" dialog (single, then batch).
8. App: MusicBrainz lookup and cover picker.
9. Fingerprint Identify (AcoustID key needed then).
10. Packaging: the `.ndp` built in CI and attached to releases, compose env, README
    (write access, backups, AcoustID non-commercial note).
11. End-to-end on the NAS after the Navidrome upgrade.
