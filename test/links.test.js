'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLinksFromHtml, parseSitemap, looksLikeSitemap, normalizeUrl } = require('../src/links');
const { toCsv, csvCell } = require('../src/csv');

test('extracts unique http(s) links, resolves relatives, drops fragments and non-web schemes', () => {
  const html = `
    <base href="https://docs.example.com/guide/">
    <a href="intro.html">a</a> <a class="x" href='/api#top'>b</a>
    <a href="https://other.org/x?a=1&amp;b=2">c</a> <a href="intro.html#again">dup</a>
    <a href="mailto:hi@example.com">m</a> <a href="javascript:void(0)">j</a>
    <a href="#section">frag</a> <a data-href="/nope" href=unquoted.html>u</a>`;
  assert.deepEqual(extractLinksFromHtml(html, 'https://docs.example.com/'), [
    'https://docs.example.com/guide/intro.html',
    'https://docs.example.com/api',
    'https://other.org/x?a=1&b=2',
    'https://docs.example.com/guide/unquoted.html',
  ]);
});

test('parses sitemaps and sitemap indexes', () => {
  const urlset = `<?xml version="1.0"?><urlset><url><loc>https://a.com/1</loc></url><url><loc> https://a.com/2 </loc></url><url><loc>https://a.com/1</loc></url></urlset>`;
  assert.ok(looksLikeSitemap(urlset));
  assert.deepEqual(parseSitemap(urlset), { isIndex: false, urls: ['https://a.com/1', 'https://a.com/2'] });
  const index = `<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`;
  assert.equal(parseSitemap(index).isIndex, true);
  assert.equal(looksLikeSitemap('<html><a href="/x">x</a></html>'), false);
});

test('normalizeUrl rejects junk', () => {
  assert.equal(normalizeUrl('ftp://x.com/a'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl('https://x.com/' + 'a'.repeat(600)), null);
});

test('CSV escapes quotes and neutralises formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(toCsv([{ a: 1, b: undefined }], ['a', 'b']), 'a,b\r\n1,\r\n');
});
