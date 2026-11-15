'use strict';

/**
 * A small HTTP client for fetching URLs that strangers typed into a form.
 *
 * Why not global fetch()? A Lambda function can reach its own runtime API on
 * localhost and the VPC/metadata ranges, so user-supplied URLs must never reach
 * private addresses. We check the address at connect time (inside a custom DNS
 * `lookup`), which also defeats DNS-rebinding, and re-check on every redirect.
 */

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');

const USER_AGENT = 'LinkGuard/1.0 (serverless link checker)';
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REDIRECTS = 5;

/** Test hook only: lets unit tests talk to a server on 127.0.0.1. Never set in Lambda. */
const testing = { allowPrivate: false };

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------- IP checks
function isPrivateIPv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIPv6(ip) {
  let s = ip.split('%')[0].toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateIPv6(ip) {
  const g = parseIPv6(ip);
  if (!g) return true; // can't parse: refuse
  const zeroTo = (n) => g.slice(0, n).every((x) => x === 0);
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (zeroTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (zeroTo(5) && g[5] === 0xffff) return isPrivateIPv4(v4); // ::ffff:a.b.c.d
  if (zeroTo(6)) return isPrivateIPv4(v4); // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(v4); // NAT64
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation range
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

// ------------------------------------------------------------- DNS guard
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!testing.allowPrivate) {
      const bad = addresses.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(codedError('BLOCKED', 'Private network addresses are not checked'));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Validate a user-supplied URL before we start any work. Returns the parsed URL. */
async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw codedError('INVALID_URL', 'Enter a full URL, like https://docs.example.com/');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw codedError('INVALID_URL', 'Only http and https URLs can be checked.');
  }
  if (u.username || u.password) throw codedError('INVALID_URL', 'URLs with a username or password are not supported.');
  if (!testing.allowPrivate && !ALLOWED_PORTS.has(u.port)) {
    throw codedError('PORT', 'Only the standard web ports (80, 443, 8080, 8443) can be checked.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const blocked = () => codedError('BLOCKED', 'That address is on a private network. Enter a public website.');
  if (net.isIP(host)) {
    if (!testing.allowPrivate && isPrivateAddress(host)) throw blocked();
    return u;
  }
  if (!testing.allowPrivate && /(^|\.)(localhost|local|internal)$/i.test(host)) throw blocked();
  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    throw codedError('ENOTFOUND', `Could not find ${host}. Check the spelling.`);
  }
  if (!testing.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) throw blocked();
  return u;
}

// ---------------------------------------------------------------- request
function request(rawUrl, { method = 'GET', timeoutMs = 8000, maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return reject(codedError('INVALID_URL', 'Invalid URL'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(codedError('INVALID_URL', 'Not an http(s) link'));
    if (!testing.allowPrivate && !ALLOWED_PORTS.has(u.port)) return reject(codedError('PORT', `Port ${u.port} is not checked`));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!testing.allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
      return reject(codedError('BLOCKED', 'Private network addresses are not checked'));
    }

    let settled = false;
    let timer;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method,
        lookup: guardedLookup,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const base = { status: res.statusCode, headers: res.headers, contentType: String(res.headers['content-type'] || '') };
        res.on('error', (e) => done(e));
        if (method === 'HEAD' || !maxBytes) {
          res.destroy();
          return done(null, { ...base, body: '' });
        }

        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') stream = res.pipe(zlib.createUnzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          res.destroy();
          done(null, { ...base, body: Buffer.concat(chunks).toString('utf8'), truncated });
        };
        stream.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            finish();
          } else {
            chunks.push(chunk);
          }
        });
        stream.on('end', finish);
        stream.on('error', (e) => done(e));
      },
    );
    timer = setTimeout(() => {
      const e = codedError('TIMEOUT', 'Timed out');
      req.destroy(e);
      done(e);
    }, timeoutMs);
    req.on('error', (e) => done(e));
    req.end();
  });
}

/** Like request(), but follows redirects manually so every hop is re-validated. */
async function fetchFollow(startUrl, { method = 'GET', timeoutMs = 8000, maxBytes = 0, deadline = Date.now() + 20000 } = {}) {
  let url = startUrl;
  let redirects = 0;
  let permanent = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw codedError('TIMEOUT', 'Timed out');
    const res = await request(url, { method, timeoutMs: Math.min(timeoutMs, remaining), maxBytes });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      if (redirects >= MAX_REDIRECTS) throw codedError('REDIRECT_LOOP', 'Too many redirects');
      if (res.status === 301 || res.status === 308) permanent = true;
      try {
        url = new URL(location, url).href;
      } catch {
        throw codedError('BAD_REDIRECT', 'Redirect to an invalid address');
      }
      redirects += 1;
      continue;
    }
    return { ...res, finalUrl: url, redirects, permanent };
  }
}

module.exports = { assertPublicUrl, fetchFollow, request, isPrivateAddress, codedError, testing };
