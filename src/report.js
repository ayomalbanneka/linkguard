'use strict';

// GET /scans/{scanId}/report.csv
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./clients');
const { UUID } = require('./scans');
const { json, SECURITY_HEADERS } = require('./http');

exports.handler = async (event) => {
  const scanId = event.pathParameters?.scanId || '';
  if (!UUID.test(scanId)) return json(404, { error: 'Report not found.' });
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: process.env.REPORT_BUCKET, Key: `reports/${scanId}.csv` }));
    const body = await out.Body.transformToString('utf-8');
    return {
      statusCode: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="linkguard-${scanId.slice(0, 8)}.csv"`,
        ...SECURITY_HEADERS,
      },
      body,
    };
  } catch (err) {
    if (err.name === 'NoSuchKey') return json(404, { error: 'Report not ready yet.' });
    console.error('report failed', err);
    return json(500, { error: 'Could not load the report.' });
  }
};
