#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ECommerceStack } from '../lib/ecommerce-stack';
import { devConfig } from '../lib/config';

const app = new cdk.App();
const config = devConfig;

new ECommerceStack(app, 'ECommerceStack', {
  env: { account: config.account, region: config.region },
  config,
  stackName: `ecommerce-${config.environment}`,
  description: 'ECommerce platform — VPC, RDS, ElastiCache, MQ, OpenSearch, ECS Fargate',
  tags: { Project: 'ECommerce', Environment: config.environment, ManagedBy: 'CDK' },
});

app.synth();
