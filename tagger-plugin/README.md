# Tag editor

Navidrome admins can edit their music's tags from Aonsoku-BS: title, artist, album
artist, album, track, disc, year, genre and the cover. One song or many at once, with
MusicBrainz lookup, cover art from the Cover Art Archive, and "Identify by sound"
(AcoustID fingerprints). It works the same in the web app, desktop, Android and iOS.

Navidrome itself never writes to your music. This Navidrome plugin does, next to the
files, for edits made in Aonsoku-BS:

```
Aonsoku-BS app ──► Aonsoku-BS server (sync server) ◄── WebSocket ── plugin in Navidrome ──► music files
```

The plugin connects out to the Aonsoku-BS server (plugins can't receive requests) and
takes each batch of edits from it.

## Who can edit

Only Navidrome admins, with the sign-in the app already has. Everyone else doesn't see
"Edit tags", and the server and the plugin both refuse their edits. Removing someone's
admin flag in Navidrome locks them out at their next edit.

## Set it up

You need Navidrome **0.64** or later and an Aonsoku-BS server (the web container).

1. **Aonsoku-BS server.** Choose a long random secret, for example with
   `openssl rand -base64 24`, and set it in the container's environment (see
   `docker-compose.yml`), then rebuild:

   ```
   TAGGER_PLUGIN_SECRET=<the secret>
   ACOUSTID_API_KEY=<optional, for "Identify by sound">
   ```

2. **Navidrome's music folder must be writable.** In its container settings, remove
   `:ro` (or "read-only") from the music volume and restart Navidrome.

3. **Install the plugin.** Download `aonsoku-bs-tagger.ndp` from the latest release and
   copy it into the `plugins` folder inside Navidrome's data folder (the one with
   `navidrome.db`; create `plugins` if it's missing). Keep the file name: Navidrome
   uses it as the plugin's id, and an update must replace the same file.

4. **Enable it** in Navidrome under your user menu → **Plugins** → **Aonsoku-BS Tagger**:
   - **Aonsoku-BS server:** the address of your Aonsoku-BS web app, e.g.
     `https://mus.example.com`.
   - **Shared secret:** the same value as `TAGGER_PLUGIN_SECRET`.
   - **Admin user for rescans:** a Navidrome admin; edited folders are rescanned as them.
   - **Users:** the admins who edit (or all users; non-admins are refused anyway).
   - **Libraries:** your library, with **Allow write access** on.
   - Enable the plugin.

After an update of the `.ndp`, Navidrome disables the plugin until you enable it again.

"Edit tags" appears in Aonsoku-BS (song and album menus) within a few minutes, or when the
app window regains focus.

### Your own server

Release builds may only connect to `mus.bsums.xyz`. For another server, build the plugin
yourself (Rust, with `rustup target add wasm32-wasip1`):

```
TAGGER_SYNC_HOST=mus.example.com ./build.sh     # → dist/aonsoku-bs-tagger.ndp
```

A server on a private network also needs its IP: `TAGGER_EXTRA_HOSTS=192.168.1.20`. To
build releases for your host, set the repository variable `TAGGER_SYNC_HOST`.

## How files are written

- Tags are written with [lofty](https://github.com/Serial-ATA/lofty-rs): MP3, FLAC,
  M4A, Ogg, Opus, WAV and AIFF.
- The file is changed in place, so it keeps its owner, permissions and (on a Synology)
  its ACLs. Before each write a copy is made next to it
  (`.<name>.aonsoku-bs-tagger.bak`); if the write or reading it back fails, the copy is
  put back, and a copy left by a crash is put back before the file is touched again.
  There is no permanent backup: keep your own (e.g. Synology snapshots).
- A new cover replaces the songs' embedded front cover. "Also replace the folder's cover
  image" also replaces the folder image Navidrome shows (`cover.*`, `folder.*`,
  `front.*`), or creates `cover.jpg`.
- Edited folders are rescanned at the end of each batch.
- Navidrome gives a plugin 30 seconds per song. Very large files on a slow disk may need
  that time when a bigger cover forces the whole file to be rewritten.

## Lookups

- **MusicBrainz** and the **Cover Art Archive** are asked by the Aonsoku-BS server, at
  most one MusicBrainz request a second, as MusicBrainz asks. `TAGGER_USER_AGENT` sets how
  the server introduces itself.
- **Identify by sound** fingerprints the first two minutes of a song in the app with
  Chromaprint and asks [AcoustID](https://acoustid.org). It needs a free key from
  <https://acoustid.org/new-application>, set as `ACOUSTID_API_KEY`. AcoustID is for
  **non-commercial use** only.

## Troubleshooting

- `https://<your server>/jam-sync/tagger/capabilities` shows whether a plugin is
  connected and whether it can write (`"write": true`).
- The server logs `[Tagger] Plugin 0.1.0: 1 libraries, 1 writable` when the plugin
  connects. `0 writable` means "Allow write access" is off or the music volume is
  read-only. `Refused a plugin connection` means the secrets differ.
- The plugin logs each edit in Navidrome's log (user, file, fields, result).

## Development

- `cargo test` runs the tag-writing tests on real files of every format.
- `testbed/testbed.sh` runs a local Navidrome (Podman) with a sample library, the sync
  server, and this plugin built for them (see the script for its commands).

## Licenses

The plugin is GPL-3.0 (it uses Navidrome's plugin kit). lofty is MIT/Apache-2.0. The
app's fingerprinting uses `@unimusic/chromaprint` (MIT) with Chromaprint (LGPL-2.1),
loaded as a separate `.wasm` file.
