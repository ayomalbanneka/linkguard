'use strict';

// GET /scans/{scanId}
const { queryAll, UUID } = require('./scans');
const { json } = require('./http');

function friendlyError(raw) {
  if (!raw) return undefined;
  try {
    const outer = JSON.parse(raw); // {"Error": "...", "Cause": "..."}
    try {
      const cause = typeof outer.Cause === 'string' ? JSON.parse(outer.Cause) : outer.Cause;
      return cause?.errorMessage || outer.Error || 'The check failed.';
    } catch {
      return outer.Cause || outer.Error || 'The check failed.';
    }
  } catch {
    return String(raw).slice(0, 300);
  }
}

exports.handler = async (event) => {
  const scanId = event.pathParameters?.scanId || '';
  if (!UUID.test(scanId)) return json(404, { error: 'Scan not found.' });

  const items = await queryAll(scanId);
  const meta = items.find((i) => i.sk === 'META');
  if (!meta) return json(404, { error: 'Scan not found. It may have expired.' });

  const links = items
    .filter((i) => i.sk.startsWith('LINK#'))
    .map((i) => ({ url: i.url, state: i.state, status: i.status, finalUrl: i.finalUrl, note: i.note, checkedAt: i.checkedAt }));

  return json(200, {
    scan: {
      scanId,
      url: meta.url,
      status: meta.status,
      sourceType: meta.sourceType,
      linkCount: meta.linkCount,
      truncated: meta.truncated === true,
      createdAt: meta.createdAt,
      finishedAt: meta.finishedAt,
      counts: meta.counts,
      error: meta.status === 'FAILED' ? friendlyError(meta.errorMessage) : undefined,
    },
    links,
  });
};
