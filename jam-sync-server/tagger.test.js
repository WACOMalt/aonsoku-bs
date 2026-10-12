// node --test: the tagger's routes, with a fake Navidrome and a fake plugin.
const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');
const { createTagger, validateItems } = require('./tagger');

const SECRET = 'test-secret-0123456789';
const USERS = { admin: { password: 'adminpw', admin: true }, guest: { password: 'guestpw', admin: false } };

let navidrome;
let server;
let base;

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

before(async () => {
  // Navidrome: ping checks the password, getUser says whether it's an admin.
  navidrome = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const user = USERS[url.searchParams.get('u')];
    const ok = user && user.password === url.searchParams.get('p');
    const body = !ok
      ? { status: 'failed', error: { code: 40 } }
      : url.pathname.startsWith('/rest/getUser')
        ? { status: 'ok', user: { username: url.searchParams.get('username'), adminRole: user.admin } }
        : { status: 'ok' };
    res.end(JSON.stringify({ 'subsonic-response': body }));
  });
  const navidromeUrl = `http://127.0.0.1:${await listen(navidrome)}`;

  server = http.createServer((req, res) => {
    if (!tagger.handleHttp(req, res)) res.writeHead(404).end();
  });
  const tagger = createTagger({
    httpServer: server,
    navidromeUrl,
    secret: SECRET,
    log: { log() {}, warn() {} },
    // Lookups answer from here, without going online.
    lookup: {
      musicbrainz: async (path, params) => ({ status: 200, body: { path, query: params.get('query') } }),
      coverArt: async () => ({ status: 200, body: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }),
    },
    verifyWithNavidrome: async (creds) => {
      const res = await fetch(`${navidromeUrl}/rest/ping?u=${creds.u}&p=${creds.p}`);
      return (await res.json())['subsonic-response'].status === 'ok';
    },
  });
  base = `127.0.0.1:${await listen(server)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  navidrome.close();
});

function connectPlugin(secret = SECRET) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/jam-sync/tagger/plugin`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    ws.on('message', (data) => {
      if (JSON.parse(data).type === 'welcome') {
        ws.send(JSON.stringify({ type: 'hello', version: '9.9.9', libraries: [{ id: 1, name: 'Music', writable: true }] }));
        // Give the server a moment to read the hello.
        setTimeout(() => resolve(ws), 50);
      }
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const capabilities = async () => (await fetch(`http://${base}/jam-sync/tagger/capabilities`)).json();

function write(body) {
  return fetch(`http://${base}/jam-sync/tagger/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const admin = { u: 'admin', p: 'adminpw' };
const items = [
  { songId: 'a', tags: { title: 'New', trackNumber: '3/12' } },
  { songId: 'b', tags: { genre: '' } },
];

test('a plugin with the wrong secret is refused', async () => {
  await assert.rejects(connectPlugin('wrong-secret-0123456789'), /HTTP 401/);
  assert.equal((await capabilities()).enabled, false);
});

test('writes need a plugin, valid credentials and an admin', async () => {
  assert.equal((await write({ items })).status, 401);
  assert.equal((await write({ auth: { u: 'admin', p: 'nope' }, items })).status, 401);
  assert.equal((await write({ auth: { u: 'guest', p: 'guestpw' }, items })).status, 403);
  assert.equal((await write({ auth: admin, items: [] })).status, 400);
  assert.deepEqual((await write({ auth: admin, items })).body, { error: 'TAGGER_UNAVAILABLE' });
});

test('a batch goes to the plugin and comes back one result per song', async () => {
  const plugin = await connectPlugin();
  const caps = await capabilities();
  assert.equal(caps.enabled, true);
  assert.equal(caps.features.write, true);
  assert.equal(caps.pluginVersion, '9.9.9');

  let job;
  plugin.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.type !== 'write') return;
    job = message;
    plugin.send(JSON.stringify({ type: 'result', jobId: message.jobId, songId: 'a', ok: true }));
    plugin.send(JSON.stringify({ type: 'result', jobId: message.jobId, songId: 'b', ok: false, error: 'FILE_NOT_FOUND' }));
    plugin.send(JSON.stringify({ type: 'done', jobId: message.jobId, scanTriggered: true }));
  });

  const res = await write({ auth: admin, items });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    results: [
      { songId: 'a', ok: true },
      { songId: 'b', ok: false, error: 'FILE_NOT_FOUND' },
    ],
    scanTriggered: true,
  });
  // The plugin gets the editor's credentials to check them itself.
  assert.deepEqual(job.auth, admin);
  assert.deepEqual(job.items, items);
  plugin.close();
});

test('a shared cover goes to the plugin once, with the folder choice', async () => {
  const plugin = await connectPlugin();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  let job;
  plugin.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.type !== 'write') return;
    job = message;
    for (const item of message.items) {
      plugin.send(JSON.stringify({ type: 'result', jobId: message.jobId, songId: item.songId, ok: true }));
    }
    plugin.send(JSON.stringify({ type: 'done', jobId: message.jobId, scanTriggered: true }));
  });
  const cover = { mimeType: 'image/jpeg', dataBase64: jpeg };
  const res = await write({
    auth: admin,
    folderCover: true,
    items: [
      { songId: 'a', cover },
      { songId: 'b', tags: { title: 'B' }, cover },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(Object.keys(job.covers).length, 1);
  const [coverId] = Object.keys(job.covers);
  assert.deepEqual(job.covers[coverId], { mimeType: 'image/jpeg', data: jpeg });
  assert.deepEqual(job.items, [
    { songId: 'a', tags: {}, coverId },
    { songId: 'b', tags: { title: 'B' }, coverId },
  ]);
  assert.equal(job.folderCover, true);
  plugin.close();
});

test('covers must be JPEG or PNG images under 15 MB', () => {
  const item = (cover) => [{ songId: 'a', cover }];
  assert.match(validateItems(item({ mimeType: 'image/gif', dataBase64: 'R0lGOD' })), /JPEG or PNG/);
  assert.match(validateItems(item({ mimeType: 'image/png', dataBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') })), /not a image\/png/);
  assert.match(validateItems(item({ mimeType: 'image/jpeg', dataBase64: Buffer.alloc(16 * 1024 * 1024, 0xff).toString('base64') })), /over 15 MB/);
});

test('a plugin that goes away fails the batch in progress', async () => {
  const plugin = await connectPlugin();
  plugin.on('message', (data) => {
    if (JSON.parse(data).type === 'write') plugin.terminate();
  });
  const res = await write({ auth: admin, items });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'PLUGIN_DISCONNECTED');
});

test('lookups are for admins, signed in by header', async () => {
  const get = (path, auth) =>
    fetch(`http://${base}/jam-sync/tagger/${path}`, {
      headers: auth ? { 'X-Tagger-Auth': Buffer.from(JSON.stringify(auth)).toString('base64') } : {},
    });
  assert.equal((await get('musicbrainz/release?query=x')).status, 401);
  assert.equal((await get('musicbrainz/release?query=x', { u: 'guest', p: 'guestpw' })).status, 403);
  assert.equal((await get('musicbrainz/release?query=x', { u: 'admin', p: 'wrong' })).status, 401);
  const res = await get('musicbrainz/release?query=x', admin);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: 'release', query: 'x' });
  const cover = await get(`coverart/release/0f6f8e47-cb6d-4d7a-8e4a-d1b0d9c4d4b4?size=250`, admin);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff]));
});

test('items are checked before anything is sent', () => {
  assert.match(validateItems([{ songId: 'a', tags: { mood: 'x' } }]), /unknown tag field/);
  assert.match(validateItems([{ songId: 'a', tags: { title: 3 } }]), /must be text/);
  assert.match(validateItems([{ songId: 'a', tags: {} }]), /nothing to change/);
  assert.match(validateItems([items[0], items[0]]), /listed twice/);
  assert.match(validateItems(Array.from({ length: 501 }, (_, i) => ({ songId: `${i}`, tags: { title: 'x' } }))), /at most 500/);
  assert.deepEqual(validateItems(items), items);
});
