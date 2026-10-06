const crypto = require('crypto');
const { createFriends } = require('./friends');

// The Navidrome (Subsonic) server whose accounts may use this sync server.
// It must come from server configuration: letting the client name the
// server to check against would let anyone point it at a fake one.
const NAVIDROME_URL = (process.env.NAVIDROME_URL || process.env.SERVER_URL || '')
  .trim()
  .replace(/\/+$/, '');

// Plain HTTP on the same port, for the admin's user sync (sync-users.js).
// Only /jam-sync/ is proxied to this port, so this is reachable from inside
// the container only.
const httpServer = require('http').createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/admin/sync-users') {
    return handleUserSync(req, res);
  }
  res.writeHead(404).end();
});

const io = require('socket.io')(httpServer, {
  path: '/jam-sync/socket.io',
  // Queues are sent in full whenever they change; allow long playlists.
  maxHttpBufferSize: 1e7,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

if (!NAVIDROME_URL) {
  console.error('[Auth] NAVIDROME_URL (or SERVER_URL) is not set; every connection will be refused.');
}

// ── Authentication ──
// Clients send their existing Subsonic credentials (u + t/s token, or u + p)
// in the handshake auth payload. We confirm them with a ping against the
// configured Navidrome server and only then trust the username.
const AUTH_CACHE_MS = 5 * 60 * 1000;
const authCache = new Map(); // sha256(credentials) -> expiry timestamp

function credentialKey(creds) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([creds.u, creds.t || '', creds.s || '', creds.p || '']))
    .digest('hex');
}

async function verifyWithNavidrome(creds) {
  const params = new URLSearchParams({
    u: creds.u,
    v: typeof creds.v === 'string' ? creds.v : '1.16.1',
    c: typeof creds.c === 'string' ? creds.c : 'aonsoku-sync',
    f: 'json',
  });
  if (creds.t && creds.s) {
    params.set('t', creds.t);
    params.set('s', creds.s);
  } else {
    params.set('p', creds.p);
  }
  const res = await fetch(`${NAVIDROME_URL}/rest/ping.view?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return false;
  const body = await res.json().catch(() => null);
  return body?.['subsonic-response']?.status === 'ok';
}

io.use(async (socket, next) => {
  if (!NAVIDROME_URL) return next(new Error('sync_not_configured'));

  const creds = socket.handshake.auth || {};
  const hasToken = typeof creds.t === 'string' && typeof creds.s === 'string' && creds.t && creds.s;
  const hasPassword = typeof creds.p === 'string' && creds.p;
  if (typeof creds.u !== 'string' || !creds.u || (!hasToken && !hasPassword)) {
    return next(new Error('unauthorized'));
  }

  const key = credentialKey(creds);
  const cachedUntil = authCache.get(key);
  if (cachedUntil && cachedUntil > Date.now()) {
    socket.data.username = creds.u;
    return next();
  }

  try {
    if (await verifyWithNavidrome(creds)) {
      authCache.set(key, Date.now() + AUTH_CACHE_MS);
      socket.data.username = creds.u;
      return next();
    }
    return next(new Error('unauthorized'));
  } catch (err) {
    console.error('[Auth] Could not reach Navidrome:', err.message);
    return next(new Error('auth_unavailable'));
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, until] of authCache) if (until <= now) authCache.delete(key);
}, 60000).unref();

// Session keys are case-insensitive, matching Navidrome logins.
const userKey = (name) => name.toLowerCase();
const SESSION_ID_PATTERN = /^[a-z0-9]{6,32}$/i;

// Keeps the last known queue when an update omits it. Clients only send the
// queue when it changes, so most updates carry position and play state only.
function mergePlaybackState(previous, update) {
  const merged = { ...(previous || {}), ...update };
  if (!update.queue && previous && previous.queue) merged.queue = previous.queue;
  return merged;
}

// In-memory stores
// privateSessions[user] = {
//   devices: Map<socketId, Device>,
//   activeKey: device key of the one device that plays audio, or null,
//   playbackState, releaseTimer,
// }
// Exactly one device plays at a time. It is tracked by the client's stable
// device key rather than its socket id, so a device that briefly reconnects
// keeps control instead of losing it to whichever device connected first.
const privateSessions = {}
const jamSessions = {}      // { [sessionId]: { participants: [], lastState: null, canGuestsControl: false } }

// Track which socket belongs to which session type and username
const socketMeta = {}        // { [socketId]: { username, sessionType, sessionId? } }

// How long control waits for the active device to reconnect before playback
// is stopped. Nobody is promoted: audio starting on another device by itself
// is worse than silence.
const ACTIVE_RELEASE_GRACE_MS = 15000

/**
 * The Jam a user is in, seen from any of their devices: a Jam belongs to the
 * account, while only the device playing it has a socket in its room. While
 * the Jam moves between devices both can be in, and the latest join wins.
 */
function jamStatusFor(key) {
  let found = null
  for (const [id, jam] of Object.entries(jamSessions)) {
    for (const participant of jam.participants) {
      if (userKey(participant.name) !== key) continue
      if (!found || participant.joinedAt > found.joinedAt) {
        found = { id, jam, joinedAt: participant.joinedAt }
      }
    }
  }
  if (!found) return null
  const { id, jam } = found
  return {
    id,
    isLead: jam.host === key,
    canGuestsControl: !!jam.canGuestsControl,
    participants: jam.participants.map(({ id, name, isLead }) => ({ id, name, isLead })),
    // This user's sockets in the room (normally one; two while handing over).
    sockets: jam.participants.filter(p => userKey(p.name) === key).map(p => p.id),
  }
}

// Tells every device of the user which Jam they are in.
function emitJamStatus(key) {
  const session = privateSessions[key]
  if (!session) return
  const status = jamStatusFor(key)
  for (const [sid] of session.devices) io.to(sid).emit('jam_status', status)
}

// After a change to a Jam: its participants (and anyone who just left).
function emitJamStatusForUsers(names) {
  for (const key of new Set(names.map(userKey))) emitJamStatus(key)
  friends.onJamChange(names)
}

// Friends (see friends.js), kept on disk in SYNC_DATA_DIR.
const friends = createFriends({
  io,
  privateSessions,
  jamStatusFor,
  isRemovedFromJam: (sessionId, key) => !!jamSessions[sessionId]?.removed?.has(key),
  dataDir: process.env.SYNC_DATA_DIR || require('path').join(__dirname, 'data'),
})

// How long a Jam waits for its host to come back (a phone dropping off the
// network for a moment) before it ends for everyone.
const HOST_GONE_GRACE_MS = Number(process.env.JAM_GRACE_MS) || 60000

// Jams that ended recently, so a host coming back to one (after a dropped
// connection) is told, instead of quietly starting it again alone.
const ENDED_MEMORY_MS = 30 * 60 * 1000
const endedSessions = new Map() // sessionId -> when it ended

/**
 * Ends a Jam for everyone in it. `reason` 'alone' tells the host the last
 * guest left, so it carries on quietly with the Jam's queue.
 */
function endJam(sessionId, why, reason) {
  const jam = jamSessions[sessionId]
  if (!jam) return
  clearTimeout(jam.hostGoneTimer)
  clearTimeout(jam.aloneTimer)
  endedSessions.set(sessionId, Date.now())
  const names = jam.participants.map(p => p.name)
  io.to(sessionId).emit('session_ended', reason ? { reason } : undefined)
  delete jamSessions[sessionId]
  emitJamStatusForUsers([jam.host, ...names])
  console.log(`[Jam] Session ended: ${sessionId} (${why})`)
}

/** The Jam this user hosts, even with none of their devices in it now. */
function jamHostedBy(key) {
  for (const [id, jam] of Object.entries(jamSessions)) {
    if (jam.host === key) return id
  }
  return null
}

/**
 * After someone leaves a Jam: if its host has no device left in it, the
 * Jam ends unless the host is back within the grace period. Without this a
 * host whose "end" never arrived (offline at the time) left the guests in a
 * Jam nobody hosts, which they could not leave by joining the host again.
 */
function checkHostPresent(sessionId) {
  const jam = jamSessions[sessionId]
  if (!jam) return
  const hostHere = jam.participants.some(p => userKey(p.name) === jam.host)
  if (hostHere) {
    clearTimeout(jam.hostGoneTimer)
    jam.hostGoneTimer = null
  } else if (!jam.hostGoneTimer && jam.participants.length > 0) {
    jam.hostGoneTimer = setTimeout(() => endJam(sessionId, 'host gone'), HOST_GONE_GRACE_MS)
  }
}

// How long a Jam waits when its last guest's connection dropped (a phone in
// the background) before it ends; leaving or being removed ends it at once.
const GUESTS_GONE_GRACE_MS = Number(process.env.JAM_GRACE_MS) || 60000

/**
 * A guest left: once nobody but the host is in a Jam that had guests, it
 * ends, and the host's music goes on with its queue. A Jam that never had a
 * guest (the host waiting for people) is left alone.
 */
function checkGuestsPresent(sessionId, { immediate }) {
  const jam = jamSessions[sessionId]
  if (!jam || !jam.hadGuests) return
  const guestsHere = jam.participants.some(p => userKey(p.name) !== jam.host)
  if (guestsHere) {
    clearTimeout(jam.aloneTimer)
    jam.aloneTimer = null
    return
  }
  if (!jam.participants.some(p => userKey(p.name) === jam.host)) return
  if (immediate) {
    endJam(sessionId, 'last guest left', 'alone')
  } else if (!jam.aloneTimer) {
    jam.aloneTimer = setTimeout(() => {
      jam.aloneTimer = null
      checkGuestsPresent(sessionId, { immediate: true })
    }, GUESTS_GONE_GRACE_MS)
  }
}

/**
 * Removes a user from a Jam (the host's call): all of their sockets leave
 * the room, and they cannot come back into this Jam.
 */
function kickFromJam(sessionId, targetKey) {
  const jam = jamSessions[sessionId]
  if (!jam || targetKey === jam.host) return
  const removed = jam.participants.filter(p => userKey(p.name) === targetKey)
  if (removed.length === 0) return
  jam.removed = jam.removed || new Set()
  jam.removed.add(targetKey)
  jam.participants = jam.participants.filter(p => userKey(p.name) !== targetKey)
  for (const p of removed) {
    const target = io.sockets.sockets.get(p.id)
    if (target) {
      target.emit('jam_removed')
      target.leave(sessionId)
      delete socketMeta[p.id]
      target.disconnect(true)
    }
  }
  io.to(sessionId).emit('participants_update', jam.participants)
  emitJamStatusForUsers([removed[0].name, ...jam.participants.map(p => p.name)])
  console.log(`[Jam] ${targetKey} was removed from ${sessionId}`)
  checkGuestsPresent(sessionId, { immediate: true })
}

function isActiveDevice(session, device) {
  return !!device && session.activeKey !== null && device.key === session.activeKey
}

function findDeviceBySocket(session, socketId) {
  return session.devices.get(socketId)
}

function emitDevicesUpdate(username) {
  const session = privateSessions[username]
  if (!session) return
  const deviceList = Array.from(session.devices.values()).map(d => ({
    id: d.id,
    name: d.name,
    isActivePlayer: isActiveDevice(session, d),
    lastSeen: d.lastSeen
  }))
  for (const [sid] of session.devices) {
    io.to(sid).emit('devices_update', deviceList)
  }
}

io.on('connection', (socket) => {
  // Only the handshake-verified username is trusted. Any username or isLead
  // in the query string is ignored.
  const username = socket.data.username;
  // mode: 'create' starts a session, 'join' only enters an existing one.
  // Clients that predate it send neither and get the old create-or-join.
  const { sessionId, deviceName, sessionType, mode } = socket.handshake.query;

  // Determine session type: 'private' or 'jam' (default to 'jam' for backward compat)
  const resolvedSessionType = sessionType || 'jam';

  if (resolvedSessionType === 'private') {
    // ── Private Session Connection ──
    const key = userKey(username);

    // Create or join the user's private session
    if (!privateSessions[key]) {
      privateSessions[key] = {
        devices: new Map(),
        activeKey: null,
        playbackState: null,
        releaseTimer: null
      };
      console.log(`[Connect] Private session created for user: ${username}`);
    }

    const session = privateSessions[key];
    // Older clients send no stable key; their socket id stands in for it.
    const rawKey = socket.handshake.query.deviceKey;
    const deviceKey = typeof rawKey === 'string' && rawKey ? rawKey.slice(0, 64) : socket.id;

    // The same device reconnecting: drop its old socket so that socket's
    // eventual disconnect does not look like the device leaving.
    for (const [sid, existing] of session.devices) {
      if (existing.key === deviceKey) {
        session.devices.delete(sid);
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    }

    const device = {
      id: socket.id,
      key: deviceKey,
      name: deviceName || 'Unknown Device',
      userAgent: socket.handshake.headers['user-agent'] || '',
      lastSeen: new Date()
    };
    session.devices.set(socket.id, device);

    if (session.activeKey === deviceKey) {
      // The active device is back in time; it keeps playing.
      clearTimeout(session.releaseTimer);
      session.releaseTimer = null;
    } else if (session.activeKey === null && session.devices.size === 1) {
      // Alone and nobody in control: this device plays.
      session.activeKey = deviceKey;
    }

    socketMeta[socket.id] = { username: key, sessionType: 'private' };

    const isActive = isActiveDevice(session, device);
    emitDevicesUpdate(key);

    // Everyone else mirrors what the active device is doing, without audio.
    if (session.playbackState && !isActive) {
      socket.emit('sync_playback', session.playbackState);
    }

    console.log(`[Connect] ${username} connected device "${device.name}" (Active: ${isActive})`);

    socket.emit('jam_status', jamStatusFor(key));
    friends.onConnect(key, username, socket);
    friends.attach(socket, key);

    // ── Private Session Events ──

    socket.on('playback_update', (data) => {
      const privateSession = privateSessions[key];
      if (!privateSession) return;

      const dev = findDeviceBySocket(privateSession, socket.id);
      if (isActiveDevice(privateSession, dev)) {
        privateSession.playbackState = mergePlaybackState(privateSession.playbackState, data);
        // Broadcast to all OTHER devices of this user
        for (const [sid] of privateSession.devices) {
          if (sid !== socket.id) {
            io.to(sid).emit('sync_playback', data);
          }
        }
        friends.onPlayback(key);
      }
    });

    // Moves audio to one device. A device claiming control for itself can
    // send its own state (it chose what to play); otherwise the target picks
    // up where the previous device was.
    socket.on('transfer_playback', ({ targetDeviceId, state } = {}) => {
      const privateSession = privateSessions[key];
      if (!privateSession) return;

      const targetDevice = privateSession.devices.get(targetDeviceId);
      if (!targetDevice) return;

      clearTimeout(privateSession.releaseTimer);
      privateSession.releaseTimer = null;
      privateSession.activeKey = targetDevice.key;

      const claimingForSelf = targetDeviceId === socket.id && state;
      if (claimingForSelf) {
        privateSession.playbackState = mergePlaybackState(privateSession.playbackState, state);
      }
      io.to(targetDeviceId).emit('become_active_player', claimingForSelf ? null : privateSession.playbackState);
      emitDevicesUpdate(key);
      friends.onPlayback(key);
    });

    socket.on('remote_command', ({ command, args } = {}) => {
      // Forward command to the active player device
      const privateSession = privateSessions[key];
      if (!privateSession) return;

      for (const [sid, dev] of privateSession.devices) {
        if (isActiveDevice(privateSession, dev) && sid !== socket.id) {
          io.to(sid).emit('remote_command', { command, args });
        }
      }
    });

    // Leave or end the user's Jam, or change guest control, from any of
    // their devices, including ones not in the Jam's room.
    socket.on('jam_control', ({ action, canControl, username: target } = {}) => {
      const status = jamStatusFor(key);
      // Ending works even when none of the host's devices is in the Jam's
      // room at the moment (a phone that dropped off the network).
      if (!status && action === 'end') {
        const hosted = jamHostedBy(key);
        if (hosted) endJam(hosted, 'ended by host');
        return;
      }
      if (!status) return;
      const jam = jamSessions[status.id];
      if (!jam) return;
      if (action === 'end' && jam.host === key) {
        endJam(status.id, 'ended by host');
      } else if (action === 'leave') {
        for (const sid of status.sockets) io.to(sid).emit('jam_leave_request');
      } else if (action === 'kick' && jam.host === key && typeof target === 'string') {
        kickFromJam(status.id, userKey(target));
      } else if (action === 'guest_control' && jam.host === key) {
        jam.canGuestsControl = !!canControl;
        io.to(status.id).emit('guest_control_update', { canGuestsControl: jam.canGuestsControl });
        emitJamStatusForUsers(jam.participants.map(p => p.name));
      }
    });

    // The playing device is going offline (listening privately): it gives
    // up control at once instead of after the reconnect grace period.
    socket.on('release_control', () => {
      const privateSession = privateSessions[key];
      const dev = privateSession && findDeviceBySocket(privateSession, socket.id);
      if (!dev || !isActiveDevice(privateSession, dev)) return;
      clearControl(key);
    });

    socket.on('heartbeat', () => {
      const privateSession = privateSessions[key];
      if (privateSession) {
        const dev = privateSession.devices.get(socket.id);
        if (dev) dev.lastSeen = new Date();
      }
    });

    socket.on('disconnect', (reason) => {
      const privateSession = privateSessions[key];
      const leaving = privateSession?.devices.get(socket.id);
      // Not in the map: this socket was replaced by the same device reconnecting.
      if (privateSession && leaving) {
        privateSession.devices.delete(socket.id);

        if (privateSession.devices.size === 0) {
          clearTimeout(privateSession.releaseTimer);
          delete privateSessions[key];
          console.log(`[Connect] Private session ended for user: ${username}`);
        } else {
          if (isActiveDevice(privateSession, leaving)) {
            clearTimeout(privateSession.releaseTimer);
            privateSession.releaseTimer = setTimeout(() => releaseControl(key, leaving.key), ACTIVE_RELEASE_GRACE_MS);
          }
          emitDevicesUpdate(key);
        }
      }

      delete socketMeta[socket.id];
      if (leaving) friends.onDisconnect(key);
      console.log(`[Connect] ${username} device "${leaving?.name ?? 'replaced'}" disconnected: ${reason}`);
    });

  } else {
    // ── Jam Session Connection (existing logic) ──
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      console.log(`[Jam] Rejected connection: invalid session id`);
      return socket.disconnect();
    }

    // Ended while this device was away: it isn't started again.
    const endedAt = endedSessions.get(sessionId);
    if (!jamSessions[sessionId] && endedAt && Date.now() - endedAt < ENDED_MEMORY_MS) {
      socket.emit('session_ended');
      return socket.disconnect(true);
    }

    if (!jamSessions[sessionId] && mode === 'join') {
      // An invite link to a Jam that has ended must not quietly start a new
      // session with the invitee as its host.
      socket.emit('jam_error', { code: 'session_not_found' });
      return socket.disconnect(true);
    }

    // Removed by the host: not back into this Jam.
    if (jamSessions[sessionId]?.removed?.has(userKey(username))) {
      socket.emit('jam_error', { code: 'removed' });
      return socket.disconnect(true);
    }

    socket.join(sessionId);

    if (!jamSessions[sessionId]) {
      // Whoever opens a session is its host. The client's own claim to be
      // the lead is not trusted.
      jamSessions[sessionId] = {
        participants: [],
        lastState: null,
        canGuestsControl: false,
        host: userKey(username)
      };
      console.log(`[Jam] Session created: ${sessionId} by ${username}`);
    }

    const isLead = userKey(username) === jamSessions[sessionId].host;
    const user = {
      id: socket.id,
      name: username,
      isLead,
      joinedAt: Date.now()
    };
    socket.emit('jam_role', { isLead });

    jamSessions[sessionId].participants.push(user);

    // Track socket metadata
    socketMeta[socket.id] = { username, sessionType: 'jam', sessionId };

    // Broadcast updated participant list to everyone in the room
    io.to(sessionId).emit('participants_update', jamSessions[sessionId].participants);
    emitJamStatusForUsers(jamSessions[sessionId].participants.map(p => p.name));

    // If there's an existing playback state, catch the new user up
    if (jamSessions[sessionId].lastState) {
      socket.emit('sync_playback', jamSessions[sessionId].lastState);
      socket.emit('guest_control_update', { canGuestsControl: jamSessions[sessionId].canGuestsControl || false });
    }

    console.log(`[Jam] ${username} joined session ${sessionId} (Lead: ${isLead})`);

    // A friend is waiting to join this Jam: it is open now.
    if (isLead) friends.onJamOpened(sessionId, userKey(username));
    else jamSessions[sessionId].hadGuests = true;
    checkHostPresent(sessionId);
    checkGuestsPresent(sessionId, { immediate: false });

    // The host removes someone (also possible from any of the host's devices
    // through jam_control).
    socket.on('jam_kick', ({ username: target } = {}) => {
      const session = jamSessions[sessionId];
      if (!session || session.host !== userKey(username) || typeof target !== 'string') return;
      kickFromJam(sessionId, userKey(target));
    });

    socket.on('playback_update', (data) => {
      const session = jamSessions[sessionId];
      if (!session) return;
      const sender = session.participants.find(p => p.id === socket.id);
      // Allow lead or guests if canGuestsControl is enabled
      if (sender && (sender.isLead || session.canGuestsControl)) {
        session.lastState = mergePlaybackState(session.lastState, data);
        // Broadcast to others in the same session
        socket.to(sessionId).emit('sync_playback', data);
      }
    });

    socket.on('leave_session', () => {
      const session = jamSessions[sessionId];
      if (session) {
        session.participants = session.participants.filter(p => p.id !== socket.id);
        const names = [username, ...session.participants.map(p => p.name)];
        if (session.participants.length === 0) {
          clearTimeout(session.hostGoneTimer);
          clearTimeout(session.aloneTimer);
          delete jamSessions[sessionId];
        } else {
          io.to(sessionId).emit('participants_update', session.participants);
          checkHostPresent(sessionId);
          checkGuestsPresent(sessionId, { immediate: true });
        }
        emitJamStatusForUsers(names);
      }
      socket.leave(sessionId);
      delete socketMeta[socket.id];
      socket.disconnect(true);
    });

    socket.on('set_guest_control', ({ canControl }) => {
      const session = jamSessions[sessionId];
      if (!session) return;
      const sender = session.participants.find(p => p.id === socket.id);
      if (!sender || !sender.isLead) return;
      session.canGuestsControl = canControl;
      io.to(sessionId).emit('guest_control_update', { canGuestsControl: canControl });
      emitJamStatusForUsers(session.participants.map(p => p.name));
    });

    socket.on('end_session', () => {
      const session = jamSessions[sessionId];
      if (!session) return;
      const sender = session.participants.find(p => p.id === socket.id);
      if (!sender || !sender.isLead) return;
      endJam(sessionId, 'ended by host');
      delete socketMeta[socket.id];
      socket.disconnect(true);
    });

    socket.on('disconnect', (reason) => {
      if (jamSessions[sessionId]) {
        jamSessions[sessionId].participants = jamSessions[sessionId].participants.filter(p => p.id !== socket.id);
        const names = [username, ...jamSessions[sessionId].participants.map(p => p.name)];

        if (jamSessions[sessionId].participants.length === 0) {
          console.log(`[Jam] Session ended: ${sessionId}`);
          clearTimeout(jamSessions[sessionId].hostGoneTimer);
          clearTimeout(jamSessions[sessionId].aloneTimer);
          delete jamSessions[sessionId];
        } else {
          io.to(sessionId).emit('participants_update', jamSessions[sessionId].participants);
          // The host's last device dropped: wait a moment for it, then end.
          checkHostPresent(sessionId);
          // Likewise the last guest's.
          checkGuestsPresent(sessionId, { immediate: false });
        }
        emitJamStatusForUsers(names);
      }
      delete socketMeta[socket.id];
      console.log(`[Jam] ${username} left session ${sessionId}: ${reason}`);
    });
  }
});

// The active device left and did not come back: stop playback everywhere
// rather than start audio on some other device.
function releaseControl(username, deviceKey) {
  const session = privateSessions[username]
  if (!session || session.activeKey !== deviceKey) return
  const stillHere = Array.from(session.devices.values()).some(d => d.key === deviceKey)
  if (stillHere) return
  clearControl(username)
}

// Nobody plays any more: the shared state stops, and every device hears so.
function clearControl(username) {
  const session = privateSessions[username]
  if (!session) return
  clearTimeout(session.releaseTimer)
  session.activeKey = null
  session.releaseTimer = null
  if (session.playbackState) {
    session.playbackState = { ...session.playbackState, isPlaying: false, timestamp: Date.now() }
    for (const [sid] of session.devices) {
      io.to(sid).emit('sync_playback', session.playbackState)
    }
  }
  emitDevicesUpdate(username)
  friends.onPlayback(username)
}

// Safety net: drop device entries whose socket is gone without a disconnect
// event. Sockets that are still connected stay, whatever their heartbeat;
// Socket.IO's own ping already closes dead ones.
setInterval(() => {
  for (const [id, at] of endedSessions) {
    if (Date.now() - at > ENDED_MEMORY_MS) endedSessions.delete(id)
  }
  for (const [username, session] of Object.entries(privateSessions)) {
    let changed = false
    for (const [sid] of session.devices) {
      if (!io.sockets.sockets.has(sid)) {
        session.devices.delete(sid)
        changed = true
      }
    }
    if (session.devices.size === 0) {
      clearTimeout(session.releaseTimer)
      delete privateSessions[username]
      friends.onDisconnect(username)
    } else if (changed) {
      emitDevicesUpdate(username)
    }
  }
}, 30000);

// ── Admin: sync users from Navidrome ──
// The admin's username and password come with the request (sync-users.js
// asks for them) and are used once, to sign in to Navidrome's own API,
// which is the only one that lists users. Nothing is kept.
async function handleUserSync(req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  let body;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10000) throw new Error('too large');
    }
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'bad_request' });
  }
  const { username, password, prune } = body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return reply(400, { error: 'bad_request' });
  }
  if (!NAVIDROME_URL) return reply(500, { error: 'sync_not_configured' });

  try {
    const login = await fetch(`${NAVIDROME_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!login.ok) return reply(401, { error: 'unauthorized' });
    const session = await login.json();
    if (!session.isAdmin) return reply(403, { error: 'not_admin' });

    const list = await fetch(`${NAVIDROME_URL}/api/user?_start=0&_end=100000`, {
      headers: { 'x-nd-authorization': `Bearer ${session.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!list.ok) return reply(502, { error: `navidrome_${list.status}` });
    const users = await list.json();
    if (!Array.isArray(users)) return reply(502, { error: 'navidrome_unexpected' });

    const summary = friends.syncUsers(
      users.map((u) => ({ id: u.id, userName: u.userName })),
      { prune: prune === true },
    );
    console.log(`[Admin] ${username} synced users from Navidrome`);
    return reply(200, { total: users.length, ...summary });
  } catch (err) {
    console.error('[Admin] User sync failed:', err.message);
    return reply(502, { error: 'navidrome_unreachable' });
  }
}

httpServer.listen(7548);

console.log('Aonsoku Jam Sync Server running on port 7548');
