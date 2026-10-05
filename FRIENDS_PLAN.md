# Friends and Android self-update: implementation plan

Status: approved in principle. Nothing is built yet. Work happens on a `friends` branch.

Two features ship together in one release: **Friends** (parts 1–2) and **Android self-update** (part 3).

## Part 1: Friends, what you get

- A **Friends** item in the user menu (the user icon, top right).
- **Add a friend** by typing their username (their Navidrome login). They get an invite.
- **Invites show as a badge** on the user icon (a count). Accept or Decline from the Friends panel. No emails in this version.
- A **friends list** that shows each friend as online or offline. If the friend shares it, the list also shows what they're listening to.
- Two settings in the same panel, both **off by default**:
  - **Share listening activity**: your friends see what you're playing.
  - **Allow friends to join my session**: a friend can tap **Join** on you.
- **Join** puts the friend in a Jam with you as the owner. If you're already in a Jam, they join that one. More friends can join the same way.
- **Remove a friend** from the friends list at any time. It ends the friendship for both of you.
- **The Jam owner can remove people.** This works in any Jam, not only ones started by Join. Someone removed can't rejoin that Jam.

## Decisions (from your answers)

| Topic | Decision |
|---|---|
| Finding users | **By username only.** The sync server learns usernames from logins. There's no admin account, and no password beyond each person's own. |
| Email | **Not used at all.** The server doesn't read or store anyone's email, and invites show only as the badge. |
| Join | The setting is the permission. **Join** works straight away, with no prompt to the host. |
| Group size | Same as a normal Jam: more than two people is fine, and the person joined is the owner. |
| Removing people | The Jam owner can remove anyone in their Jam. Anyone can remove a friend. |

## Part 2: Friends, how it works

### Identity

A friend is a Navidrome account on your server, identified by its username (not case-sensitive, the same as Jam and Connect). Friendship is mutual: both people are friends once the invite is accepted.

### Looking users up

- Every time an app connects, the sync server has already checked that person's login with Navidrome. It now also records their username in a list of known users.
- An invite must match a known username **exactly** (not case-sensitive). There's no search-as-you-type and no browsable user list. Each account gets a limited number of invites per minute.
- **Someone who has never opened Aonsoku since this update** isn't on the list yet. Inviting them says "No Aonsoku user called X yet. They need to open Aonsoku once."
- No admin account and no emails are involved anywhere.

### Storage

Today the sync server keeps everything in memory. Friends need to survive restarts, so the server writes one small JSON file:

- Path: `/data/friends.json` inside the container, mounted from `./data/sync` on the host (a new volume in `docker-compose.yml`).
- Contents: known usernames, each user's two settings, friendships, and pending invites.
- Writes go to a temporary file first and are then renamed, so a crash can't leave a half-written file.

### Server (`jam-sync-server/index.js`)

All of this runs over the existing Connect connection that every signed-in app already opens. No new connection is needed.

| From app | What it does |
|---|---|
| `friend_invite { username }` | Checks the username is known. Fails if it isn't, if it's yourself, if you're already friends, or if an invite is already pending. Otherwise stores an invite and updates the other person's badge at once. Answers with a short result: sent, not found, already friends, already invited, or rate limited. If they had already invited you, it accepts theirs instead. |
| `friend_respond { inviteId, accept }` | Accept makes a friendship; Decline removes the invite. |
| `friend_cancel { inviteId }` | Withdraws an invite you sent. |
| `friend_remove { username }` | Ends a friendship, for both people. |
| `friend_settings { shareActivity, allowJoin }` | Saves your two settings. |
| `friend_join { username }` | Checks you're friends, that they allow joining, and that they're online with a playing device. Then it starts or reuses a Jam with them as owner (see below). |

| From server | What it carries |
|---|---|
| `friends_state` | Your friends (name, online, activity if shared, joinable), invites received, invites sent, and your settings. Sent on connect and whenever any of these changes. |
| `friend_join_start` | To the friend being joined: "start a Jam now, X is joining". |
| `friend_join_ready { sessionId }` | To the joiner: open this Jam. |

**Activity:**
- The server already gets each account's playback state from Connect, including the queue.
- From that it takes the current song (title, artist, album, cover art ID) and whether it's playing. Friends get it only if you share activity, and only while you're online.
- It's sent when the song or the play state changes, not on every position update.

**Listen offline:** an account in "listen offline" mode isn't connected, so it shows as offline and shares nothing. That fits the privacy idea of offline mode.

### Join flow

1. You tap **Join** on a friend.
2. If the friend is already in a Jam, the server answers with that Jam right away.
3. If not, the server sends `friend_join_start` to the friend's playing device. That app starts a Jam as host with its current queue, exactly as if they'd tapped **Start Jam**.
4. When their Jam is open, the server sends you `friend_join_ready`, and your app joins it like an invite link.
5. The host sees a toast: "X joined your session." Guest control stays off until the host turns it on, as in any Jam.

If the friend's app doesn't respond in about 10 seconds (asleep, or the network dropped), you see "Couldn't reach X".

### Removing someone from a Jam

- **Owner:** in the Jam panel's people list, each guest gets a **Remove** button, and only the owner sees it.
- **Server:** `jam_kick { username }`. Only the Jam's host may send it, and the host can't remove themselves.
  - The server takes all of that person's devices out of the Jam room and sends them `jam_removed`.
  - It updates everyone's people list and the account-wide Jam status.
  - The username goes on that Jam's removed list, so an invite link or **Join** can't bring them back into the same Jam. A new Jam starts with a clean list.
- **The removed person:** their app leaves the Jam exactly as when a host ends it, says "You were removed from the Jam", and offers to restore their queue from before the Jam.

### App (web, desktop, Android: the same code)

- **`src/store/friends.store.ts`**: friends, invites, settings and the badge count, filled from `friends_state`.
- **`src/service/connect.ts`**: sends and receives the friend events on the existing connection.
- **`user-dropdown.tsx`**:
  - A count badge on the user icon when invites are waiting.
  - A **Friends** item, with the same count.
- **Friends panel** (a dialog on desktop, a full-height sheet on phones):
  - **Add a friend:** a box for a username, a **Send invite** button, and the result shown inline.
  - **Invites:** each with **Accept** and **Decline**.
  - **Friends:** each with name, status ("Listening to *Song* by *Artist*", "Online" or "Offline"), a **Join** button when allowed, and a **⋯** menu with **Remove friend**. Remove asks you to confirm first.
  - **Sent invites:** each with **Cancel**.
  - **Settings:** the two checkboxes.
- **Offline or not connected:** the panel says friends need the sync server, and its controls are off.
- **Jam:**
  - A new start-on-request path that `friend_join_start` triggers. It reuses the existing "start Jam" code.
  - A **Remove** button on each guest in the owner's people list.
  - Handling of `jam_removed`.

## Part 3: Android self-update

### What you get

- The Android app notices when a newer release is on GitHub and shows the same **Update available** dialog the desktop app uses, with the release notes.
- **Update** downloads the new APK with a progress bar, then opens Android's installer. You tap **Update** there once, and the app restarts on the new version with your data intact.
- **Remind me later** hides it until the next app start, as on desktop.

### How it works

- **Check:**
  - At app start, and at most once every 6 hours, the app reads `https://api.github.com/repos/WACOMalt/aonsoku-bs/releases/latest`.
  - It compares that release's tag (for example `v0.18.0`) with the app's own version. Drafts and pre-releases are never offered.
  - It finds the APK in the release's files by name (`Aonsoku-<version>-android.apk`).
  - GitHub allows 60 unsigned API calls per hour per network, so 6 hours is far inside that.
- **Download:**
  - A small native plugin, `AppUpdate`, downloads the APK into the app's private cache folder. It only accepts `https` links on GitHub's own hosts, and reports progress to the dialog.
  - A half-finished download is deleted, and a finished one is reused if you tap **Update** again.
- **Install:**
  - The plugin hands the file to Android's installer through the app's existing `FileProvider`.
  - The first time, Android asks you to allow **Install unknown apps** for Aonsoku. The dialog says so, and its button opens that setting.
- **Safety:** Android refuses an update that isn't signed with the same key as the installed app, so a tampered or wrong APK can't replace it. Each release is signed with your release key in CI, as today.
- **Manifest:** adds the `REQUEST_INSTALL_PACKAGES` permission. That's fine for an app sideloaded from GitHub; only Play Store apps are restricted from it.
- **Desktop and web:** unchanged. Desktop keeps its own updater, and the web app updates with the container.

### Code

- `android/.../AppUpdatePlugin.java`: `download({ url })` with progress events, and `install()`, which checks the "unknown apps" permission first.
- `src/utils/androidUpdate.ts`: the GitHub check and the version comparison.
- `update-observer.tsx`: on Android, it uses the GitHub check and the plugin instead of `window.api`. The dialog and its texts stay the same.
- `file_paths.xml`: a cache path for the downloaded APK.

### Testing

- Install an older build, open the app, see the dialog, update, and confirm the new version runs with your sign-in and queue intact.
- A build that's already up to date shows nothing.
- Turn off "Install unknown apps" and check the dialog explains it.
- Turn off the network during download: the dialog shows an error, and a retry works.

## Server setup you'll do

Pull and rebuild the container as usual. The new `docker-compose.yml` adds the `./data/sync` volume, where friends are saved. There's no account to create and nothing to add to `.env`.

## Testing friends

- **Local, two accounts:** the sync server runs locally, with two dev tabs signed in as AITester1 and AITester2, and audio sent to the silent output. Covered:
  - invites both ways, Accept and Decline
  - the badge
  - removing a friend, seen from both sides
  - the owner removing a guest, who then can't rejoin that Jam but can join a new one
  - both settings on and off
  - activity updates
  - Join when the friend isn't in a Jam, and when they're already in one
  - Join refused when it's not allowed or the friend is offline
  - a restart keeping friends
- **Android:** the panel layout on the phone, and Join from the phone.

## Not in this version

- Email: no email invites and no adding by email. Adding by email later would need the server to learn emails (from logins, or an admin lookup); invite emails would also need SMTP settings.
- Push notifications when the app is closed. The badge appears the next time the app connects.
- Inviting people who've never opened Aonsoku (since this update), or who have no account on your Navidrome.
- Blocking. **Remove** and **Decline** cover the basics for a private server.

## Release

When both features are done and tested, I'll check with you. Then we merge `friends` into `main` and publish **v0.18.0**:

- **Server and container first:** older apps simply ignore the new events.
- **Then the apps.** v0.18.0 is the first Android build with self-update, so you install it by hand one last time. From then on, the app offers each new release itself.
