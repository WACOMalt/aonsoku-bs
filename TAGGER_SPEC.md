# Aonsoku Tagger: Implementation Spec

Status: ready for implementation. Last updated: 2026-10-12.
Audience: a code agent that works in the user's Aonsoku port.

## 1. Goal

Add an audio tag editor to the Aonsoku port (React and TypeScript web client for Navidrome and Subsonic servers).

Required features:

1. Edit tag fields: title, artist, album artist, album, track number, disc number, year, genre.
2. Look up album art and replace the cover art in the file.
3. Look up metadata on MusicBrainz and apply it to the selected songs.
4. Identify a song by audio fingerprint (Chromaprint and AcoustID), like MusicBrainz Picard.

The write feature is optional. The user turns it on with an environment variable in the container. When it is off, the app must behave as it does today.

## 2. Fixed facts (from research)

- Navidrome does not write to the music folder. The maintainer has said there are no plans to add tag editing.
- The Subsonic API cannot write tags or upload files.
- Navidrome plugins cannot help. Plugin file access is read-only. Plugins cannot open ports. No plugin hook adds a custom route.
- No existing open-source project gives an embeddable Picard-style tagger for a React app. Build it from parts.
- The browser can read, edit, and preview tags. A server-side helper must save the files.

## 3. Decisions

| Area | Decision |
|---|---|
| Browser tag library | `taglib-wasm` (TagLib in WebAssembly). It reads and writes MP3, FLAC, M4A, OGG, Opus, WAV, AIFF, and cover art. |
| Server tag library | Go with `go-taglib` (github.com/sentriz/go-taglib). Single static binary. |
| Metadata lookup | MusicBrainz web service v2. |
| Cover art lookup | Cover Art Archive (CAA). |
| Fingerprint | `rusty-chromaprint-wasm` in the browser. Fallback: `@unimusic/chromaprint`. |
| Fingerprint lookup | AcoustID API, through the helper proxy. |
| Write path | Optional helper process. It runs in the same container as the frontend. |
| Rescan | Helper calls Subsonic `startScan` after each write batch. |

Rejected options:

- `ffmpeg.wasm` for tagging. The core is about 32 to 40 MB. Too large.
- `jsmediatags`. Last release in April 2021. Read-only.
- `music-metadata-browser`. Archived in August 2024. Read-only.
- `browser-id3-writer`. MP3 only. It removes the existing ID3 tag on write.
- A Navidrome plugin for writes. Not possible (see section 2).
- A Navidrome fork. High maintenance cost.

## 4. Architecture

```
Browser (Aonsoku port)
  |-- taglib-wasm (Web Worker): read tags, preview edits
  |-- MusicBrainz and CAA lookups (through helper proxy)
  |-- rusty-chromaprint-wasm: fingerprint
  |
  v   /api/tagger/*
Reverse proxy (nginx or the existing web server)
  |
  v
Tagger helper (Go, optional, TAGGER_ENABLED=true)
  |-- auth: validate Subsonic credentials against Navidrome
  |-- resolve file path from song id
  |-- write tags and cover art (go-taglib), atomic replace
  |-- proxy: AcoustID, MusicBrainz, CAA
  |-- call Subsonic startScan
  |
  v
Music folder (read-write mount, only when the helper is on)
```

## 5. Environment variables (helper)

| Name | Default | Meaning |
|---|---|---|
| `TAGGER_ENABLED` | `false` | When not `true`, the helper does not start and the UI hides all edit controls. |
| `TAGGER_MUSIC_DIR` | `/music` | Root of the music library inside the container. The helper refuses any path outside it. |
| `NAVIDROME_URL` | none (required) | Internal URL of Navidrome, for example `http://navidrome:4533`. |
| `TAGGER_REQUIRE_ADMIN` | `true` | Only Navidrome admin users can write. |
| `TAGGER_BACKUP_DIR` | empty | If set, copy the original file here before each write. |
| `TAGGER_LISTEN` | `127.0.0.1:8090` | Helper listen address. The reverse proxy forwards to it. |
| `ACOUSTID_API_KEY` | empty | If empty, the fingerprint feature is hidden. |
| `TAGGER_USER_AGENT` | `AonsokuTagger/<version> (contact)` | Sent to MusicBrainz and CAA. MusicBrainz requires an identifying User-Agent. |

Note: the music mount must be read-write for the helper. The user chooses this in the compose file. Document it in the README.

## 6. Helper HTTP API

All routes are under `/api/tagger`. All routes except `capabilities` need Subsonic credentials (see section 7).

### 6.1 `GET /capabilities`

No auth. Returns what the UI needs to decide what to show.

```json
{
  "enabled": true,
  "version": "0.1.0",
  "features": { "write": true, "fingerprint": true, "lookup": true },
  "formats": ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff"]
}
```

If the helper is off, the proxy returns 404 or a connection error. The frontend treats any failure as `enabled: false`.

### 6.2 `POST /write`

Request body:

```json
{
  "items": [
    {
      "songId": "abc123",
      "tags": {
        "title": "Song",
        "artist": "Artist",
        "albumArtist": "Album Artist",
        "album": "Album",
        "trackNumber": "3/12",
        "discNumber": "1/2",
        "year": "2021",
        "genre": "Rock"
      },
      "cover": { "mimeType": "image/jpeg", "dataBase64": "..." }
    }
  ]
}
```

Rules:

- Only fields that are present in `tags` change. A missing field means "do not touch". An empty string means "clear the field".
- Keep values such as `3/12` exactly as given.
- `cover` is optional. If present, replace the front cover.
- Max 500 items for each request. Max 15 MB for each cover image.

Response: one result for each item. A failure on one item must not stop the other items.

```json
{
  "results": [
    { "songId": "abc123", "ok": true },
    { "songId": "def456", "ok": false, "error": "FILE_NOT_FOUND" }
  ],
  "scanTriggered": true
}
```

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `FILE_NOT_FOUND`, `PATH_OUTSIDE_ROOT`, `UNSUPPORTED_FORMAT`, `WRITE_FAILED`, `VALIDATION_FAILED`.

### 6.3 Proxy routes

- `POST /acoustid/lookup`: body `{ "fingerprint": "...", "duration": 215 }`. The helper adds the API key and calls `https://api.acoustid.org/v2/lookup` with `meta=recordings+releasegroups+compress`. Limit: 3 requests per second for the whole helper.
- `GET /musicbrainz/*`: forward to `https://musicbrainz.org/ws/2/*`. Add the User-Agent. Force `fmt=json`. Limit: 1 request per second for the whole helper. Cache GET results in memory for 10 minutes.
- `GET /coverart/release/{mbid}?size=500`: fetch from CAA (`/release/{mbid}/front-{size}`). Follow redirects. Return the image bytes. Allowed sizes: 250, 500, 1200.

Allow only these upstream hosts: `acoustid.org`, `musicbrainz.org`, `coverartarchive.org`, `archive.org` (and its subdomains, for CAA redirects). Refuse all other targets.

Note: AcoustID usage is non-commercial only. Mention this in the README.

## 7. Auth and safety (helper)

1. The browser sends the same Subsonic credentials it uses with Navidrome (token and salt, as the existing app does). The helper forwards them to Navidrome `ping`. If `ping` fails, return 401.
2. If `TAGGER_REQUIRE_ADMIN` is `true`, call `getUser` for that user and check `adminRole`. If false, return 403.
3. The browser never sends a file path. The helper gets the path from the song id (see section 12, question 1). The helper resolves symlinks. If the real path is outside `TAGGER_MUSIC_DIR`, return `PATH_OUTSIDE_ROOT`.
4. Write each file safely:
   1. Take a per-file lock.
   2. If `TAGGER_BACKUP_DIR` is set, copy the original file there.
   3. Copy the file to a temp file in the same folder.
   4. Write tags to the temp file.
   5. Call `fsync` on the temp file.
   6. Keep the file mode and owner of the original.
   7. Rename the temp file over the original.
   8. Release the lock.
5. If any step fails, delete the temp file and leave the original unchanged.
6. After a batch with at least one success, call Subsonic `startScan` one time.
7. Log each write: user, song id, fields changed, result. Never log credentials or fingerprints.
8. Bind to `127.0.0.1` by default. The reverse proxy is the only public path.

## 8. Frontend work

Do these steps in this order.

1. Add a capability check on app start. Call `GET /api/tagger/capabilities`. Store the result in a small store (use the state library the port already uses). On any failure, set `enabled: false`.
2. If `enabled` is false, render nothing new. No buttons, no menu items.
3. Add an "Edit tags" item to the song and album context menus. Show it only for admin users when `features.write` is true.
4. Build the tag editor dialog:
   - Single mode: one song, all fields.
   - Batch mode: many songs. Show a field as "multiple values" when the songs differ. Only fields the user edits are sent.
   - Prefill from the data the app already has (Subsonic `getSong` and `getAlbum`). Do not download the file just to open the dialog.
   - Highlight changed fields. Add a "Reset" action for each field.
5. Add the lookup panel:
   - Search MusicBrainz by album and artist (through `/api/tagger/musicbrainz`).
   - The user picks a release. Map release tracks to selected songs by track number, then by title. Show the mapping so the user can fix it.
   - Show cover art choices from CAA (sizes 250 and 500 for the picker, 1200 for the final file).
6. Add the "Identify" action (only when `features.fingerprint` is true):
   1. Fetch the song audio with the Subsonic `download` endpoint.
   2. Decode with the Web Audio API `decodeAudioData`. Use the first 120 seconds.
   3. Compute the fingerprint in a Web Worker with `rusty-chromaprint-wasm`.
   4. Send `fingerprint` and the full `duration` to `/api/tagger/acoustid/lookup`.
   5. Show the best matches with a score. The user picks one.
7. Load `taglib-wasm` and the fingerprint module with dynamic `import()` inside Web Workers. They must not enter the main bundle.
8. Serve the `.wasm` files as separate files. Do not inline them. (The `taglib-wasm` binaries are LGPL-2.1-or-later. A separate file lets users swap the library.)
9. Use `taglib-wasm` only for reading and previews in the browser. The helper does the real write.
10. After a successful write, show a message and refresh the affected albums and songs in the app cache.
11. Add i18n strings for every new label. Use the port's existing i18n system.

Browser limit: `taglib-wasm` in the browser reads the full file into memory. Do not read files over 200 MB in the browser. For those files, edit through the helper only.

## 9. Packaging

- Build the helper as a static Go binary.
- Add it to the existing container image. Start it only when `TAGGER_ENABLED=true` (for example, in the entrypoint script).
- Add a reverse-proxy rule for `/api/tagger/` that forwards to `TAGGER_LISTEN`. If the helper is off, the proxy must return 404 (not 502) so the frontend can detect it.
- Update the example compose file with a commented option for the read-write music mount and the new environment variables.
- Update the README with: what the feature does, how to enable it, the read-write mount warning, the AcoustID non-commercial note, and the backup option.

## 10. Implementation order

1. Inspect the repo (see section 12). Report the stack, the state library, the i18n system, the web server, and the Dockerfile.
2. Helper skeleton: config, `GET /capabilities`, auth middleware (`ping` and admin check). Add unit tests.
3. Helper path resolution and the safe write routine. Add tests with temp folders (symlink escape, missing file, read-only file).
4. Helper `POST /write` for tags only. Test with sample MP3, FLAC, and M4A files.
5. Helper cover art write.
6. Helper `startScan` call.
7. Helper proxy routes with rate limits and the host allowlist.
8. Packaging: image, entrypoint, proxy rule, compose, README.
9. Frontend: capability store and gated menu item.
10. Frontend: tag editor dialog (single, then batch).
11. Frontend: MusicBrainz lookup panel and cover art picker.
12. Frontend: fingerprint "Identify" action.
13. End-to-end test against a real Navidrome instance.

Make one commit for each numbered step. Stop after step 4 and show the result before you continue, because steps 5 to 13 depend on it.

## 11. Tests

Helper:

- Round trip on MP3, FLAC, M4A, and Ogg: write tags, read them back, and compare. Include `3/12` style values, non-ASCII text, and an empty string (clear).
- Check that the audio data does not change (compare an audio-only hash before and after, where the format allows it).
- Path safety: `..`, symlink to outside, absolute path in input. All must fail.
- Failure in the middle of a write leaves the original unchanged.
- Rate limit: more than 3 AcoustID requests in one second must queue or fail with 429.
- Non-admin user gets 403 when `TAGGER_REQUIRE_ADMIN=true`.

Frontend:

- With the helper off, no new UI appears.
- Batch mode sends only the edited fields.
- A failed item shows an error and does not block the other items.

Compatibility check for the fingerprint module: take about 20 songs. Compute the fingerprint with `rusty-chromaprint-wasm` and with `fpcalc`. Compare the AcoustID lookup results. If matches differ in a meaningful way, switch to `@unimusic/chromaprint`, or run `fpcalc` in the helper.

## 12. Open questions (check these first)

1. **Song path:** What does Navidrome return for a song path in `getSong`, and does it work with more than one library? Check on a real server. If the path is relative to the library root, the helper needs the library root mapping. Add an env var for it if needed.
2. **Repo layout:** Where is the web server config and the Dockerfile in the port? Is the web image only a static file server? The helper design assumes the container can run a second process.
3. **Auth details:** Which Subsonic auth method does the port use (token and salt, or password)? The helper must accept the same method.
4. **AcoustID CORS:** Not confirmed. The design uses a proxy, so it is not blocking. Do not call AcoustID directly from the browser.
5. **`taglib-wasm` version and license:** Sources disagree on the version (v1.4.3, v2.3.1, and v2.4.0 were all seen). The repo and JSR say MIT (TypeScript) and LGPL-2.1-or-later (Wasm). One aggregator says GPL-3.0. Pin an exact version. Read the license file in the repo before you ship.
6. **Electron build:** The port may also ship as an Electron app. For this task, build the web path only. Do not add Electron-specific code.
7. **Local library mode:** The File System Access API (Chromium only) can edit a local folder without the helper. This is out of scope for now. Do not build it.

## 13. Out of scope

- Writing tags without the helper.
- Automatic bulk tagging of the whole library (like `wrtag` or `tagbrain`).
- Renaming or moving files on disk.
- ReplayGain, lyrics editing, and chapter editing.
- A Navidrome plugin or a Navidrome fork.

## 14. References

- Navidrome FAQ (read-only by design): https://www.navidrome.org/docs/faq/
- Navidrome tag editing decision: https://github.com/navidrome/navidrome/discussions/3103
- Navidrome plugin system: https://github.com/navidrome/navidrome/blob/master/plugins/README.md
- `taglib-wasm`: https://github.com/CharlesWiltgen/taglib-wasm and https://jsr.io/@charlesw/taglib-wasm
- `go-taglib`: https://github.com/sentriz/go-taglib
- `rusty-chromaprint-wasm` demo: https://rusty-chromaprint-wasm.janis.me/
- `@unimusic/chromaprint`: https://www.jsdelivr.com/package/npm/@unimusic/chromaprint
- AcoustID web service: https://acoustid.org/webservice
- Cover Art Archive API: https://musicbrainz.org/doc/Cover_Art_Archive/API
- Aonsoku: https://github.com/victoralvesf/aonsoku
- Feishin tag editing request (similar design): https://github.com/jeffvli/feishin/issues/1958
- Existing web taggers for reference only: tunewright (krabhi4/tunewright), Tagwerk (dooziedan/tagwerk), music-tag-web (xhongc/music-tag-web)
