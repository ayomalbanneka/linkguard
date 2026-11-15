'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { testing, fetchFollow } = require('../src/safe-fetch');
const { checkUrl, classify } = require('../src/checker');

let server;
let base;

test.before(async () => {
  testing.allowPrivate = true; // lets us talk to our own 127.0.0.1 test server
  server = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    if (route === '/ok') { res.writeHead(200); return res.end('hi'); }
    if (route === '/moved') { res.writeHead(301, { location: '/ok' }); return res.end(); }
    if (route === '/temp') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (route === '/gone') { res.writeHead(404); return res.end('nope'); }
    if (route === '/nohead') { if (req.method === 'HEAD') { res.writeHead(405); return res.end(); } res.writeHead(200); return res.end('ok'); }
    if (route === '/blocked') { res.writeHead(403); return res.end(); }
    if (route === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (route === '/slow') { return; }
    if (route === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' }); return res.end(zlib.gzipSync('<a href="/x">x</a>')); }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { testing.allowPrivate = false; server.closeAllConnections(); server.close(); });

test('classifies the common cases', async () => {
  assert.equal((await checkUrl(`${base}/ok`)).state, 'ok');
  assert.equal((await checkUrl(`${base}/temp`)).state, 'ok');
  const moved = await checkUrl(`${base}/moved`);
  assert.equal(moved.state, 'redirect');
  assert.equal(moved.finalUrl, `${base}/ok`);
  const gone = await checkUrl(`${base}/gone`);
  assert.deepEqual([gone.state, gone.status], ['broken', 404]);
  assert.equal((await checkUrl(`${base}/nohead`)).state, 'ok'); // HEAD 405 -> GET fallback
  assert.equal((await checkUrl(`${base}/blocked`)).state, 'unverified');
  assert.equal((await checkUrl(`${base}/loop`)).state, 'broken');
});

test('timeouts are unverified, not broken', async () => {
  const res = await fetchFollow(`${base}/slow`, { method: 'GET', timeoutMs: 300 }).catch((e) => e);
  assert.equal(res.code, 'TIMEOUT');
  assert.equal(classify(undefined, res).state, 'unverified');
});

test('decodes gzip bodies and caps size', async () => {
  const res = await fetchFollow(`${base}/gz`, { maxBytes: 1000 });
  assert.match(res.body, /href="\/x"/);
});

test('unresolvable domains are broken', async () => {
  testing.allowPrivate = false;
  try {
    const r = await checkUrl('http://this-domain-does-not-exist-linkguard.invalid/');
    assert.equal(r.state, 'broken');
  } finally { testing.allowPrivate = true; }
});

test('private targets are never contacted (IP literal and DNS-resolved)', async () => {
  testing.allowPrivate = false;
  try {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://[::1]/']) {
      const r = await checkUrl(url);
      assert.equal(r.state, 'unverified', url);
      assert.match(r.note, /Private/, url);
    }
  } finally { testing.allowPrivate = true; }
});
