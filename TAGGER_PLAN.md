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
| Helper HTTP API under /api/tagger | The **sync server** serves /jam-sync/tagger (already proxied by nginx) and passes write jobs to the plugin over a WebSocket the plugin opens | Plugins can't receive requests |
| Browser reads tags with taglib-wasm | Not used | The dialog prefills from Subsonic data, and the plugin does all reading and writing |
| Song path from getSong | Navidrome's Matcher service (0.63+) gives library id + real relative path | getSong reports a made-up path |
| startScan from the helper | The plugin asks for a scan of the changed folder (as an admin user), if the file watcher hasn't already picked the change up | |

## Parts

1. **Plugin `aonsoku-bs-tagger`** (Rust, Navidrome's `nd-pdk`, wasm32-wasip1, `lofty` ≥ 0.25.4).
   - Permissions: library (filesystem, write access granted by the admin), matcher,
     websocket (requiredHosts: the sync server), subsonicapi + users (admin check,
     startScan), http (Navidrome's own getUser on 127.0.0.1, to check credentials),
     scheduler (reconnect), taskqueue (one file at a time), cache (link state, covers).
   - Settings (Navidrome's plugin settings form): sync server URL, shared secret, admin
     user for scans.
   - Opens `wss://<sync server>/jam-sync/tagger/plugin`, authenticates with the secret,
     and keeps the connection alive. A scheduler job reconnects it when it drops.
   - Each write job becomes a task (queue concurrency 1). The task resolves the song
     with Matcher, writes the tags with lofty, and sends the result back.
2. **Sync server** (jam-sync-server, Node):
   - `GET /jam-sync/tagger/capabilities`: enabled only while a plugin is connected.
   - `POST /jam-sync/tagger/write`: Subsonic credentials checked against Navidrome (ping,
     then getUser: admin only). Passes the batch to the plugin, waits for the results,
     and returns one result per song.
   - Lookup proxies with the spec's limits: MusicBrainz (1/s, 10-minute cache), Cover
     Art Archive (sizes 250/500/1200), AcoustID (3/s, key from the environment). Only
     these hosts are allowed.
   - Covers to write (up to 15 MB) go to the plugin in the write message, once per batch.
   - Env: `TAGGER_PLUGIN_SECRET` (the feature is off when unset), `ACOUSTID_API_KEY`,
     `TAGGER_USER_AGENT`.
3. **App** (shared web UI, so web, desktop, Android and iOS all get it):
   - Checks capabilities at start. Nothing new shows unless the plugin is connected and
     the user is an admin.
   - "Edit tags" on songs and albums opens a dialog. Single and batch mode, "multiple
     values" for fields that differ, changed fields highlighted with a reset each, and
     only edited fields sent.
   - MusicBrainz lookup with track mapping, a cover picker, and fingerprint Identify
     (Chromaprint WASM in a worker).
   - Caches refresh after a write.

## Who can edit

No separate sign-in: the tagger uses the Subsonic credentials the app already signed in
with (user + token and salt, or password, as the app does), on every platform. Only
Navidrome admins can edit, and that is checked three times:

1. The app shows "Edit tags" only when the signed-in user is an admin (`getUser` →
   `adminRole`) and the plugin is connected.
2. The sync server checks each write's credentials against Navidrome (`ping`) and the
   admin role (`getUser`). Not an admin: 403.
3. The plugin checks again before touching a file: it sends the same credentials to
   Navidrome's own `getUser` over 127.0.0.1 (inside the NAS container), which checks the
   sign-in and the admin role at once. So the shared secret only protects the link
   between the sync server and the plugin; without a real admin's credentials nothing is
   written, even if the secret leaks.

Removing a user's admin flag in Navidrome locks them out at the next edit.

## Writing a file safely in a plugin

- Files are written in place, so they keep their owner, mode and Synology ACLs (a WASI
  plugin can't set those on a replacement file, so the spec's temp-file-and-rename is not
  used). A safety copy is made first; if the write or reading it back fails, the copy is
  put back. A copy left by a crash is put back before the file is touched again.
- Every plugin call is limited to 30 seconds, so each song is its own queued task. A
  148 MB FLAC given a 1200 px cover (a full rewrite plus the safety copy) took ~0.5 s on
  the test machine; time it on the DS420j's HDD in phase 11, and only make big rewrites
  resumable across task runs if it comes near the limit.
- Every path is checked against the library mount. Symlinks are refused.
- Each write is logged: user, song, fields changed, result.

## Covers

- A cover (JPEG or PNG, up to 15 MB, checked by its first bytes) replaces the songs'
  embedded front cover (in MP4, all its pictures, which have no type).
- Per edit, the user chooses whether the folder's cover image is replaced too ("Also
  replace the folder's cover image", on by default): Navidrome shows a folder image
  (cover.*, folder.*, front.*) before embedded art. The one Navidrome picks is
  overwritten in place; a different kind (folder.png for a JPEG) is replaced by the same
  name with the right extension; with none, cover.jpg is created.
- Identical covers in a batch go to the plugin once; it keeps them in its cache for the
  batch's tasks.

## Fingerprints

- "Identify by sound" (one song at a time) streams the song from Navidrome as a 128 kbps
  MP3, reads about two minutes, decodes it with an OfflineAudioContext (nothing plays), and
  computes the Chromaprint fingerprint in a Web Worker with `@unimusic/chromaprint`
  (Chromaprint itself compiled to WebAssembly; its .wasm is a separate file, LGPL). On the
  same audio it gives exactly the fingerprint ffmpeg's Chromaprint (= fpcalc) gives, so
  the spec's fallback to a Rust port or fpcalc wasn't needed.
- The server asks AcoustID (key in ACOUSTID_API_KEY, 3 requests a second, cached) and the
  editor lists the matched recordings' releases; the chosen release maps the song by its
  recording id.

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
