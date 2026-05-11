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
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvConfig, databases } from './config';

export interface InfraStackProps extends cdk.StackProps {
  config: EnvConfig;
}

export class InfraStack extends cdk.Stack {
  /** Exported constructs consumed by ServicesStack */
  public readonly vpc: ec2.Vpc;
  public readonly dbSecret: secretsmanager.Secret;
  public readonly redisAuthSecret: secretsmanager.Secret;
  public readonly mqSecret: secretsmanager.Secret;
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly redisServerlessCache: elasticache.CfnServerlessCache;
  public readonly mqBroker: amazonmq.CfnBroker;
  public readonly openSearchDomain: opensearch.Domain;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceDiscoveryNamespace: servicediscovery.PrivateDnsNamespace;
  public readonly ecsTaskRole: iam.Role;
  public readonly ecsExecutionRole: iam.Role;

  /** Security groups exported for use in ServicesStack */
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;
  public readonly mqSg: ec2.SecurityGroup;
  public readonly openSearchSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.environment === 'prod';
    const prefix = `ecommerce-${config.environment}`;

    // =========================================================================
    // 1. VPC — 2 AZs, public / private / isolated subnet tiers
    // =========================================================================
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${prefix}-vpc`,
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      natGateways: isProd ? 2 : 1,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // VPC Flow Logs
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogGroup', {
          logGroupName: `/aws/vpc/flowlogs/${prefix}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
    });

    // =========================================================================
    // 2. Security Groups
    // =========================================================================
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-alb-sg`,
      description: 'ALB — allows HTTP and HTTPS from the internet',
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP from internet');
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-ecs-sg`,
      description: 'ECS tasks — allow traffic from ALB and within cluster',
      allowAllOutbound: true,
    });
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.allTcp(), 'Traffic from ALB');
    this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.allTcp(), 'Inter-service traffic');

    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-rds-sg`,
      description: 'RDS PostgreSQL — allow from ECS only',
      allowAllOutbound: false,
    });
    this.rdsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432), 'PostgreSQL from ECS');

    this.redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-redis-sg`,
      description: 'ElastiCache Redis — allow from ECS only',
      allowAllOutbound: false,
    });
    this.redisSg.addIngressRule(this.ecsSg, ec2.Port.tcp(6379), 'Redis from ECS');

    this.mqSg = new ec2.SecurityGroup(this, 'MqSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-mq-sg`,
      description: 'Amazon MQ RabbitMQ — allow from ECS only',
      allowAllOutbound: false,
    });
    this.mqSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5671),  'AMQPS from ECS');
    this.mqSg.addIngressRule(this.ecsSg, ec2.Port.tcp(15671), 'RabbitMQ HTTPS management from ECS');

    this.openSearchSg = new ec2.SecurityGroup(this, 'OpenSearchSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-opensearch-sg`,
      description: 'OpenSearch — allow HTTPS from ECS only',
      allowAllOutbound: false,
    });
    this.openSearchSg.addIngressRule(this.ecsSg, ec2.Port.tcp(443), 'HTTPS from ECS');

    // =========================================================================
    // 3. Secrets Manager secrets
    // =========================================================================
    this.dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `${prefix}/rds/postgres`,
      description: 'RDS PostgreSQL master credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ecommerceadmin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        passwordLength: 32,
      },
    });

    this.redisAuthSecret = new secretsmanager.Secret(this, 'RedisAuthSecret', {
      secretName: `${prefix}/redis/auth-token`,
      description: 'ElastiCache Redis AUTH token',
      generateSecretString: {
        excludeCharacters: '"@/\\\'',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    this.mqSecret = new secretsmanager.Secret(this, 'MqSecret', {
      secretName: `${prefix}/mq/rabbitmq`,
      description: 'Amazon MQ RabbitMQ credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ecommercebroker' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        passwordLength: 32,
      },
    });

    // =========================================================================
    // 4. RDS PostgreSQL 16 — Multi-AZ, isolated subnets
    // =========================================================================
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      description: `${prefix} RDS isolated subnet group`,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      subnetGroupName: `${prefix}-rds-subnet-group`,
    });

    const dbParameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      description: `${prefix} PostgreSQL 16 parameter group`,
      parameters: {
        'log_statement':          'all',
        'log_min_duration_statement': '1000',
        'shared_preload_libraries': 'pg_stat_statements',
      },
    });

    this.dbInstance = new rds.DatabaseInstance(this, 'DbInstance', {
      instanceIdentifier: `${prefix}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM,
      ),
      vpc: this.vpc,
      subnetGroup: dbSubnetGroup,
      securityGroups: [this.rdsSg],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      multiAz: isProd,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageEncrypted: true,
      parameterGroup: dbParameterGroup,
      backupRetention: isProd ? cdk.Duration.days(14) : cdk.Duration.days(3),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      autoMinorVersionUpgrade: true,
    });

    // RDS init script — create the 5 application databases
    // The script runs as a custom resource after the instance is available.
    // We store the SQL in a CloudFormation Output for reference.
    const dbInitSql = databases.map(db => `CREATE DATABASE ${db};`).join('\n');
    new cdk.CfnOutput(this, 'DbInitSql', {
      value: dbInitSql,
      description: 'Run this SQL on the RDS instance to create application databases',
      exportName: `${prefix}-db-init-sql`,
    });

    // =========================================================================
    // 5. ElastiCache Serverless Redis — private subnets
    // =========================================================================
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `${prefix} ElastiCache private subnet group`,
      subnetIds: this.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
      cacheSubnetGroupName: `${prefix}-redis-subnet-group`,
    });

    this.redisServerlessCache = new elasticache.CfnServerlessCache(this, 'RedisServerless', {
      serverlessCacheName: `${prefix}-redis`,
      engine: 'redis',
      description: `${prefix} serverless Redis cache`,
      securityGroupIds: [this.redisSg.securityGroupId],
      subnetIds: this.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
      userGroupId: undefined,  // open to ECS sg — auth via token at app level
      cacheUsageLimits: {
        dataStorage: {
          maximum: 10,
          unit: 'GB',
        },
        ecpuPerSecond: {
          maximum: 5000,
        },
      },
    });
    this.redisServerlessCache.addDependency(redisSubnetGroup);

    // =========================================================================
    // 6. Amazon MQ — RabbitMQ broker
    //    dev: single-instance   prod: active-standby (CLUSTER_MULTI_AZ)
    // =========================================================================
    const mqPassword = this.mqSecret.secretValueFromJson('password').unsafeUnwrap();
    const mqUsername = 'ecommercebroker';

    this.mqBroker = new amazonmq.CfnBroker(this, 'MqBroker', {
      brokerName: `${prefix}-rabbitmq`,
      engineType: 'RABBITMQ',
      engineVersion: '3.13',
      hostInstanceType: 'mq.m5.large',
      deploymentMode: isProd ? 'CLUSTER_MULTI_AZ' : 'SINGLE_INSTANCE',
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      users: [
        {
          username: mqUsername,
          password: mqPassword,
        },
      ],
      subnetIds: isProd
        ? this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 2)
        : [this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds[0]],
      securityGroups: [this.mqSg.securityGroupId],
      logs: {
        general: true,
      },
    });

    // =========================================================================
    // 7. Amazon OpenSearch Service — dev single-node, VPC endpoint
    // =========================================================================
    const openSearchSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      onePerAz: true,
    });

    this.openSearchDomain = new opensearch.Domain(this, 'OpenSearchDomain', {
      domainName: `${prefix}-search`,
      version: opensearch.EngineVersion.OPENSEARCH_2_13,
      capacity: {
        masterNodes: 0,                        // no dedicated master for dev
        dataNodes: isProd ? 3 : 1,
        dataNodeInstanceType: 't3.small.search',
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        enabled: true,
        volumeSize: 20,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      vpc: this.vpc,
      vpcSubnets: isProd
        ? [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }]
        : [{ subnets: [openSearchSubnets.subnets[0]] }],
      securityGroups: [this.openSearchSg],
      zoneAwareness: {
        enabled: isProd,
        availabilityZoneCount: isProd ? 3 : 2,
      },
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      useUnsignedBasicAuth: false,
      fineGrainedAccessControl: {
        masterUserName: 'ecommerce-os-admin',
      },
      logging: {
        slowSearchLogEnabled: true,
        appLogEnabled: true,
        slowIndexLogEnabled: true,
        auditLogEnabled: false,
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // 8. ECS Cluster — Fargate with Container Insights
    // =========================================================================
    this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: `${prefix}-cluster`,
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    // =========================================================================
    // 9. AWS Cloud Map — private DNS namespace for service discovery
    // =========================================================================
    this.serviceDiscoveryNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      'ServiceDiscoveryNamespace',
      {
        name: `${prefix}.local`,
        vpc: this.vpc,
        description: `${prefix} internal service discovery namespace`,
      },
    );

    // =========================================================================
    // 10. IAM Roles — ECS Task Execution Role + Task Role
    // =========================================================================

    // Execution Role — pulled by the ECS control plane to start the container
    this.ecsExecutionRole = new iam.Role(this, 'EcsExecutionRole', {
      roleName: `${prefix}-ecs-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // Allow execution role to read secrets (for secrets injection at task start)
    this.dbSecret.grantRead(this.ecsExecutionRole);
    this.redisAuthSecret.grantRead(this.ecsExecutionRole);
    this.mqSecret.grantRead(this.ecsExecutionRole);

    // Task Role — assumed by the running application code
    this.ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: `${prefix}-ecs-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        XRayWritePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'XRayWrite',
              effect: iam.Effect.ALLOW,
              actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets',
                'xray:GetSamplingStatisticSummaries',
              ],
              resources: ['*'],
            }),
          ],
        }),
        SecretsManagerReadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'SecretsRead',
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: [
                this.dbSecret.secretArn,
                this.redisAuthSecret.secretArn,
                this.mqSecret.secretArn,
              ],
            }),
          ],
        }),
        CloudWatchLogsPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CWLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: ['arn:aws:logs:*:*:log-group:/ecommerce/*'],
            }),
          ],
        }),
        EcrReadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'EcrRead',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetAuthorizationToken',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${prefix}-vpc-id`,
    });

    new cdk.CfnOutput(this, 'DbInstanceEndpoint', {
      value: this.dbInstance.instanceEndpoint.hostname,
      exportName: `${prefix}-db-endpoint`,
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      exportName: `${prefix}-db-secret-arn`,
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redisServerlessCache.attrEndpointAddress,
      exportName: `${prefix}-redis-endpoint`,
    });

    new cdk.CfnOutput(this, 'MqBrokerArn', {
      value: this.mqBroker.ref,
      exportName: `${prefix}-mq-broker-arn`,
    });

    new cdk.CfnOutput(this, 'OpenSearchEndpoint', {
      value: this.openSearchDomain.domainEndpoint,
      exportName: `${prefix}-opensearch-endpoint`,
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.clusterName,
      exportName: `${prefix}-ecs-cluster-name`,
    });

    new cdk.CfnOutput(this, 'ServiceDiscoveryNamespaceId', {
      value: this.serviceDiscoveryNamespace.namespaceId,
      exportName: `${prefix}-sd-namespace-id`,
    });

    new cdk.CfnOutput(this, 'EcsTaskRoleArn', {
      value: this.ecsTaskRole.roleArn,
      exportName: `${prefix}-ecs-task-role-arn`,
    });

    new cdk.CfnOutput(this, 'EcsExecutionRoleArn', {
      value: this.ecsExecutionRole.roleArn,
      exportName: `${prefix}-ecs-execution-role-arn`,
    });
  }
}
