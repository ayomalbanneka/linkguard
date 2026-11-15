'use strict';

// Step Functions task 1: work out which URLs to check.
//   * a sitemap  -> check every page it lists
//   * a web page -> check every link on that page
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('./clients');
const { table } = require('./scans');
const { fetchFollow } = require('./safe-fetch');
const { extractLinksFromHtml, looksLikeSitemap, parseSitemap } = require('./links');

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

async function fetchText(url) {
  const res = await fetchFollow(url, { method: 'GET', maxBytes: MAX_PAGE_BYTES, timeoutMs: 10000 });
  if (res.status >= 400) throw new Error(`The address returned HTTP ${res.status}.`);
  return res;
}

exports.handler = async ({ scanId, url }) => {
  const max = Number(process.env.MAX_LINKS) || 300;
  const res = await fetchText(url);

  let sourceType = 'page';
  let found;
  if (looksLikeSitemap(res.body)) {
    sourceType = 'sitemap';
    const first = parseSitemap(res.body);
    found = first.urls;
    if (first.isIndex) {
      found = [];
      for (const child of first.urls.slice(0, 3)) {
        try {
          const childRes = await fetchText(child);
          found.push(...parseSitemap(childRes.body).urls);
        } catch (err) {
          console.warn('child sitemap failed', child, err.message);
        }
        if (found.length >= max) break;
      }
    }
  } else {
    found = extractLinksFromHtml(res.body, res.finalUrl);
  }

  const unique = [...new Set(found)];
  const links = unique.slice(0, max);
  const truncated = unique.length > max;
  if (links.length === 0) {
    throw new Error('No links were found at that address. Try a page that links to other pages, or a sitemap.xml.');
  }

  await ddb.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: scanId, sk: 'META' },
      UpdateExpression: 'SET #n = :n, #t = :t, #x = :x',
      ExpressionAttributeNames: { '#n': 'linkCount', '#t': 'sourceType', '#x': 'truncated' },
      ExpressionAttributeValues: { ':n': links.length, ':t': sourceType, ':x': truncated },
    }),
  );
  return { scanId, count: links.length, links };
};
