import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as amazonmq from 'aws-cdk-lib/aws-amazonmq';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvConfig } from './config';
export interface InfraStackProps extends cdk.StackProps {
    config: EnvConfig;
}
export declare class InfraStack extends cdk.Stack {
    /** Exported constructs consumed by ServicesStack */
    readonly vpc: ec2.Vpc;
    readonly dbSecret: secretsmanager.Secret;
    readonly redisAuthSecret: secretsmanager.Secret;
    readonly mqSecret: secretsmanager.Secret;
    readonly dbInstance: rds.DatabaseInstance;
    readonly redisServerlessCache: elasticache.CfnServerlessCache;
    readonly mqBroker: amazonmq.CfnBroker;
    readonly openSearchDomain: opensearch.Domain;
    readonly ecsCluster: ecs.Cluster;
    readonly serviceDiscoveryNamespace: servicediscovery.PrivateDnsNamespace;
    readonly ecsTaskRole: iam.Role;
    readonly ecsExecutionRole: iam.Role;
    /** Security groups exported for use in ServicesStack */
    readonly albSg: ec2.SecurityGroup;
    readonly ecsSg: ec2.SecurityGroup;
    readonly rdsSg: ec2.SecurityGroup;
    readonly redisSg: ec2.SecurityGroup;
    readonly mqSg: ec2.SecurityGroup;
    readonly openSearchSg: ec2.SecurityGroup;
    constructor(scope: Construct, id: string, props: InfraStackProps);
}
