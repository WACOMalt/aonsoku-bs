// node --test: MusicBrainz and Cover Art Archive lookups, against a fake upstream.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLookup, musicbrainzUrl } = require('./lookup');

const MBID = '0f6f8e47-cb6d-4d7a-8e4a-d1b0d9c4d4b4';

/** A fake fetch: answers from `routes` (url → [status, body, headers]), and records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, at: Date.now(), headers: options.headers });
    const [status, body, headers = {}] = routes[url] ?? [404, { error: 'not found' }];
    const isImage = Buffer.isBuffer(body);
    return new Response(isImage ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': isImage ? 'image/jpeg' : 'application/json', ...headers },
    });
  };
  return { impl, calls };
}

const query = (entries) => new URLSearchParams(entries);

test('only known MusicBrainz lookups are let through', () => {
  assert.equal(
    musicbrainzUrl('release', query({ query: 'album:"OK Computer"', limit: '5' })),
    'https://musicbrainz.org/ws/2/release?query=album%3A%22OK+Computer%22&limit=5&fmt=json',
  );
  assert.equal(
    musicbrainzUrl(`release/${MBID}`, query({ inc: 'recordings+artist-credits' })),
    `https://musicbrainz.org/ws/2/release/${MBID}?inc=recordings%2Bartist-credits&fmt=json`,
  );
  assert.ok(musicbrainzUrl('user/someone', query({})).error, 'not an allowed entity');
  assert.ok(musicbrainzUrl('release/../../admin', query({})).error, 'no path tricks');
  assert.ok(musicbrainzUrl('release/not-an-mbid', query({})).error);
  assert.ok(musicbrainzUrl('release', query({ query: 'x', callback: 'evil' })).error, 'unknown parameter');
  assert.ok(musicbrainzUrl('release', query({})).error, 'a search needs a query');
});

test('MusicBrainz gets one request a second, an identifying User-Agent, and a cache', async () => {
  const a = musicbrainzUrl('release', query({ query: 'a' }));
  const b = musicbrainzUrl('release', query({ query: 'b' }));
  const { impl, calls } = fakeFetch({ [a]: [200, { releases: ['a'] }], [b]: [200, { releases: ['b'] }] });
  const lookup = createLookup({ userAgent: 'Test/1 ( test )', fetchImpl: impl, intervalMs: 150 });

  const [ra, rb] = await Promise.all([
    lookup.musicbrainz('release', query({ query: 'a' })),
    lookup.musicbrainz('release', query({ query: 'b' })),
  ]);
  assert.deepEqual([ra.body, rb.body], [{ releases: ['a'] }, { releases: ['b'] }]);
  assert.ok(calls[1].at - calls[0].at >= 140, 'spaced out');
  assert.equal(calls[0].headers['User-Agent'], 'Test/1 ( test )');

  await lookup.musicbrainz('release', query({ query: 'a' }));
  assert.equal(calls.length, 2, 'the repeat came from the cache');
});

test('"slow down" answers are not cached', async () => {
  const url = musicbrainzUrl('release', query({ query: 'busy' }));
  const { impl, calls } = fakeFetch({ [url]: [503, { error: 'rate limited' }] });
  const lookup = createLookup({ userAgent: 'Test', fetchImpl: impl, intervalMs: 0 });
  assert.equal((await lookup.musicbrainz('release', query({ query: 'busy' }))).status, 503);
  await lookup.musicbrainz('release', query({ query: 'busy' }));
  assert.equal(calls.length, 2);
});

test('covers follow redirects to the Internet Archive only', async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const { impl, calls } = fakeFetch({
    [`https://coverartarchive.org/release/${MBID}/front-500`]: [307, {}, { location: 'https://ia800.us.archive.org/x/front-500.jpg' }],
    'https://ia800.us.archive.org/x/front-500.jpg': [200, image],
    [`https://coverartarchive.org/release-group/${MBID}/front-250`]: [302, {}, { location: 'https://evil.example/steal' }],
  });
  const lookup = createLookup({ userAgent: 'Test', fetchImpl: impl, intervalMs: 0 });

  const cover = await lookup.coverArt('release', MBID, '500');
  assert.equal(cover.status, 200);
  assert.deepEqual(cover.body, image);
  assert.equal(cover.contentType, 'image/jpeg');
  await lookup.coverArt('release', MBID, '500');
  assert.equal(calls.length, 2, 'cached');

  assert.equal((await lookup.coverArt('release-group', MBID, '250')).status, 502, 'not followed off the archive');
  assert.ok(!calls.some((c) => c.url.includes('evil')));
});

test('a release without a cover says so, and bad requests are refused', async () => {
  const { impl } = fakeFetch({});
  const lookup = createLookup({ userAgent: 'Test', fetchImpl: impl, intervalMs: 0 });
  assert.deepEqual(await lookup.coverArt('release', MBID, '500'), { status: 404, body: { error: 'NO_COVER' } });
  assert.equal((await lookup.coverArt('release', MBID, '999')).status, 400);
  assert.equal((await lookup.coverArt('artist', MBID, '500')).status, 400);
  assert.equal((await lookup.coverArt('release', 'nope', '500')).status, 400);
});
