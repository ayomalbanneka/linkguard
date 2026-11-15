'use strict';

const MAX_URL_LENGTH = 500;

function decodeEntities(s) {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Resolve `raw` against `base`; keep only http(s) URLs, drop #fragments and absurdly long URLs. */
function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(String(raw).trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return u.href.length <= MAX_URL_LENGTH ? u.href : null;
}

/** All unique http(s) <a href> targets in an HTML document, in document order. */
function extractLinksFromHtml(html, baseUrl) {
  let base = baseUrl;
  const baseTag = /<base\s(?:[^>]*?\s)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  if (baseTag) {
    const b = normalizeUrl(decodeEntities(baseTag[1] ?? baseTag[2]), baseUrl);
    if (b) base = b;
  }

  const seen = new Set();
  const out = [];
  const re = /<a\s(?:[^>]*?\s)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw || raw.trim().startsWith('#')) continue;
    const href = normalizeUrl(decodeEntities(raw), base);
    if (href && !seen.has(href)) {
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}

function looksLikeSitemap(body) {
  return /<(urlset|sitemapindex)[\s>]/i.test(String(body).slice(0, 4000));
}

/** Parse a sitemap or sitemap index. */
function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const seen = new Set();
  const urls = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const href = normalizeUrl(decodeEntities(m[1]));
    if (href && !seen.has(href)) {
      seen.add(href);
      urls.push(href);
    }
  }
  return { isIndex, urls };
}

module.exports = { normalizeUrl, extractLinksFromHtml, looksLikeSitemap, parseSitemap, MAX_URL_LENGTH };
