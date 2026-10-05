// Friends: invites by username, a friends list with who is online and (if
// shared) what they are playing, and joining a friend's Jam.
//
// Usernames are learned from logins: every connection has already been
// checked against Navidrome, so the usernames recorded here are real
// accounts that have used Aonsoku. Nothing else about anyone (no email) is
// read or kept.
//
// Friends, invites and each user's two settings are kept in a JSON file
// (SYNC_DATA_DIR, /data in the container) so they survive restarts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const userKey = (name) => name.toLowerCase();

// Invites one account may send per minute.
const INVITE_LIMIT = 10;
const INVITE_WINDOW_MS = 60000;
// How long the friend being joined has to open their Jam.
const JOIN_TIMEOUT_MS = 12000;
const SAVE_DELAY_MS = 500;

function emptyData() {
  return { version: 1, users: {}, friendships: [], invites: [] };
}

/**
 * @param io the Socket.IO server
 * @param privateSessions Connect sessions by user key (see index.js)
 * @param jamStatusFor (key) => the Jam a user is in, or null
 * @param isRemovedFromJam (sessionId, key) => whether the host removed them
 * @param dataDir where friends.json is kept
 */
function createFriends({ io, privateSessions, jamStatusFor, isRemovedFromJam, dataDir }) {
  const file = path.join(dataDir, 'friends.json');
  const data = load();
  let saveTimer = null;

  const inviteTimes = new Map(); // key -> timestamps of recent invites
  const lastActivity = new Map(); // key -> what friends last saw, as a string
  // Joins waiting for the friend's Jam to open: sessionId -> pending join.
  const pendingJoins = new Map();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...emptyData(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[Friends] Could not read', file, err.message);
      }
      return emptyData();
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const partial = `${file}.part`;
        fs.writeFileSync(partial, JSON.stringify(data));
        fs.renameSync(partial, file);
      } catch (err) {
        console.error('[Friends] Could not save', file, err.message);
      }
    }, SAVE_DELAY_MS);
  }

  // ── Data ──

  function user(key) {
    return data.users[key];
  }

  function nameOf(key) {
    return data.users[key]?.name || key;
  }

  function friendsOf(key) {
    const result = [];
    for (const [a, b] of data.friendships) {
      if (a === key) result.push(b);
      else if (b === key) result.push(a);
    }
    return result;
  }

  function areFriends(a, b) {
    return data.friendships.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  function addFriendship(a, b) {
    if (!areFriends(a, b)) data.friendships.push([a, b].sort());
    // Any invites between them are settled.
    data.invites = data.invites.filter(
      (i) => !((i.from === a && i.to === b) || (i.from === b && i.to === a)),
    );
    save();
  }

  // ── What a user sees ──

  function isOnline(key) {
    const session = privateSessions[key];
    return !!session && session.devices.size > 0;
  }

  /** What a user is playing, for friends: null unless they share it. */
  function activityOf(key) {
    if (!user(key)?.shareActivity) return null;
    const state = privateSessions[key]?.playbackState;
    if (!state || !state.songId) return null;
    const song = Array.isArray(state.queue)
      ? state.queue.find((s) => s && s.id === state.songId)
      : null;
    if (!song) return null;
    return {
      songId: song.id,
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      coverArt: song.coverArt || '',
      isPlaying: !!state.isPlaying,
    };
  }

  /** Whether a friend may join this user now. */
  function isJoinable(key) {
    if (!user(key)?.allowJoin || !isOnline(key)) return false;
    if (jamStatusFor(key)) return true;
    return privateSessions[key].activeKey !== null;
  }

  function stateFor(key) {
    const me = user(key) || {};
    return {
      settings: {
        shareActivity: !!me.shareActivity,
        allowJoin: !!me.allowJoin,
      },
      friends: friendsOf(key)
        .map((friend) => ({
          username: nameOf(friend),
          online: isOnline(friend),
          activity: isOnline(friend) ? activityOf(friend) : null,
          joinable: isJoinable(friend),
          inJam: isOnline(friend) && !!jamStatusFor(friend),
        }))
        .sort((a, b) => a.username.localeCompare(b.username)),
      incoming: data.invites
        .filter((i) => i.to === key)
        .map((i) => ({ id: i.id, username: nameOf(i.from), createdAt: i.createdAt })),
      outgoing: data.invites
        .filter((i) => i.from === key)
        .map((i) => ({ id: i.id, username: nameOf(i.to), createdAt: i.createdAt })),
    };
  }

  function emitState(key) {
    const session = privateSessions[key];
    if (!session) return;
    const state = stateFor(key);
    for (const [sid] of session.devices) io.to(sid).emit('friends_state', state);
  }

  /** A user's online state, activity or settings changed: tell their friends. */
  function notifyFriendsOf(key) {
    for (const friend of friendsOf(key)) emitState(friend);
  }

  // ── Hooks from index.js ──

  /** A device signed in: remember the username and send the friends state. */
  function onConnect(key, username, socket) {
    const existing = data.users[key];
    if (!existing) {
      data.users[key] = { name: username, shareActivity: false, allowJoin: false };
      save();
    } else if (existing.name !== username) {
      existing.name = username;
      save();
    }
    socket.emit('friends_state', stateFor(key));
    // The first device coming online changes what friends see.
    if (privateSessions[key]?.devices.size === 1) notifyFriendsOf(key);
  }

  /** A device left; the last one leaving takes the user offline. */
  function onDisconnect(key) {
    if (!isOnline(key)) {
      lastActivity.delete(key);
      notifyFriendsOf(key);
    }
  }

  /**
   * Playback changed (song, play state, who plays). Friends are told only
   * when what they see changes, not on every position update.
   */
  function onPlayback(key) {
    const seen = JSON.stringify([activityOf(key), isJoinable(key)]);
    if (lastActivity.get(key) === seen) return;
    lastActivity.set(key, seen);
    notifyFriendsOf(key);
  }

  /** Someone joined or left a Jam: whether they are in one shows to friends. */
  function onJamChange(names) {
    for (const key of new Set(names.map(userKey))) notifyFriendsOf(key);
  }

  /**
   * A Jam socket connected for this session. If a friend is waiting to join
   * it, tell them it is open once its host is in.
   */
  function onJamOpened(sessionId, hostKey) {
    const pending = pendingJoins.get(sessionId);
    if (!pending || pending.host !== hostKey) return;
    clearTimeout(pending.timer);
    pendingJoins.delete(sessionId);
    io.to(pending.socketId).emit('friend_join_ready', {
      sessionId,
      username: nameOf(pending.host),
    });
  }

  // ── Events from a signed-in device ──

  function attach(socket, key) {
    const reply = (ack, result) => {
      if (typeof ack === 'function') ack(result);
    };

    socket.on('friend_invite', ({ username } = {}, ack) => {
      if (typeof username !== 'string' || !username.trim()) {
        return reply(ack, { result: 'not_found' });
      }
      const now = Date.now();
      const recent = (inviteTimes.get(key) || []).filter((t) => now - t < INVITE_WINDOW_MS);
      if (recent.length >= INVITE_LIMIT) return reply(ack, { result: 'rate_limited' });
      recent.push(now);
      inviteTimes.set(key, recent);

      const target = userKey(username.trim());
      if (target === key) return reply(ack, { result: 'self' });
      if (!user(target)) return reply(ack, { result: 'not_found' });
      if (areFriends(key, target)) return reply(ack, { result: 'already_friends' });
      if (data.invites.some((i) => i.from === key && i.to === target)) {
        return reply(ack, { result: 'already_invited' });
      }
      // They had already invited this user: inviting back accepts.
      if (data.invites.some((i) => i.from === target && i.to === key)) {
        addFriendship(key, target);
        emitState(key);
        emitState(target);
        return reply(ack, { result: 'accepted', username: nameOf(target) });
      }
      data.invites.push({
        id: crypto.randomBytes(8).toString('hex'),
        from: key,
        to: target,
        createdAt: now,
      });
      save();
      emitState(key);
      emitState(target);
      console.log(`[Friends] ${key} invited ${target}`);
      reply(ack, { result: 'sent', username: nameOf(target) });
    });

    socket.on('friend_respond', ({ inviteId, accept } = {}) => {
      const invite = data.invites.find((i) => i.id === inviteId && i.to === key);
      if (!invite) return;
      if (accept) {
        addFriendship(invite.from, key);
        console.log(`[Friends] ${key} and ${invite.from} are friends`);
      } else {
        data.invites = data.invites.filter((i) => i !== invite);
        save();
      }
      emitState(key);
      emitState(invite.from);
    });

    socket.on('friend_cancel', ({ inviteId } = {}) => {
      const invite = data.invites.find((i) => i.id === inviteId && i.from === key);
      if (!invite) return;
      data.invites = data.invites.filter((i) => i !== invite);
      save();
      emitState(key);
      emitState(invite.to);
    });

    socket.on('friend_remove', ({ username } = {}) => {
      if (typeof username !== 'string') return;
      const other = userKey(username);
      const before = data.friendships.length;
      data.friendships = data.friendships.filter(
        ([a, b]) => !((a === key && b === other) || (a === other && b === key)),
      );
      if (data.friendships.length === before) return;
      save();
      console.log(`[Friends] ${key} removed ${other}`);
      emitState(key);
      emitState(other);
    });

    socket.on('friend_settings', ({ shareActivity, allowJoin } = {}) => {
      const me = user(key);
      if (!me) return;
      if (typeof shareActivity === 'boolean') me.shareActivity = shareActivity;
      if (typeof allowJoin === 'boolean') me.allowJoin = allowJoin;
      save();
      emitState(key);
      lastActivity.delete(key);
      notifyFriendsOf(key);
    });

    socket.on('friend_join', ({ username } = {}, ack) => {
      if (typeof username !== 'string') return reply(ack, { result: 'not_allowed' });
      const target = userKey(username);
      if (!areFriends(key, target) || !user(target)?.allowJoin) {
        return reply(ack, { result: 'not_allowed' });
      }
      if (!isOnline(target)) return reply(ack, { result: 'offline' });

      // Already in a Jam: join that one.
      const jam = jamStatusFor(target);
      if (jam) {
        if (isRemovedFromJam(jam.id, key)) return reply(ack, { result: 'removed' });
        return reply(ack, { result: 'ready', sessionId: jam.id });
      }

      // Otherwise the friend's playing device opens a Jam for them.
      const session = privateSessions[target];
      let hostSocket = null;
      for (const [sid, device] of session.devices) {
        if (session.activeKey !== null && device.key === session.activeKey) hostSocket = sid;
      }
      if (!hostSocket) return reply(ack, { result: 'not_playing' });

      const sessionId = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        if (!pendingJoins.delete(sessionId)) return;
        io.to(socket.id).emit('friend_join_failed', { username: nameOf(target) });
      }, JOIN_TIMEOUT_MS);
      pendingJoins.set(sessionId, { host: target, joiner: key, socketId: socket.id, timer });
      io.to(hostSocket).emit('friend_join_start', { sessionId, username: nameOf(key) });
      console.log(`[Friends] ${key} is joining ${target} (Jam ${sessionId})`);
      reply(ack, { result: 'starting' });
    });
  }

  /** Whether this user may open the Jam a friend is waiting for. */
  function isPendingHost(sessionId, key) {
    return pendingJoins.get(sessionId)?.host === key;
  }

  return {
    attach,
    onConnect,
    onDisconnect,
    onPlayback,
    onJamChange,
    onJamOpened,
    isPendingHost,
    nameOf,
  };
}

module.exports = { createFriends };
