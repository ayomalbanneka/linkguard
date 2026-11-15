'use strict';
// Runs the real handlers against in-memory fakes of DynamoDB, S3, SNS and Step Functions,
// and plays the part of the state machine. Skipped if the AWS SDK isn't installed (`npm install` adds it).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let hasSdk = true;
try { require.resolve('@aws-sdk/client-dynamodb'); } catch { hasSdk = false; }

test('start -> discover -> check (parallel) -> finalize -> get/report -> weekly rescan alert', { skip: !hasSdk }, async () => {
  const { testing } = require('../src/safe-fetch');
  const clients = require('../src/clients');
  testing.allowPrivate = true;

  // ---- fake AWS
  const store = new Map();
  const executions = [];
  const objects = new Map();
  const alerts = [];
  clients.ddb.send = async (cmd) => {
    const name = cmd.constructor.name;
    const i = cmd.input;
    if (name === 'PutCommand') { store.set(`${i.Item.pk}|${i.Item.sk}`, { ...i.Item }); return {}; }
    if (name === 'UpdateCommand') {
      const item = store.get(`${i.Key.pk}|${i.Key.sk}`);
      for (const part of i.UpdateExpression.replace(/^SET /, '').split(', ')) {
        const [lhs, rhs] = part.split(' = ');
        item[(i.ExpressionAttributeNames || {})[lhs] || lhs] = i.ExpressionAttributeValues[rhs];
      }
      return {};
    }
    if (name === 'QueryCommand') {
      const prefix = i.ExpressionAttributeValues[':s'];
      const items = [...store.values()].filter((x) => x.pk === i.ExpressionAttributeValues[':p'] && (!prefix || x.sk.startsWith(prefix)));
      return { Items: items };
    }
    throw new Error('unexpected ddb command ' + name);
  };
  clients.sfn.send = async (cmd) => { executions.push(JSON.parse(cmd.input.input)); return {}; };
  clients.s3.send = async (cmd) => {
    if (cmd.constructor.name === 'PutObjectCommand') { objects.set(cmd.input.Key, cmd.input.Body); return {}; }
    return { Body: { transformToString: async () => objects.get(cmd.input.Key) } };
  };
  clients.sns.send = async (cmd) => { alerts.push(cmd.input); return {}; };

  Object.assign(process.env, { TABLE_NAME: 't', REPORT_BUCKET: 'b', STATE_MACHINE_ARN: 'arn:fake', ALERT_TOPIC_ARN: 'arn:topic', MAX_LINKS: '10' });
  const handlers = Object.fromEntries(['start', 'get', 'report', 'discover', 'check', 'finalize', 'rescan'].map((n) => [n, require(`../src/${n}`).handler]));

  // ---- a tiny "docs site"
  const server = http.createServer((req, res) => {
    const route = req.url;
    if (route === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<a href="/ok">1</a><a href="/gone">2</a><a href="/moved">3</a><a href="/ok">dup</a><a href="mailto:x@y.z">m</a>'); }
    if (route === '/ok') { res.writeHead(200); return res.end('ok'); }
    if (route === '/moved') { res.writeHead(301, { location: '/ok' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}/`;

  // play the state machine
  async function runWorkflow(input) {
    const found = await handlers.discover(input);
    assert.equal(found.count, 3);
    await Promise.all(found.links.map((link) => handlers.check({ scanId: input.scanId, link })));
    return handlers.finalize({ scanId: input.scanId });
  }

  try {
    // 1. start
    const started = await handlers.start({ body: JSON.stringify({ url: site, watch: true }) });
    assert.equal(started.statusCode, 202);
    const { scanId } = JSON.parse(started.body);
    assert.equal(executions[0].scanId, scanId);

    // 2. workflow
    const summary = await runWorkflow(executions[0]);
    assert.deepEqual([summary.ok, summary.redirect, summary.broken, summary.checked], [1, 1, 1, 3]);

    // 3. read it back
    const got = JSON.parse((await handlers.get({ pathParameters: { scanId } })).body);
    assert.equal(got.scan.status, 'COMPLETE');
    assert.equal(got.scan.linkCount, 3);
    assert.equal(got.links.length, 3);
    const csv = (await handlers.report({ pathParameters: { scanId } })).body;
    assert.match(csv, /\/gone,broken,404/);
    assert.match(csv, /\/moved,redirect,200/);
    assert.doesNotMatch(csv, /\/ok,ok/);
    assert.equal(alerts.length, 0); // one-off scans never email

    // 4. validation + bad ids
    testing.allowPrivate = false; // the real guard is back on for this assertion
    assert.equal((await handlers.start({ body: JSON.stringify({ url: 'http://169.254.169.254/' }) })).statusCode, 400);
    testing.allowPrivate = true;
    assert.equal((await handlers.start({ body: 'nope' })).statusCode, 400);
    assert.equal((await handlers.get({ pathParameters: { scanId: 'WATCHLIST' } })).statusCode, 404);

    // 5. Monday: the scheduler re-checks the watch list and alerts on broken links
    const r = await handlers.rescan();
    assert.deepEqual(r, { watched: 1, started: 1 });
    await runWorkflow(executions[1]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].Subject, /1 broken link found/);
    assert.match(alerts[0].Message, /\/gone/);
  } finally {
    testing.allowPrivate = false;
    server.close();
  }
});
