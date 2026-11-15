'use strict';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
    body: JSON.stringify(body),
  };
}

module.exports = { json, SECURITY_HEADERS };
