'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, assertPublicUrl } = require('../src/safe-fetch');

test('private and special-purpose addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'ff02::1', '64:ff9b::7f00:1', 'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '151.101.1.69', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('assertPublicUrl rejects local targets and bad input before any network call', async () => {
  for (const bad of [
    'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', 'http://foo.internal/', 'ftp://example.com/', 'nonsense', 'http://user:pw@example.com/',
    'https://example.com:22/',
  ]) {
    await assert.rejects(() => assertPublicUrl(bad), (e) => ['BLOCKED', 'INVALID_URL', 'PORT'].includes(e.code), bad);
  }
});
