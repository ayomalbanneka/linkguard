'use strict';

// Step Functions task 3: tally results, write the CSV report, alert if a weekly re-check found problems.
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { PublishCommand } = require('@aws-sdk/client-sns');
const { ddb, s3, sns } = require('./clients');
const { queryAll, table } = require('./scans');
const { toCsv } = require('./csv');

const SEVERITY = { broken: 0, redirect: 1, unverified: 2, ok: 3 };

exports.handler = async ({ scanId }) => {
  const [meta] = await queryAll(scanId, 'META');
  const items = await queryAll(scanId, 'LINK#');

  const counts = { ok: 0, redirect: 0, broken: 0, unverified: 0 };
  for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;

  const problems = items
    .filter((i) => i.state !== 'ok')
    .sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state] || a.url.localeCompare(b.url));

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.REPORT_BUCKET,
      Key: `reports/${scanId}.csv`,
      Body: toCsv(problems, ['url', 'state', 'status', 'finalUrl', 'note']),
      ContentType: 'text/csv; charset=utf-8',
    }),
  );

  await ddb.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: scanId, sk: 'META' },
      UpdateExpression: 'SET #s = :s, #f = :f, #c = :c',
      ExpressionAttributeNames: { '#s': 'status', '#f': 'finishedAt', '#c': 'counts' },
      ExpressionAttributeValues: { ':s': 'COMPLETE', ':f': new Date().toISOString(), ':c': counts },
    }),
  );

  if (meta?.scheduled && counts.broken > 0 && process.env.ALERT_TOPIC_ARN) {
    const lines = problems.filter((p) => p.state === 'broken').slice(0, 20).map((p) => `${p.url}  (${p.note || p.status})`);
    await sns.send(
      new PublishCommand({
        TopicArn: process.env.ALERT_TOPIC_ARN,
        Subject: `LinkGuard: ${counts.broken} broken link${counts.broken === 1 ? '' : 's'} found`.slice(0, 100),
        Message: `Weekly re-check of ${meta.url}\n\n${counts.broken} broken, ${counts.redirect} moved, ${counts.unverified} unverified, ${counts.ok} working.\n\nBroken links${counts.broken > 20 ? ' (first 20)' : ''}:\n${lines.join('\n')}\n`,
      }),
    );
  }

  return { scanId, checked: items.length, ...counts };
};
