# Song caching and "Keep cached": plan

Branch: `caching-and-downloads`

## Goal

1. Every song you play is cached on the device, on web, desktop and Android.
   The next play of that song comes from the device, not from the server.
2. You can choose **Keep cached** on a song, album, artist or playlist. The app
   downloads it ahead of time and keeps it on the device.
3. A cached song is used only while it still matches the song on the server.
4. The current **Download** option becomes **Save file**, and it works on all
   platforms.

## What you see

### Settings → Content → Caches

The current "Enable Media Cache" switch is replaced by a **Songs** section:

- **Cache songs I play**: on by default.
- **Cache size**: **2 GB by default**. You type any size in GB (from 0.1
  GB up to the free space on the device), or pick 1, 2, 5, 10 GB or **No
  limit**. A smaller size takes effect at once: songs are removed until the
  cache fits. When the cache is full, the songs played longest ago are
  removed first.
  Kept items do not count against this limit and are never removed by it.
- **Usage**: "Played songs: 1.4 GB of 2 GB. Kept: 3.2 GB (412 songs)."
- **Kept items**: the albums, artists, playlists and songs you keep, each
  with its progress ("38 of 40 songs", "Waiting for Wi-Fi") and a Remove
  button.
- **Download kept items on Wi-Fi only** (Android): off by default.
- **Clear played songs** and **Remove all kept items**, each with a confirm
  step.

The other cache switches (images, lyrics) and **Clear Caches** stay as they
are.

### Menus

- **Keep cached** in the menu of a song, album, artist and playlist (the
  "…" menu, the right-click menu, and with several songs selected). On an
  item that is kept, it becomes **Remove from cache**.
- **Save file** replaces **Download**. It saves the original file (or a ZIP
  of an album, artist or playlist) to the Downloads folder. With several
  songs selected, it saves all of them, not only the first.
- A small icon shows that an album, playlist or song is kept, on its page
  and in lists.

### Kept albums, artists and playlists follow the server

The app checks them when it starts, when you open one, and every 6 hours
while it runs. Songs added on the server are downloaded. Songs removed on
the server are removed from the device. A kept artist includes their new
albums.

## When a cached song is used

A cached song is used only while it matches the server. The app stores, for
each cached song, the details the server gives: size in bytes, file type,
duration and bit rate. Each time the app gets the song from the server again
(a queue, an album or playlist page, the check of kept items), it compares
them. If a detail is different (for example, you replaced the file with a
better one), the cached copy is deleted. A kept song is downloaded again. A
played song is streamed and cached again the next time it plays.

The app also checks that a downloaded file is complete: its size must be the
same as the size the server gave.

The cache holds the same file the app streams now: the original file (an
`.m4a` song is still converted to Opus by the server, as now).

## How it works on each platform

### Android

- The native player (Media3) gets a song cache: songs read through it are
  written to the device as they stream, and later plays read from the
  device. Android Auto uses the same player, so it gets the cache too.
- Two stores:
  - **Played songs**: in the app's cache folder, limited to the cache size,
    oldest removed first.
  - **Kept songs**: in the app's own storage, never removed except by you or
    by the server check.
- Kept songs are downloaded by Media3's download manager, which keeps going
  when the app is in the background, shows its progress in a notification,
  continues after a lost connection, and can wait for Wi-Fi.
- Each song is stored under its song ID (and format), not its web address,
  because the address carries a login token that changes.

### Desktop (Windows, macOS, Linux)

- Songs are stored as files in the app's data folder, managed by the
  desktop app's main process, with the same two stores and size limit.
- The player reads a cached song through a private app address that
  supports seeking, so it plays like a stream.
- On desktop, the gapless player already downloads each whole song. That
  download is saved to the cache, so caching costs no extra download.
- Kept songs download in the background, two at a time.

### Web

- Songs are stored in the browser's storage for the site. The site's
  service worker gives a cached song to the player when it asks for it,
  with seeking, so nothing else in the player changes.
- The app asks the browser to keep this storage (persistent storage), so the
  browser does not delete kept songs when space is low. The browser can still
  limit how much the site may store; Settings shows the space available.

## Downloading without overloading the server

Kept items download at most 2 songs at a time, and not at all while a song
is playing from the server and has not loaded yet. This follows the same
rule as the staggered next-song download, so your NAS is not asked for
everything at once.

## Save file on every platform

- **Desktop**: as now (to the Downloads folder), plus all selected songs.
- **Web**: as now, a browser download.
- **Android**: today it does nothing. It will use Android's download manager,
  which saves the file to Downloads and shows a notification.

## Steps

1. **Rules shared by all platforms**: the list of kept items, finding their
   songs on the server, the match check, the settings and the menus.
2. **Android**: the player cache, the kept downloads, Wi-Fi only, and Save
   file.
3. **Desktop**: the disk cache, the app address for cached songs, and saving
   what the gapless player downloads.
4. **Web**: the service worker cache.
5. **Icons** for kept items in lists and on pages.
6. **Tests** on each platform: first play then a second play with the server
   blocked; Keep cached on an album then play it with no network; a song
   replaced on the server is downloaded again; the cache size limit; a kept
   playlist after songs are added and removed; Wi-Fi only on Android; and
   **Save file** for a song, an album and several selected songs on desktop,
   web and Android.

## Not in this plan

- **Using the app with no server at all** (browsing and playing kept music
  with no connection to Navidrome). The app's pages come from the server,
  so this is a separate, bigger job. In this plan, kept songs play without a
  network only from a queue that is already loaded (for example, the album
  you were playing).
- Choosing a lower quality for cached songs.
