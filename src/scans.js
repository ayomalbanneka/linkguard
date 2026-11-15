'use strict';

const crypto = require('node:crypto');
const { PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, sfn } = require('./clients');

const RETENTION_DAYS = 30;
const WATCH_LIMIT = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const table = () => process.env.TABLE_NAME;
const expiry = () => Math.floor(Date.now() / 1000) + RETENTION_DAYS * 86400;

/** Every item under a partition key (optionally only sort keys with a given prefix). */
async function queryAll(pk, skPrefix) {
  const items = [];
  let key;
  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: table(),
        ConsistentRead: true,
        KeyConditionExpression: skPrefix ? 'pk = :p AND begins_with(sk, :s)' : 'pk = :p',
        ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
        ExclusiveStartKey: key,
      }),
    );
    items.push(...(out.Items || []));
    key = out.LastEvaluatedKey;
  } while (key);
  return items;
}

/** Create the scan record and start the Step Functions workflow. Returns the scan id. */
async function startScan(url, { watch = false, scheduled = false } = {}) {
  if (watch) {
    const watched = await queryAll('WATCHLIST');
    if (watched.length >= WATCH_LIMIT && !watched.some((w) => w.sk === url)) {
      const e = new Error('The weekly watch list is full. Try again later or run a one-off check.');
      e.code = 'WATCH_LIMIT';
      throw e;
    }
  }

  const scanId = crypto.randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: table(),
      Item: { pk: scanId, sk: 'META', url, status: 'RUNNING', scheduled, createdAt: new Date().toISOString(), expiresAt: expiry() },
    }),
  );
  if (watch) {
    await ddb.send(new PutCommand({ TableName: table(), Item: { pk: 'WATCHLIST', sk: url, url, addedAt: new Date().toISOString() } }));
  }

  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        name: scanId,
        input: JSON.stringify({ scanId, url }),
      }),
    );
  } catch (err) {
    await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { pk: scanId, sk: 'META' },
        UpdateExpression: 'SET #s = :f, errorMessage = :e',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':f': 'FAILED', ':e': 'Could not start the workflow' },
      }),
    );
    throw err;
  }
  return scanId;
}

module.exports = { startScan, queryAll, table, expiry, UUID, WATCH_LIMIT };
