'use strict';

// GET /  (the single-page UI is one HTML file served straight from Lambda)
const fs = require('node:fs');
const path = require('node:path');
const { SECURITY_HEADERS } = require('./http');

const page = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS },
  body: page,
});
