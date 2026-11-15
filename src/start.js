'use strict';

// POST /scans  {"url": "https://docs.example.com/", "watch": true}
const { assertPublicUrl } = require('./safe-fetch');
const { startScan } = require('./scans');
const { json } = require('./http');

exports.handler = async (event) => {
  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}';
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Send a JSON body like {"url": "https://docs.example.com/"}.' });
  }

  let target;
  try {
    target = await assertPublicUrl(String(body.url || '').trim());
  } catch (err) {
    return json(400, { error: err.message });
  }

  try {
    const scanId = await startScan(target.href, { watch: body.watch === true });
    return json(202, { scanId });
  } catch (err) {
    if (err.code === 'WATCH_LIMIT') return json(409, { error: err.message });
    console.error('startScan failed', err);
    return json(500, { error: 'Could not start the check. Try again in a moment.' });
  }
};
