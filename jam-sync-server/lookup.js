// Lookups for the tag editor: MusicBrainz metadata and Cover Art Archive
// images, fetched here rather than by the app so MusicBrainz gets one
// identifying User-Agent and its rate limit (1 request a second for the
// whole server), and the results are cached for everyone.
//
//   musicbrainz(path, query) → { status, body }   path like "release/<mbid>"
//   coverArt(kind, mbid, size) → { status, body, contentType }

const MUSICBRAINZ = 'https://musicbrainz.org/ws/2/';
const COVER_ART = 'https://coverartarchive.org/';
// Cover Art Archive answers with redirects to the Internet Archive.
const IMAGE_HOSTS = [/^coverartarchive\.org$/, /^archive\.org$/, /\.archive\.org$/];

const MB_ENTITIES = ['release', 'release-group', 'recording', 'artist', 'label', 'work'];
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MB_PARAMS = ['query', 'limit', 'offset', 'inc', 'type', 'status', 'release', 'release-group', 'recording', 'artist', 'dismax'];
const COVER_SIZES = ['250', '500', '1200'];

const MB_INTERVAL_MS = 1000;
const CACHE_MS = 10 * 60 * 1000;
const MAX_JSON_ENTRIES = 500;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function createLookup({ userAgent, fetchImpl = fetch, now = Date.now, intervalMs = MB_INTERVAL_MS } = {}) {
  const json = new Map(); // url -> { until, status, body }
  const images = new Map(); // url -> { until, status, body, contentType }
  let imageBytes = 0;
  // MusicBrainz requests leave one at a time, a second apart.
  let mbQueue = Promise.resolve();
  let lastMb = 0;

  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };

  async function musicbrainz(path, query) {
    const url = musicbrainzUrl(path, query);
    if (typeof url !== 'string') return { status: 400, body: { error: 'VALIDATION_FAILED', message: url.error } };

    const cached = fresh(json, url);
    if (cached) return cached;

    const run = mbQueue.then(async () => {
      const wait = lastMb + intervalMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastMb = now();
      return fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    });
    mbQueue = run.catch(() => {});

    let res;
    try {
      res = await run;
    } catch {
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    const body = await res.json().catch(() => null);
    if (!body) return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    const result = { status: res.status, body };
    // Only answers worth keeping: not "slow down" or server errors.
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

  return { musicbrainz, coverArt };
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

module.exports = { createLookup, musicbrainzUrl };
