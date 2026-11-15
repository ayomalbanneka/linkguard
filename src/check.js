'use strict';

// Step Functions task 2 (runs once per link, up to 20 at a time): check one URL.
const crypto = require('node:crypto');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('./clients');
const { table, expiry } = require('./scans');
const { checkUrl } = require('./checker');

exports.handler = async ({ scanId, link }) => {
  const result = await checkUrl(link);
  await ddb.send(
    new PutCommand({
      TableName: table(),
      Item: {
        pk: scanId,
        sk: `LINK#${crypto.createHash('sha1').update(link).digest('hex')}`,
        url: link,
        state: result.state,
        status: result.status,
        finalUrl: result.finalUrl,
        note: result.note,
        ms: result.ms,
        checkedAt: new Date().toISOString(),
        expiresAt: expiry(),
      },
    }),
  );
  return { state: result.state };
};
