// Tag editor: the Aonsoku-BS app sends tag edits here, and the Navidrome
// plugin (aonsoku-bs-tagger, running next to the music) writes them.
//
// Plugins can't receive requests, so the plugin connects to us over a
// WebSocket (/jam-sync/tagger/plugin, authenticated with
// TAGGER_PLUGIN_SECRET) and we pass it each batch of edits. Only Navidrome
// admins may edit: their Subsonic credentials are checked here and again
// by the plugin.
//
// Routes (all under /jam-sync/tagger):
//   GET  /capabilities  no auth; what the app may show
//   GET  /musicbrainz/<entity>[/<mbid>]?query…   MusicBrainz, as JSON
//   GET  /coverart/<release|release-group>/<mbid>?size=250|500|1200
//                       the front cover, from Cover Art Archive
//   POST /acoustid/lookup { fingerprint, duration }: AcoustID's matches
//                       (only with ACOUSTID_API_KEY)
//   POST /write         { auth: <Subsonic credentials>, items: [...],
//                         folderCover?: also replace each folder's cover image }
//                       item: { songId, tags?: {...}, cover?: { mimeType, dataBase64 } }
//
// The lookups (GET) take the credentials as base64 JSON in an X-Tagger-Auth
// header, so they stay out of URLs and logs. Everything but /capabilities
// is for Navidrome admins only.

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createLookup } = require('./lookup');

const PLUGIN_PATH = '/jam-sync/tagger/plugin';
const ROUTE_PREFIX = '/jam-sync/tagger/';
const MAX_ITEMS = 500;
const MAX_COVER_BYTES = 15 * 1024 * 1024;
// A few covers, in base64.
const MAX_BODY_BYTES = 24 * 1024 * 1024;
// A batch fails when the plugin stays silent this long (it reports each
// file as it goes, so a long batch keeps it alive).
const ITEM_SILENCE_MS = 90 * 1000;
// A checked admin is trusted this long for lookups (browsing results), so
// losing the admin flag takes effect within a minute.
const ADMIN_CACHE_MS = 60 * 1000;
const TAG_FIELDS = [
  'title',
  'artist',
  'albumArtist',
  'album',
  'trackNumber',
  'discNumber',
  'year',
  'genre',
];

function createTagger({
  httpServer,
  navidromeUrl,
  verifyWithNavidrome,
  secret,
  userAgent = 'Aonsoku-BS-Tagger/1 ( https://github.com/WACOMalt/aonsoku-bs )',
  acoustidKey = '',
  lookup = createLookup({ userAgent, acoustidKey }),
  log = console,
}) {
  let plugin = null; // { socket, version, libraries }
  const admins = new Map(); // credentials hash -> trusted until
  const jobs = new Map(); // jobId -> { results, resolve, reject, timer }
  // Batches go to the plugin one at a time.
  let queue = Promise.resolve();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    if (pathOf(req.url) !== PLUGIN_PATH) return; // socket.io's own
    if (!secret || !sameSecret(req.headers.authorization, secret)) {
      log.warn('[Tagger] Refused a plugin connection: wrong or missing secret');
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onPlugin(ws, req));
  });

  function onPlugin(ws, req) {
    if (plugin) plugin.socket.close(1000, 'Replaced by a new connection');
    const current = { socket: ws, version: req.headers['x-tagger-version'] || null, libraries: [] };
    plugin = current;
    log.log(`[Tagger] Plugin connected (version ${current.version})`);
    send(ws, { type: 'welcome' });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === 'ping') send(ws, { type: 'pong' });
      else if (message.type === 'hello') {
        current.version = message.version || current.version;
        current.libraries = Array.isArray(message.libraries) ? message.libraries : [];
        const writable = current.libraries.filter((l) => l.writable).length;
        log.log(`[Tagger] Plugin ${current.version}: ${current.libraries.length} libraries, ${writable} writable`);
      } else if (message.type === 'result') onResult(message);
      else if (message.type === 'done') onDone(message);
    });
    ws.on('close', () => {
      if (plugin === current) {
        plugin = null;
        log.log('[Tagger] Plugin disconnected');
        // Batches in progress can't finish now.
        for (const [jobId, job] of jobs) finishJob(jobId, job, new Error('PLUGIN_DISCONNECTED'));
      }
    });
    ws.on('error', (err) => log.warn('[Tagger] Plugin socket error:', err.message));
  }

  function capabilities() {
    const writable = !!plugin && plugin.libraries.some((l) => l.writable);
    return {
      enabled: !!plugin,
      pluginVersion: plugin?.version ?? null,
      features: { write: writable, lookup: !!secret, fingerprint: !!secret && !!acoustidKey },
      libraries: plugin?.libraries ?? [],
    };
  }

  // ── Write ──

  async function write(body) {
    const auth = body?.auth;
    if (!isCredentials(auth)) return [401, { error: 'UNAUTHORIZED' }];
    const items = validateItems(body?.items, body?.covers);
    if (typeof items === 'string') return [400, { error: 'VALIDATION_FAILED', message: items }];

    let ok;
    try {
      ok = await verifyWithNavidrome(auth);
    } catch {
      return [503, { error: 'NAVIDROME_UNAVAILABLE' }];
    }
    if (!ok) return [401, { error: 'UNAUTHORIZED' }];
    if (!(await isAdmin(auth))) return [403, { error: 'FORBIDDEN' }];
    if (!plugin) return [503, { error: 'TAGGER_UNAVAILABLE' }];

    const folderCover = body.folderCover === true;
    const run = queue.then(() => runJob(auth, items, folderCover));
    queue = run.catch(() => {});
    try {
      return [200, await run];
    } catch (err) {
      return [503, { error: err.message || 'TAGGER_UNAVAILABLE' }];
    }
  }

  function runJob(auth, items, folderCover) {
    if (!plugin) return Promise.reject(new Error('TAGGER_UNAVAILABLE'));
    const jobId = crypto.randomUUID();
    // An album's songs usually share one cover: it goes to the plugin once.
    const covers = {};
    const ids = new Map();
    const plain = items.map(({ songId, tags, cover }) => {
      if (!cover) return { songId, tags };
      if (!ids.has(cover)) {
        ids.set(cover, crypto.createHash('sha256').update(cover.dataBase64).digest('hex').slice(0, 16));
      }
      const coverId = ids.get(cover);
      covers[coverId] = { mimeType: cover.mimeType, data: cover.dataBase64 };
      return { songId, tags, coverId };
    });
    const coverCount = Object.keys(covers).length;
    log.log(
      `[Tagger] ${auth.u} edits ${items.length} song(s)` +
        (coverCount ? ` with ${coverCount} cover(s)${folderCover ? ' and folder images' : ''}` : '') +
        ` (job ${jobId})`,
    );
    return new Promise((resolve, reject) => {
      const job = { results: new Map(), resolve, reject, timer: null };
      jobs.set(jobId, job);
      arm(jobId, job);
      send(plugin.socket, {
        type: 'write',
        jobId,
        auth: pickCredentials(auth),
        items: plain,
        covers,
        folderCover,
      });
    }).then(({ results, scanTriggered }) => ({
      // One result per song, in the order asked, failures included.
      results: items.map(
        (item) => results.get(item.songId) ?? { songId: item.songId, ok: false, error: 'WRITE_FAILED' },
      ),
      scanTriggered,
    }));
  }

  function arm(jobId, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => finishJob(jobId, job, new Error('TAGGER_TIMEOUT')), ITEM_SILENCE_MS);
  }

  function onResult(message) {
    const job = jobs.get(message.jobId);
    if (!job || typeof message.songId !== 'string') return;
    job.results.set(message.songId, {
      songId: message.songId,
      ok: message.ok === true,
      ...(message.ok === true ? {} : { error: String(message.error || 'WRITE_FAILED') }),
    });
    arm(message.jobId, job);
  }

  function onDone(message) {
    const job = jobs.get(message.jobId);
    if (job) finishJob(message.jobId, job, null, message.scanTriggered === true);
  }

  function finishJob(jobId, job, error, scanTriggered = false) {
    clearTimeout(job.timer);
    jobs.delete(jobId);
    if (error) job.reject(error);
    else job.resolve({ results: job.results, scanTriggered });
  }

  /** For lookups: null when the header carries an admin, else the refusal. */
  async function checkHeaderAuth(req) {
    let auth;
    try {
      auth = JSON.parse(Buffer.from(String(req.headers['x-tagger-auth'] || ''), 'base64').toString());
    } catch {
      auth = null;
    }
    if (!isCredentials(auth)) return [401, { error: 'UNAUTHORIZED' }];
    const key = crypto.createHash('sha256').update(JSON.stringify(pickCredentials(auth))).digest('hex');
    if ((admins.get(key) ?? 0) > Date.now()) return null;
    let ok;
    try {
      ok = await verifyWithNavidrome(auth);
    } catch {
      return [503, { error: 'NAVIDROME_UNAVAILABLE' }];
    }
    if (!ok) return [401, { error: 'UNAUTHORIZED' }];
    if (!(await isAdmin(auth))) return [403, { error: 'FORBIDDEN' }];
    admins.set(key, Date.now() + ADMIN_CACHE_MS);
    for (const [k, until] of admins) if (until <= Date.now()) admins.delete(k);
    return null;
  }

  async function handleLookup(req, res, route, params) {
    const refused = await checkHeaderAuth(req);
    if (refused) return json(res, ...refused);
    if (route === 'acoustid/lookup') {
      const body = await readJson(req);
      const { status, body: reply } = await lookup.acoustid(body?.fingerprint, body?.duration);
      return json(res, status, reply);
    }
    if (route.startsWith('musicbrainz/')) {
      const { status, body } = await lookup.musicbrainz(route.slice('musicbrainz/'.length), params);
      return json(res, status, body);
    }
    const [, kind, mbid] = route.split('/');
    const result = await lookup.coverArt(kind, mbid, params.get('size') || '500');
    if (!Buffer.isBuffer(result.body)) return json(res, result.status, result.body);
    res.writeHead(200, { 'Content-Type': result.contentType, 'Cache-Control': 'private, max-age=600' });
    res.end(result.body);
  }

  async function isAdmin(auth) {
    const params = credentialParams(auth);
    params.set('username', auth.u);
    try {
      const res = await fetch(`${navidromeUrl}/rest/getUser.view?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json();
      return body?.['subsonic-response']?.user?.adminRole === true;
    } catch {
      return false;
    }
  }

  // ── HTTP ──

  /** Handles /jam-sync/tagger/* requests; false for anything else. */
  function handleHttp(req, res) {
    const path = pathOf(req.url);
    if (!path.startsWith(ROUTE_PREFIX) || path === PLUGIN_PATH) return false;
    // The apps call from their own origins (the web app, desktop, Android).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tagger-Auth');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }
    const route = path.slice(ROUTE_PREFIX.length);
    if (req.method === 'GET' && route === 'capabilities') {
      json(res, 200, capabilities());
    } else if (
      secret &&
      ((req.method === 'GET' && (route.startsWith('musicbrainz/') || route.startsWith('coverart/'))) ||
        (req.method === 'POST' && route === 'acoustid/lookup' && acoustidKey))
    ) {
      const params = new URL(req.url, 'http://x').searchParams;
      handleLookup(req, res, route, params).catch((err) => {
        log.warn('[Tagger] Lookup failed:', err.message);
        if (!res.headersSent) json(res, 502, { error: 'UPSTREAM_UNAVAILABLE' });
      });
    } else if (req.method === 'POST' && route === 'write') {
      readJson(req)
        .then((body) => write(body))
        .then(([status, payload]) => json(res, status, payload))
        .catch((err) => json(res, err.status || 400, { error: 'VALIDATION_FAILED', message: err.message }));
    } else {
      json(res, 404, { error: 'NOT_FOUND' });
    }
    return true;
  }

  return { handleHttp, capabilities, close: () => wss.close() };
}

// ── Helpers ──

function pathOf(url) {
  return (url || '').split('?')[0];
}

function sameSecret(header, secret) {
  const given = Buffer.from(String(header || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function isCredentials(auth) {
  if (!auth || typeof auth.u !== 'string' || !auth.u) return false;
  const token = typeof auth.t === 'string' && auth.t && typeof auth.s === 'string' && auth.s;
  return Boolean(token || (typeof auth.p === 'string' && auth.p));
}

function pickCredentials(auth) {
  return auth.t && auth.s ? { u: auth.u, t: auth.t, s: auth.s } : { u: auth.u, p: auth.p };
}

function credentialParams(auth) {
  const params = new URLSearchParams({ u: auth.u, v: '1.16.1', c: 'aonsoku-bs-tagger', f: 'json' });
  for (const [key, value] of Object.entries(pickCredentials(auth))) if (key !== 'u') params.set(key, value);
  return params;
}

/**
 * The items, or why they are refused. An item's cover is either the image
 * itself or the key of one in `covers`, so an album's songs can share one
 * upload (older apps send the image with every song).
 */
function validateItems(items, covers) {
  if (!Array.isArray(items) || items.length === 0) return 'items must be a non-empty list';
  if (items.length > MAX_ITEMS) return `at most ${MAX_ITEMS} items per request`;
  const shared = new Map();
  const coverOf = (ref) => {
    if (typeof ref !== 'string') return validateCover(ref);
    const upload = covers && typeof covers === 'object' && Object.hasOwn(covers, ref) ? covers[ref] : null;
    if (!upload) return `there is no cover "${ref}"`;
    if (!shared.has(ref)) shared.set(ref, validateCover(upload));
    return shared.get(ref);
  };
  const seen = new Set();
  const clean = [];
  for (const item of items) {
    if (!item || typeof item.songId !== 'string' || !item.songId) return 'every item needs a songId';
    if (seen.has(item.songId)) return `song ${item.songId} is listed twice`;
    seen.add(item.songId);
    const tags = {};
    for (const [field, value] of Object.entries(item.tags || {})) {
      if (!TAG_FIELDS.includes(field)) return `unknown tag field "${field}"`;
      if (typeof value !== 'string' || value.length > 1000) return `"${field}" must be text`;
      tags[field] = value;
    }
    const cover = item.cover == null ? null : coverOf(item.cover);
    if (typeof cover === 'string') return `song ${item.songId}: ${cover}`;
    if (Object.keys(tags).length === 0 && !cover) return `nothing to change for song ${item.songId}`;
    clean.push(cover ? { songId: item.songId, tags, cover } : { songId: item.songId, tags });
  }
  return clean;
}

/** A cover to embed (a JPEG or PNG, by its first bytes), or why not. */
function validateCover(cover) {
  if (typeof cover !== 'object' || typeof cover.dataBase64 !== 'string') return 'the cover needs dataBase64';
  if (cover.mimeType !== 'image/jpeg' && cover.mimeType !== 'image/png') return 'covers must be JPEG or PNG';
  const data = Buffer.from(cover.dataBase64, 'base64');
  if (data.length === 0) return 'the cover is empty';
  if (data.length > MAX_COVER_BYTES) return 'the cover is over 15 MB';
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (cover.mimeType === 'image/png' ? !isPng : !isJpeg) return `the cover is not a ${cover.mimeType} image`;
  // Re-encoded, so the plugin gets plain base64 whatever was sent.
  return { mimeType: cover.mimeType, dataBase64: data.toString('base64') };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('the body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

module.exports = { createTagger, validateItems, TAG_FIELDS };
