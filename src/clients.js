'use strict';

// One set of AWS SDK clients per Lambda container. Tests replace `.send`.
// The AWS SDK v3 ships with the nodejs22.x Lambda runtime, so nothing to bundle.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SFNClient } = require('@aws-sdk/client-sfn');
const { S3Client } = require('@aws-sdk/client-s3');
const { SNSClient } = require('@aws-sdk/client-sns');

module.exports = {
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  sfn: new SFNClient({}),
  s3: new S3Client({}),
  sns: new SNSClient({}),
};
