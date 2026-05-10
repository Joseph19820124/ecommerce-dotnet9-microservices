#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';
import { ServicesStack } from '../lib/services-stack';
import { getConfig } from '../lib/config';

const app = new cdk.App();

const config = getConfig();

const env: cdk.Environment = {
  account: config.account,
  region: config.region,
};

const commonTags: Record<string, string> = {
  Project:     'ECommerce',
  Environment: config.environment,
  ManagedBy:   'CDK',
  Owner:       'platform-team',
};

// ---------------------------------------------------------------------------
// Stack 1: Infrastructure (VPC, RDS, Redis, MQ, OpenSearch, ECS Cluster)
// ---------------------------------------------------------------------------
const infraStack = new InfraStack(app, 'ECommerceInfraStack', {
  env,
  config,
  description:
    'ECommerce platform — core infrastructure (VPC, RDS, ElastiCache, MQ, OpenSearch, ECS)',
  stackName: `ecommerce-${config.environment}-infra`,
  tags: commonTags,
  terminationProtection: config.environment === 'prod',
});

// ---------------------------------------------------------------------------
// Stack 2: Services (ECR, ALB, Fargate services)
// ---------------------------------------------------------------------------
const servicesStack = new ServicesStack(app, 'ECommerceServicesStack', {
  env,
  config,
  infraStack,
  description:
    'ECommerce platform — microservices (ECR, ALB, Fargate tasks, X-Ray, CloudWatch)',
  stackName: `ecommerce-${config.environment}-services`,
  tags: commonTags,
  terminationProtection: config.environment === 'prod',
});

// ServicesStack depends on InfraStack (implicit through construct references,
// but we make it explicit to be safe during parallel deploys).
servicesStack.addDependency(infraStack);

app.synth();
