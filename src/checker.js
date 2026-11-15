'use strict';

const { fetchFollow } = require('./safe-fetch');

// Errors where retrying with GET cannot help.
const NO_RETRY = new Set(['BLOCKED', 'PORT', 'INVALID_URL', 'ENOTFOUND', 'REDIRECT_LOOP', 'BAD_REDIRECT']);

/**
 * Turn a response (or error) into one of four states:
 *   ok          the link works
 *   redirect    the link works but moved permanently, so the source should be updated
 *   broken      the link is dead (404/410/5xx, DNS failure, refused, bad certificate)
 *   unverified  we could not tell (bot-blocked, rate-limited, timed out)
 */
function classify(res, err) {
  if (err) {
    const code = err.code || 'ERROR';
    if (code === 'ENOTFOUND') return { state: 'broken', note: 'Domain does not exist' };
    if (code === 'ECONNREFUSED') return { state: 'broken', note: 'Connection refused' };
    if (code === 'REDIRECT_LOOP' || code === 'BAD_REDIRECT') return { state: 'broken', note: err.message };
    if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { state: 'broken', note: 'TLS certificate problem' };
    if (code === 'BLOCKED' || code === 'PORT' || code === 'INVALID_URL') return { state: 'unverified', note: err.message };
    if (code === 'TIMEOUT') return { state: 'unverified', note: 'Timed out' };
    return { state: 'unverified', note: `Network error (${code})` };
  }

  const { status } = res;
  if (status >= 200 && status < 300) {
    if (res.permanent) {
      return { state: 'redirect', status, finalUrl: res.finalUrl, note: 'Moved permanently. Update the link.' };
    }
    return { state: 'ok', status, finalUrl: res.redirects ? res.finalUrl : undefined };
  }
  if ([401, 403, 429, 503, 999].includes(status)) {
    return { state: 'unverified', status, note: 'Blocked or rate-limited. Check by hand.' };
  }
  if (status >= 300 && status < 400) return { state: 'broken', status, note: 'Redirect with no destination' };
  return { state: 'broken', status, note: `HTTP ${status}` };
}

/** HEAD first (cheap); fall back to GET because many servers mishandle HEAD. */
async function checkUrl(url) {
  const started = Date.now();
  const deadline = started + 20000;
  let res;
  let err;
  try {
    res = await fetchFollow(url, { method: 'HEAD', deadline });
  } catch (e) {
    err = e;
  }
  const retryWithGet = err ? !NO_RETRY.has(err.code) : res.status >= 400;
  if (retryWithGet && Date.now() < deadline) {
    try {
      res = await fetchFollow(url, { method: 'GET', deadline });
      err = undefined;
    } catch (e) {
      err = e;
      res = undefined;
    }
  }
  return { ...classify(res, err), ms: Date.now() - started };
}

module.exports = { checkUrl, classify };
