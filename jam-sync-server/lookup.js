const crypto = require('crypto');

// Lookups for the tag editor: MusicBrainz metadata, Cover Art Archive
// images and AcoustID fingerprint matches, fetched here rather than by the
// app so each service gets one identifying client and its rate limit
// (MusicBrainz 1 request a second, AcoustID 3, for the whole server), the
// AcoustID key stays on the server, and the results are cached for everyone.
//
//   musicbrainz(path, query) → { status, body }   path like "release/<mbid>"
//   coverArt(kind, mbid, size) → { status, body, contentType }
//   acoustid(fingerprint, duration) → { status, body: { results } }

const MUSICBRAINZ = 'https://musicbrainz.org/ws/2/';
const COVER_ART = 'https://coverartarchive.org/';
const ACOUSTID = 'https://api.acoustid.org/v2/lookup';
// Cover Art Archive answers with redirects to the Internet Archive.
const IMAGE_HOSTS = [/^coverartarchive\.org$/, /^archive\.org$/, /\.archive\.org$/];

const MB_ENTITIES = ['release', 'release-group', 'recording', 'artist', 'label', 'work'];
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MB_PARAMS = ['query', 'limit', 'offset', 'inc', 'type', 'status', 'release', 'release-group', 'recording', 'artist', 'dismax'];
const COVER_SIZES = ['250', '500', '1200'];

const MB_INTERVAL_MS = 1000;
const ACOUSTID_INTERVAL_MS = 334;
const CACHE_MS = 10 * 60 * 1000;
const MAX_JSON_ENTRIES = 500;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function createLookup({
  userAgent,
  fetchImpl = fetch,
  now = Date.now,
  intervalMs = MB_INTERVAL_MS,
  busyRetryMs = 1500,
  acoustidKey = '',
  acoustidIntervalMs = ACOUSTID_INTERVAL_MS,
} = {}) {
  const json = new Map(); // url -> { until, status, body }
  const images = new Map(); // url -> { until, status, body, contentType }
  let imageBytes = 0;
  // MusicBrainz requests leave one at a time, a second apart.
  let mbQueue = Promise.resolve();
  let lastMb = 0;
  let acoustidQueue = Promise.resolve();
  let lastAcoustid = 0;

  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };

  async function musicbrainz(path, query) {
    const url = musicbrainzUrl(path, query);
    if (typeof url !== 'string') return { status: 400, body: { error: 'VALIDATION_FAILED', message: url.error } };

    const cached = fresh(json, url);
    if (cached) return cached;

    const request = () => {
      const run = mbQueue.then(async () => {
        const wait = lastMb + intervalMs - now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastMb = now();
        return fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      });
      mbQueue = run.catch(() => {});
      return run;
    };

    let res;
    try {
      res = await request();
      // "Busy" is MusicBrainz asking to slow down: one more try, later.
      if (res.status === 503) {
        await new Promise((r) => setTimeout(r, busyRetryMs));
        res = await request();
      }
    } catch {
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    if (res.status === 503) return { status: 503, body: { error: 'MUSICBRAINZ_BUSY' } };
    const body = await res.json().catch(() => null);
    if (!body || (!res.ok && res.status !== 404 && res.status !== 400)) {
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    const result = { status: res.status, body };
    if (res.ok || res.status === 404) remember(json, url, result, MAX_JSON_ENTRIES);
    return result;
  }

  async function coverArt(kind, mbid, size) {
    if (kind !== 'release' && kind !== 'release-group') return { status: 400, body: { error: 'VALIDATION_FAILED' } };
    if (!MBID.test(mbid || '')) return { status: 400, body: { error: 'VALIDATION_FAILED', message: 'not an MBID' } };
    if (!COVER_SIZES.includes(String(size))) {
      return { status: 400, body: { error: 'VALIDATION_FAILED', message: `size must be ${COVER_SIZES.join(', ')}` } };
    }
    const url = `${COVER_ART}${kind}/${mbid}/front-${size}`;
    const cached = fresh(images, url);
    if (cached) return cached;

    let res;
    try {
      res = await fetchFollowing(url);
      // The Internet Archive has bad moments: one more try.
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, busyRetryMs));
        res = await fetchFollowing(url);
      }
    } catch {
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    if (res.status === 404) {
      const result = { status: 404, body: { error: 'NO_COVER' } };
      remember(images, url, { ...result, size: 0 });
      return result;
    }
    if (!res.ok) return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    const body = Buffer.from(await res.arrayBuffer());
    const result = { status: 200, body, contentType };
    rememberImage(url, result);
    return result;
  }

  async function acoustid(fingerprint, duration) {
    if (!acoustidKey) return { status: 404, body: { error: 'NOT_FOUND' } };
    if (typeof fingerprint !== 'string' || !/^[A-Za-z0-9_-]{16,100000}$/.test(fingerprint)) {
      return { status: 400, body: { error: 'VALIDATION_FAILED', message: 'not a fingerprint' } };
    }
    const seconds = Math.round(Number(duration));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 36000) {
      return { status: 400, body: { error: 'VALIDATION_FAILED', message: 'not a duration' } };
    }
    const key = `${seconds}:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
    const cached = fresh(json, key);
    if (cached) return cached;

    const run = acoustidQueue.then(async () => {
      const wait = lastAcoustid + acoustidIntervalMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAcoustid = now();
      return fetchImpl(ACOUSTID, {
        method: 'POST',
        headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client: acoustidKey,
          duration: String(seconds),
          fingerprint,
          meta: 'recordings releases tracks compress',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    });
    acoustidQueue = run.catch(() => {});

    let body;
    try {
      body = await (await run).json();
    } catch {
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    if (body?.status !== 'ok') {
      // A bad key is the server's problem, not the editor's: logged there.
      console.warn('[Tagger] AcoustID refused the lookup:', body?.error?.message);
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    const result = { status: 200, body: { results: trimAcoustid(body.results) } };
    remember(json, key, result, MAX_JSON_ENTRIES);
    return result;
  }

  // Redirects are followed by hand, only to the image hosts.
  async function fetchFollowing(url) {
    let current = url;
    for (let hops = 0; hops < 5; hops++) {
      const host = new URL(current).hostname;
      if (!IMAGE_HOSTS.some((pattern) => pattern.test(host))) throw new Error(`redirect to ${host}`);
      const res = await fetchImpl(current, {
        headers: { 'User-Agent': userAgent },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  }

  function fresh(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.until <= now()) {
      forget(cache, key);
      return null;
    }
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function remember(cache, key, value, maxEntries = Infinity) {
    forget(cache, key);
    cache.set(key, { ...value, until: now() + CACHE_MS });
    while (cache.size > maxEntries) forget(cache, cache.keys().next().value);
  }

  function rememberImage(key, value) {
    if (value.body.length > MAX_IMAGE_BYTES) return;
    remember(images, key, { ...value, size: value.body.length });
    imageBytes += value.body.length;
    while (imageBytes > MAX_IMAGE_BYTES) forget(images, images.keys().next().value);
  }

  function forget(cache, key) {
    const entry = cache.get(key);
    if (!entry) return;
    if (cache === images) imageBytes -= entry.size || 0;
    cache.delete(key);
  }

  return { musicbrainz, coverArt, acoustid };
}

/** AcoustID's matches, best first: each recording with its releases. */
function trimAcoustid(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => Array.isArray(r.recordings))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => ({
      score: r.score,
      recordings: r.recordings.slice(0, 10).map((rec) => ({
        id: rec.id,
        title: rec.title ?? null,
        duration: rec.duration ?? null,
        artists: (rec.artists ?? []).map((a) => ({ name: a.name, joinphrase: a.joinphrase ?? '' })),
        releases: (rec.releases ?? []).slice(0, 25).map((rel) => ({
          id: rel.id,
          title: rel.title ?? null,
          country: rel.country ?? null,
          year: rel.date?.year ?? null,
          trackCount: rel.track_count ?? null,
          mediumCount: rel.medium_count ?? null,
        })),
      })),
    }));
}

/** The MusicBrainz URL for a path and query, or { error } when not allowed. */
function musicbrainzUrl(path, query) {
  const parts = String(path || '').split('/').filter(Boolean);
  const [entity, mbid] = parts;
  if (!MB_ENTITIES.includes(entity) || parts.length > 2) return { error: `can't look up "${path}"` };
  if (mbid !== undefined && !MBID.test(mbid)) return { error: 'not an MBID' };
  const params = new URLSearchParams();
  for (const [key, value] of query) {
    if (!MB_PARAMS.includes(key)) return { error: `parameter "${key}" not allowed` };
    if (value.length > 500) return { error: `parameter "${key}" too long` };
    params.append(key, value);
  }
  if (!mbid && !params.has('query') && !MB_PARAMS.slice(6).some((k) => params.has(k))) {
    return { error: 'a search needs a query' };
  }
  params.set('fmt', 'json');
  return `${MUSICBRAINZ}${entity}${mbid ? `/${mbid}` : ''}?${params}`;
}

module.exports = { createLookup, musicbrainzUrl, trimAcoustid };
