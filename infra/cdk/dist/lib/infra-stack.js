"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfraStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const rds = require("aws-cdk-lib/aws-rds");
const elasticache = require("aws-cdk-lib/aws-elasticache");
const amazonmq = require("aws-cdk-lib/aws-amazonmq");
const opensearch = require("aws-cdk-lib/aws-opensearchservice");
const ecs = require("aws-cdk-lib/aws-ecs");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const servicediscovery = require("aws-cdk-lib/aws-servicediscovery");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const config_1 = require("./config");
class InfraStack extends cdk.Stack {
    constructor(scope, id, props) {
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
            destination: ec2.FlowLogDestination.toCloudWatchLogs(new logs.LogGroup(this, 'VpcFlowLogGroup', {
                logGroupName: `/aws/vpc/flowlogs/${prefix}`,
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            })),
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
        this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
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
        this.mqSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5671), 'AMQPS from ECS');
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
                'log_statement': 'all',
                'log_min_duration_statement': '1000',
                'shared_preload_libraries': 'pg_stat_statements',
            },
        });
        this.dbInstance = new rds.DatabaseInstance(this, 'DbInstance', {
            instanceIdentifier: `${prefix}-postgres`,
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
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
        const dbInitSql = config_1.databases.map(db => `CREATE DATABASE ${db};`).join('\n');
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
            userGroupId: undefined, // open to ECS sg — auth via token at app level
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
                masterNodes: 0, // no dedicated master for dev
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
        this.serviceDiscoveryNamespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceDiscoveryNamespace', {
            name: `${prefix}.local`,
            vpc: this.vpc,
            description: `${prefix} internal service discovery namespace`,
        });
        // =========================================================================
        // 10. IAM Roles — ECS Task Execution Role + Task Role
        // =========================================================================
        // Execution Role — pulled by the ECS control plane to start the container
        this.ecsExecutionRole = new iam.Role(this, 'EcsExecutionRole', {
            roleName: `${prefix}-ecs-execution-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
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
exports.InfraStack = InfraStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5mcmEtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvaW5mcmEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBRW5DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELHFEQUFxRDtBQUNyRCxnRUFBZ0U7QUFDaEUsMkNBQTJDO0FBQzNDLGlFQUFpRTtBQUNqRSxxRUFBcUU7QUFDckUsMkNBQTJDO0FBQzNDLDZDQUE2QztBQUM3QyxxQ0FBZ0Q7QUFNaEQsTUFBYSxVQUFXLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUF1QnZDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLEtBQUssQ0FBQztRQUN6QixNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsV0FBVyxLQUFLLE1BQU0sQ0FBQztRQUM3QyxNQUFNLE1BQU0sR0FBRyxhQUFhLE1BQU0sQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUVqRCw0RUFBNEU7UUFDNUUsMkRBQTJEO1FBQzNELDRFQUE0RTtRQUM1RSxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ2xDLE9BQU8sRUFBRSxHQUFHLE1BQU0sTUFBTTtZQUN4QixNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDaEQsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxRQUFRO29CQUNkLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU07aUJBQ2xDO2dCQUNEO29CQUNFLFFBQVEsRUFBRSxFQUFF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QUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDN0MsS0FBSyxFQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPO1lBQ3BDLFVBQVUsRUFBRSxHQUFHLE1BQU0seUJBQXlCO1NBQy9DLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQS9lRCxnQ0ErZUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyByZHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJkcyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljYWNoZSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2FjaGUnO1xuaW1wb3J0ICogYXMgYW1hem9ubXEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFtYXpvbm1xJztcbmltcG9ydCAqIGFzIG9wZW5zZWFyY2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLW9wZW5zZWFyY2hzZXJ2aWNlJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBzZXJ2aWNlZGlzY292ZXJ5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZXJ2aWNlZGlzY292ZXJ5JztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgRW52Q29uZmlnLCBkYXRhYmFzZXMgfSBmcm9tICcuL2NvbmZpZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5mcmFTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBjb25maWc6IEVudkNvbmZpZztcbn1cblxuZXhwb3J0IGNsYXNzIEluZnJhU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICAvKiogRXhwb3J0ZWQgY29uc3RydWN0cyBjb25zdW1lZCBieSBTZXJ2aWNlc1N0YWNrICovXG4gIHB1YmxpYyByZWFkb25seSB2cGM6IGVjMi5WcGM7XG4gIHB1YmxpYyByZWFkb25seSBkYlNlY3JldDogc2VjcmV0c21hbmFnZXIuU2VjcmV0O1xuICBwdWJsaWMgcmVhZG9ubHkgcmVkaXNBdXRoU2VjcmV0OiBzZWNyZXRzbWFuYWdlci5TZWNyZXQ7XG4gIHB1YmxpYyByZWFkb25seSBtcVNlY3JldDogc2VjcmV0c21hbmFnZXIuU2VjcmV0O1xuICBwdWJsaWMgcmVhZG9ubHkgZGJJbnN0YW5jZTogcmRzLkRhdGFiYXNlSW5zdGFuY2U7XG4gIHB1YmxpYyByZWFkb25seSByZWRpc1NlcnZlcmxlc3NDYWNoZTogZWxhc3RpY2FjaGUuQ2ZuU2VydmVybGVzc0NhY2hlO1xuICBwdWJsaWMgcmVhZG9ubHkgbXFCcm9rZXI6IGFtYXpvbm1xLkNmbkJyb2tlcjtcbiAgcHVibGljIHJlYWRvbmx5IG9wZW5TZWFyY2hEb21haW46IG9wZW5zZWFyY2guRG9tYWluO1xuICBwdWJsaWMgcmVhZG9ubHkgZWNzQ2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSBzZXJ2aWNlRGlzY292ZXJ5TmFtZXNwYWNlOiBzZXJ2aWNlZGlzY292ZXJ5LlByaXZhdGVEbnNOYW1lc3BhY2U7XG4gIHB1YmxpYyByZWFkb25seSBlY3NUYXNrUm9sZTogaWFtLlJvbGU7XG4gIHB1YmxpYyByZWFkb25seSBlY3NFeGVjdXRpb25Sb2xlOiBpYW0uUm9sZTtcblxuICAvKiogU2VjdXJpdHkgZ3JvdXBzIGV4cG9ydGVkIGZvciB1c2UgaW4gU2VydmljZXNTdGFjayAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWxiU2c6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZWNzU2c6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgcmRzU2c6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVkaXNTZzogZWMyLlNlY3VyaXR5R3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBtcVNnOiBlYzIuU2VjdXJpdHlHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IG9wZW5TZWFyY2hTZzogZWMyLlNlY3VyaXR5R3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEluZnJhU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgeyBjb25maWcgfSA9IHByb3BzO1xuICAgIGNvbnN0IGlzUHJvZCA9IGNvbmZpZy5lbnZpcm9ubWVudCA9PT0gJ3Byb2QnO1xuICAgIGNvbnN0IHByZWZpeCA9IGBlY29tbWVyY2UtJHtjb25maWcuZW52aXJvbm1lbnR9YDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAxLiBWUEMg4oCUIDIgQVpzLCBwdWJsaWMgLyBwcml2YXRlIC8gaXNvbGF0ZWQgc3VibmV0IHRpZXJzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMudnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1ZwYycsIHtcbiAgICAgIHZwY05hbWU6IGAke3ByZWZpeH0tdnBjYCxcbiAgICAgIG1heEF6czogMixcbiAgICAgIGlwQWRkcmVzc2VzOiBlYzIuSXBBZGRyZXNzZXMuY2lkcignMTAuMC4wLjAvMTYnKSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAnUHVibGljJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ0lzb2xhdGVkJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIG5hdEdhdGV3YXlzOiBpc1Byb2QgPyAyIDogMSxcbiAgICAgIGVuYWJsZURuc0hvc3RuYW1lczogdHJ1ZSxcbiAgICAgIGVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBWUEMgRmxvdyBMb2dzXG4gICAgdGhpcy52cGMuYWRkRmxvd0xvZygnRmxvd0xvZycsIHtcbiAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvQ2xvdWRXYXRjaExvZ3MoXG4gICAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdWcGNGbG93TG9nR3JvdXAnLCB7XG4gICAgICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy92cGMvZmxvd2xvZ3MvJHtwcmVmaXh9YCxcbiAgICAgICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgICAgfSksXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDIuIFNlY3VyaXR5IEdyb3Vwc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFsYlNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdBbGJTZycsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogYCR7cHJlZml4fS1hbGItc2dgLFxuICAgICAgZGVzY3JpcHRpb246ICdBTEIg4oCUIGFsbG93cyBIVFRQIGFuZCBIVFRQUyBmcm9tIHRoZSBpbnRlcm5ldCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuYWxiU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoODApLCAgJ0hUVFAgZnJvbSBpbnRlcm5ldCcpO1xuICAgIHRoaXMuYWxiU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoNDQzKSwgJ0hUVFBTIGZyb20gaW50ZXJuZXQnKTtcblxuICAgIHRoaXMuZWNzU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0Vjc1NnJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBgJHtwcmVmaXh9LWVjcy1zZ2AsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyB0YXNrcyDigJQgYWxsb3cgdHJhZmZpYyBmcm9tIEFMQiBhbmQgd2l0aGluIGNsdXN0ZXInLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcbiAgICB0aGlzLmVjc1NnLmFkZEluZ3Jlc3NSdWxlKHRoaXMuYWxiU2csIGVjMi5Qb3J0LmFsbFRjcCgpLCAnVHJhZmZpYyBmcm9tIEFMQicpO1xuICAgIHRoaXMuZWNzU2cuYWRkSW5ncmVzc1J1bGUodGhpcy5lY3NTZywgZWMyLlBvcnQuYWxsVGNwKCksICdJbnRlci1zZXJ2aWNlIHRyYWZmaWMnKTtcblxuICAgIHRoaXMucmRzU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1Jkc1NnJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBgJHtwcmVmaXh9LXJkcy1zZ2AsXG4gICAgICBkZXNjcmlwdGlvbjogJ1JEUyBQb3N0Z3JlU1FMIOKAlCBhbGxvdyBmcm9tIEVDUyBvbmx5JyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IGZhbHNlLFxuICAgIH0pO1xuICAgIHRoaXMucmRzU2cuYWRkSW5ncmVzc1J1bGUodGhpcy5lY3NTZywgZWMyLlBvcnQudGNwKDU0MzIpLCAnUG9zdGdyZVNRTCBmcm9tIEVDUycpO1xuXG4gICAgdGhpcy5yZWRpc1NnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdSZWRpc1NnJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBgJHtwcmVmaXh9LXJlZGlzLXNnYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRWxhc3RpQ2FjaGUgUmVkaXMg4oCUIGFsbG93IGZyb20gRUNTIG9ubHknLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UsXG4gICAgfSk7XG4gICAgdGhpcy5yZWRpc1NnLmFkZEluZ3Jlc3NSdWxlKHRoaXMuZWNzU2csIGVjMi5Qb3J0LnRjcCg2Mzc5KSwgJ1JlZGlzIGZyb20gRUNTJyk7XG5cbiAgICB0aGlzLm1xU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ01xU2cnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6IGAke3ByZWZpeH0tbXEtc2dgLFxuICAgICAgZGVzY3JpcHRpb246ICdBbWF6b24gTVEgUmFiYml0TVEg4oCUIGFsbG93IGZyb20gRUNTIG9ubHknLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UsXG4gICAgfSk7XG4gICAgdGhpcy5tcVNnLmFkZEluZ3Jlc3NSdWxlKHRoaXMuZWNzU2csIGVjMi5Qb3J0LnRjcCg1NjcxKSwgICdBTVFQUyBmcm9tIEVDUycpO1xuICAgIHRoaXMubXFTZy5hZGRJbmdyZXNzUnVsZSh0aGlzLmVjc1NnLCBlYzIuUG9ydC50Y3AoMTU2NzEpLCAnUmFiYml0TVEgSFRUUFMgbWFuYWdlbWVudCBmcm9tIEVDUycpO1xuXG4gICAgdGhpcy5vcGVuU2VhcmNoU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ09wZW5TZWFyY2hTZycsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogYCR7cHJlZml4fS1vcGVuc2VhcmNoLXNnYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnT3BlblNlYXJjaCDigJQgYWxsb3cgSFRUUFMgZnJvbSBFQ1Mgb25seScsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcbiAgICB9KTtcbiAgICB0aGlzLm9wZW5TZWFyY2hTZy5hZGRJbmdyZXNzUnVsZSh0aGlzLmVjc1NnLCBlYzIuUG9ydC50Y3AoNDQzKSwgJ0hUVFBTIGZyb20gRUNTJyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMy4gU2VjcmV0cyBNYW5hZ2VyIHNlY3JldHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kYlNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0RiU2VjcmV0Jywge1xuICAgICAgc2VjcmV0TmFtZTogYCR7cHJlZml4fS9yZHMvcG9zdGdyZXNgLFxuICAgICAgZGVzY3JpcHRpb246ICdSRFMgUG9zdGdyZVNRTCBtYXN0ZXIgY3JlZGVudGlhbHMnLFxuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHsgdXNlcm5hbWU6ICdlY29tbWVyY2VhZG1pbicgfSksXG4gICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAncGFzc3dvcmQnLFxuICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcXFwnJyxcbiAgICAgICAgcGFzc3dvcmRMZW5ndGg6IDMyLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMucmVkaXNBdXRoU2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnUmVkaXNBdXRoU2VjcmV0Jywge1xuICAgICAgc2VjcmV0TmFtZTogYCR7cHJlZml4fS9yZWRpcy9hdXRoLXRva2VuYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRWxhc3RpQ2FjaGUgUmVkaXMgQVVUSCB0b2tlbicsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcXFwnJyxcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxuICAgICAgICBwYXNzd29yZExlbmd0aDogNjQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5tcVNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ01xU2VjcmV0Jywge1xuICAgICAgc2VjcmV0TmFtZTogYCR7cHJlZml4fS9tcS9yYWJiaXRtcWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FtYXpvbiBNUSBSYWJiaXRNUSBjcmVkZW50aWFscycsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoeyB1c2VybmFtZTogJ2Vjb21tZXJjZWJyb2tlcicgfSksXG4gICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAncGFzc3dvcmQnLFxuICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcXFwnJyxcbiAgICAgICAgcGFzc3dvcmRMZW5ndGg6IDMyLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA0LiBSRFMgUG9zdGdyZVNRTCAxNiDigJQgTXVsdGktQVosIGlzb2xhdGVkIHN1Ym5ldHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGJTdWJuZXRHcm91cCA9IG5ldyByZHMuU3VibmV0R3JvdXAodGhpcywgJ0RiU3VibmV0R3JvdXAnLCB7XG4gICAgICBkZXNjcmlwdGlvbjogYCR7cHJlZml4fSBSRFMgaXNvbGF0ZWQgc3VibmV0IGdyb3VwYCxcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQgfSxcbiAgICAgIHN1Ym5ldEdyb3VwTmFtZTogYCR7cHJlZml4fS1yZHMtc3VibmV0LWdyb3VwYCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRiUGFyYW1ldGVyR3JvdXAgPSBuZXcgcmRzLlBhcmFtZXRlckdyb3VwKHRoaXMsICdEYlBhcmFtZXRlckdyb3VwJywge1xuICAgICAgZW5naW5lOiByZHMuRGF0YWJhc2VJbnN0YW5jZUVuZ2luZS5wb3N0Z3Jlcyh7XG4gICAgICAgIHZlcnNpb246IHJkcy5Qb3N0Z3Jlc0VuZ2luZVZlcnNpb24uVkVSXzE2LFxuICAgICAgfSksXG4gICAgICBkZXNjcmlwdGlvbjogYCR7cHJlZml4fSBQb3N0Z3JlU1FMIDE2IHBhcmFtZXRlciBncm91cGAsXG4gICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICdsb2dfc3RhdGVtZW50JzogICAgICAgICAgJ2FsbCcsXG4gICAgICAgICdsb2dfbWluX2R1cmF0aW9uX3N0YXRlbWVudCc6ICcxMDAwJyxcbiAgICAgICAgJ3NoYXJlZF9wcmVsb2FkX2xpYnJhcmllcyc6ICdwZ19zdGF0X3N0YXRlbWVudHMnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuZGJJbnN0YW5jZSA9IG5ldyByZHMuRGF0YWJhc2VJbnN0YW5jZSh0aGlzLCAnRGJJbnN0YW5jZScsIHtcbiAgICAgIGluc3RhbmNlSWRlbnRpZmllcjogYCR7cHJlZml4fS1wb3N0Z3Jlc2AsXG4gICAgICBlbmdpbmU6IHJkcy5EYXRhYmFzZUluc3RhbmNlRW5naW5lLnBvc3RncmVzKHtcbiAgICAgICAgdmVyc2lvbjogcmRzLlBvc3RncmVzRW5naW5lVmVyc2lvbi5WRVJfMTYsXG4gICAgICB9KSxcbiAgICAgIGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZS5vZihcbiAgICAgICAgZWMyLkluc3RhbmNlQ2xhc3MuVDMsXG4gICAgICAgIGVjMi5JbnN0YW5jZVNpemUuTUVESVVNLFxuICAgICAgKSxcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBzdWJuZXRHcm91cDogZGJTdWJuZXRHcm91cCxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbdGhpcy5yZHNTZ10sXG4gICAgICBjcmVkZW50aWFsczogcmRzLkNyZWRlbnRpYWxzLmZyb21TZWNyZXQodGhpcy5kYlNlY3JldCksXG4gICAgICBtdWx0aUF6OiBpc1Byb2QsXG4gICAgICBhbGxvY2F0ZWRTdG9yYWdlOiAxMDAsXG4gICAgICBtYXhBbGxvY2F0ZWRTdG9yYWdlOiA1MDAsXG4gICAgICBzdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgICAgcGFyYW1ldGVyR3JvdXA6IGRiUGFyYW1ldGVyR3JvdXAsXG4gICAgICBiYWNrdXBSZXRlbnRpb246IGlzUHJvZCA/IGNkay5EdXJhdGlvbi5kYXlzKDE0KSA6IGNkay5EdXJhdGlvbi5kYXlzKDMpLFxuICAgICAgcHJlZmVycmVkQmFja3VwV2luZG93OiAnMDM6MDAtMDQ6MDAnLFxuICAgICAgcHJlZmVycmVkTWFpbnRlbmFuY2VXaW5kb3c6ICdzdW46MDQ6MDAtc3VuOjA1OjAwJyxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogaXNQcm9kLFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVuYWJsZVBlcmZvcm1hbmNlSW5zaWdodHM6IHRydWUsXG4gICAgICBwZXJmb3JtYW5jZUluc2lnaHRSZXRlbnRpb246IHJkcy5QZXJmb3JtYW5jZUluc2lnaHRSZXRlbnRpb24uREVGQVVMVCxcbiAgICAgIGNsb3Vkd2F0Y2hMb2dzRXhwb3J0czogWydwb3N0Z3Jlc3FsJywgJ3VwZ3JhZGUnXSxcbiAgICAgIGNsb3Vkd2F0Y2hMb2dzUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgYXV0b01pbm9yVmVyc2lvblVwZ3JhZGU6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBSRFMgaW5pdCBzY3JpcHQg4oCUIGNyZWF0ZSB0aGUgNSBhcHBsaWNhdGlvbiBkYXRhYmFzZXNcbiAgICAvLyBUaGUgc2NyaXB0IHJ1bnMgYXMgYSBjdXN0b20gcmVzb3VyY2UgYWZ0ZXIgdGhlIGluc3RhbmNlIGlzIGF2YWlsYWJsZS5cbiAgICAvLyBXZSBzdG9yZSB0aGUgU1FMIGluIGEgQ2xvdWRGb3JtYXRpb24gT3V0cHV0IGZvciByZWZlcmVuY2UuXG4gICAgY29uc3QgZGJJbml0U3FsID0gZGF0YWJhc2VzLm1hcChkYiA9PiBgQ1JFQVRFIERBVEFCQVNFICR7ZGJ9O2ApLmpvaW4oJ1xcbicpO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYkluaXRTcWwnLCB7XG4gICAgICB2YWx1ZTogZGJJbml0U3FsLFxuICAgICAgZGVzY3JpcHRpb246ICdSdW4gdGhpcyBTUUwgb24gdGhlIFJEUyBpbnN0YW5jZSB0byBjcmVhdGUgYXBwbGljYXRpb24gZGF0YWJhc2VzJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3ByZWZpeH0tZGItaW5pdC1zcWxgLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDUuIEVsYXN0aUNhY2hlIFNlcnZlcmxlc3MgUmVkaXMg4oCUIHByaXZhdGUgc3VibmV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCByZWRpc1N1Ym5ldEdyb3VwID0gbmV3IGVsYXN0aWNhY2hlLkNmblN1Ym5ldEdyb3VwKHRoaXMsICdSZWRpc1N1Ym5ldEdyb3VwJywge1xuICAgICAgZGVzY3JpcHRpb246IGAke3ByZWZpeH0gRWxhc3RpQ2FjaGUgcHJpdmF0ZSBzdWJuZXQgZ3JvdXBgLFxuICAgICAgc3VibmV0SWRzOiB0aGlzLnZwYy5zZWxlY3RTdWJuZXRzKHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0pLnN1Ym5ldElkcyxcbiAgICAgIGNhY2hlU3VibmV0R3JvdXBOYW1lOiBgJHtwcmVmaXh9LXJlZGlzLXN1Ym5ldC1ncm91cGAsXG4gICAgfSk7XG5cbiAgICB0aGlzLnJlZGlzU2VydmVybGVzc0NhY2hlID0gbmV3IGVsYXN0aWNhY2hlLkNmblNlcnZlcmxlc3NDYWNoZSh0aGlzLCAnUmVkaXNTZXJ2ZXJsZXNzJywge1xuICAgICAgc2VydmVybGVzc0NhY2hlTmFtZTogYCR7cHJlZml4fS1yZWRpc2AsXG4gICAgICBlbmdpbmU6ICdyZWRpcycsXG4gICAgICBkZXNjcmlwdGlvbjogYCR7cHJlZml4fSBzZXJ2ZXJsZXNzIFJlZGlzIGNhY2hlYCxcbiAgICAgIHNlY3VyaXR5R3JvdXBJZHM6IFt0aGlzLnJlZGlzU2cuc2VjdXJpdHlHcm91cElkXSxcbiAgICAgIHN1Ym5ldElkczogdGhpcy52cGMuc2VsZWN0U3VibmV0cyh7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9KS5zdWJuZXRJZHMsXG4gICAgICB1c2VyR3JvdXBJZDogdW5kZWZpbmVkLCAgLy8gb3BlbiB0byBFQ1Mgc2cg4oCUIGF1dGggdmlhIHRva2VuIGF0IGFwcCBsZXZlbFxuICAgICAgY2FjaGVVc2FnZUxpbWl0czoge1xuICAgICAgICBkYXRhU3RvcmFnZToge1xuICAgICAgICAgIG1heGltdW06IDEwLFxuICAgICAgICAgIHVuaXQ6ICdHQicsXG4gICAgICAgIH0sXG4gICAgICAgIGVjcHVQZXJTZWNvbmQ6IHtcbiAgICAgICAgICBtYXhpbXVtOiA1MDAwLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB0aGlzLnJlZGlzU2VydmVybGVzc0NhY2hlLmFkZERlcGVuZGVuY3kocmVkaXNTdWJuZXRHcm91cCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gNi4gQW1hem9uIE1RIOKAlCBSYWJiaXRNUSBicm9rZXJcbiAgICAvLyAgICBkZXY6IHNpbmdsZS1pbnN0YW5jZSAgIHByb2Q6IGFjdGl2ZS1zdGFuZGJ5IChDTFVTVEVSX01VTFRJX0FaKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBtcVBhc3N3b3JkID0gdGhpcy5tcVNlY3JldC5zZWNyZXRWYWx1ZUZyb21Kc29uKCdwYXNzd29yZCcpLnVuc2FmZVVud3JhcCgpO1xuICAgIGNvbnN0IG1xVXNlcm5hbWUgPSAnZWNvbW1lcmNlYnJva2VyJztcblxuICAgIHRoaXMubXFCcm9rZXIgPSBuZXcgYW1hem9ubXEuQ2ZuQnJva2VyKHRoaXMsICdNcUJyb2tlcicsIHtcbiAgICAgIGJyb2tlck5hbWU6IGAke3ByZWZpeH0tcmFiYml0bXFgLFxuICAgICAgZW5naW5lVHlwZTogJ1JBQkJJVE1RJyxcbiAgICAgIGVuZ2luZVZlcnNpb246ICczLjEzJyxcbiAgICAgIGhvc3RJbnN0YW5jZVR5cGU6ICdtcS5tNS5sYXJnZScsXG4gICAgICBkZXBsb3ltZW50TW9kZTogaXNQcm9kID8gJ0NMVVNURVJfTVVMVElfQVonIDogJ1NJTkdMRV9JTlNUQU5DRScsXG4gICAgICBwdWJsaWNseUFjY2Vzc2libGU6IGZhbHNlLFxuICAgICAgYXV0b01pbm9yVmVyc2lvblVwZ3JhZGU6IHRydWUsXG4gICAgICB1c2VyczogW1xuICAgICAgICB7XG4gICAgICAgICAgdXNlcm5hbWU6IG1xVXNlcm5hbWUsXG4gICAgICAgICAgcGFzc3dvcmQ6IG1xUGFzc3dvcmQsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgc3VibmV0SWRzOiBpc1Byb2RcbiAgICAgICAgPyB0aGlzLnZwYy5zZWxlY3RTdWJuZXRzKHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9KS5zdWJuZXRJZHMuc2xpY2UoMCwgMilcbiAgICAgICAgOiBbdGhpcy52cGMuc2VsZWN0U3VibmV0cyh7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSkuc3VibmV0SWRzWzBdXSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbdGhpcy5tcVNnLnNlY3VyaXR5R3JvdXBJZF0sXG4gICAgICBsb2dzOiB7XG4gICAgICAgIGdlbmVyYWw6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDcuIEFtYXpvbiBPcGVuU2VhcmNoIFNlcnZpY2Ug4oCUIGRldiBzaW5nbGUtbm9kZSwgVlBDIGVuZHBvaW50XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IG9wZW5TZWFyY2hTdWJuZXRzID0gdGhpcy52cGMuc2VsZWN0U3VibmV0cyh7XG4gICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgb25lUGVyQXo6IHRydWUsXG4gICAgfSk7XG5cbiAgICB0aGlzLm9wZW5TZWFyY2hEb21haW4gPSBuZXcgb3BlbnNlYXJjaC5Eb21haW4odGhpcywgJ09wZW5TZWFyY2hEb21haW4nLCB7XG4gICAgICBkb21haW5OYW1lOiBgJHtwcmVmaXh9LXNlYXJjaGAsXG4gICAgICB2ZXJzaW9uOiBvcGVuc2VhcmNoLkVuZ2luZVZlcnNpb24uT1BFTlNFQVJDSF8yXzEzLFxuICAgICAgY2FwYWNpdHk6IHtcbiAgICAgICAgbWFzdGVyTm9kZXM6IDAsICAgICAgICAgICAgICAgICAgICAgICAgLy8gbm8gZGVkaWNhdGVkIG1hc3RlciBmb3IgZGV2XG4gICAgICAgIGRhdGFOb2RlczogaXNQcm9kID8gMyA6IDEsXG4gICAgICAgIGRhdGFOb2RlSW5zdGFuY2VUeXBlOiAndDMuc21hbGwuc2VhcmNoJyxcbiAgICAgICAgbXVsdGlBeldpdGhTdGFuZGJ5RW5hYmxlZDogZmFsc2UsXG4gICAgICB9LFxuICAgICAgZWJzOiB7XG4gICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgIHZvbHVtZVNpemU6IDIwLFxuICAgICAgICB2b2x1bWVUeXBlOiBlYzIuRWJzRGV2aWNlVm9sdW1lVHlwZS5HUDMsXG4gICAgICB9LFxuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IGlzUHJvZFxuICAgICAgICA/IFt7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfV1cbiAgICAgICAgOiBbeyBzdWJuZXRzOiBbb3BlblNlYXJjaFN1Ym5ldHMuc3VibmV0c1swXV0gfV0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW3RoaXMub3BlblNlYXJjaFNnXSxcbiAgICAgIHpvbmVBd2FyZW5lc3M6IHtcbiAgICAgICAgZW5hYmxlZDogaXNQcm9kLFxuICAgICAgICBhdmFpbGFiaWxpdHlab25lQ291bnQ6IGlzUHJvZCA/IDMgOiAyLFxuICAgICAgfSxcbiAgICAgIGVuZm9yY2VIdHRwczogdHJ1ZSxcbiAgICAgIG5vZGVUb05vZGVFbmNyeXB0aW9uOiB0cnVlLFxuICAgICAgZW5jcnlwdGlvbkF0UmVzdDogeyBlbmFibGVkOiB0cnVlIH0sXG4gICAgICB1c2VVbnNpZ25lZEJhc2ljQXV0aDogZmFsc2UsXG4gICAgICBmaW5lR3JhaW5lZEFjY2Vzc0NvbnRyb2w6IHtcbiAgICAgICAgbWFzdGVyVXNlck5hbWU6ICdlY29tbWVyY2Utb3MtYWRtaW4nLFxuICAgICAgfSxcbiAgICAgIGxvZ2dpbmc6IHtcbiAgICAgICAgc2xvd1NlYXJjaExvZ0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGFwcExvZ0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIHNsb3dJbmRleExvZ0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGF1ZGl0TG9nRW5hYmxlZDogZmFsc2UsXG4gICAgICB9LFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA4LiBFQ1MgQ2x1c3RlciDigJQgRmFyZ2F0ZSB3aXRoIENvbnRhaW5lciBJbnNpZ2h0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmVjc0NsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0Vjc0NsdXN0ZXInLCB7XG4gICAgICBjbHVzdGVyTmFtZTogYCR7cHJlZml4fS1jbHVzdGVyYCxcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBjb250YWluZXJJbnNpZ2h0c1YyOiBlY3MuQ29udGFpbmVySW5zaWdodHMuRU5BQkxFRCxcbiAgICAgIGVuYWJsZUZhcmdhdGVDYXBhY2l0eVByb3ZpZGVyczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA5LiBBV1MgQ2xvdWQgTWFwIOKAlCBwcml2YXRlIEROUyBuYW1lc3BhY2UgZm9yIHNlcnZpY2UgZGlzY292ZXJ5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuc2VydmljZURpc2NvdmVyeU5hbWVzcGFjZSA9IG5ldyBzZXJ2aWNlZGlzY292ZXJ5LlByaXZhdGVEbnNOYW1lc3BhY2UoXG4gICAgICB0aGlzLFxuICAgICAgJ1NlcnZpY2VEaXNjb3ZlcnlOYW1lc3BhY2UnLFxuICAgICAge1xuICAgICAgICBuYW1lOiBgJHtwcmVmaXh9LmxvY2FsYCxcbiAgICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgICAgZGVzY3JpcHRpb246IGAke3ByZWZpeH0gaW50ZXJuYWwgc2VydmljZSBkaXNjb3ZlcnkgbmFtZXNwYWNlYCxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAxMC4gSUFNIFJvbGVzIOKAlCBFQ1MgVGFzayBFeGVjdXRpb24gUm9sZSArIFRhc2sgUm9sZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIEV4ZWN1dGlvbiBSb2xlIOKAlCBwdWxsZWQgYnkgdGhlIEVDUyBjb250cm9sIHBsYW5lIHRvIHN0YXJ0IHRoZSBjb250YWluZXJcbiAgICB0aGlzLmVjc0V4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vjc0V4ZWN1dGlvblJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7cHJlZml4fS1lY3MtZXhlY3V0aW9uLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFxuICAgICAgICAgICdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knLFxuICAgICAgICApLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IGV4ZWN1dGlvbiByb2xlIHRvIHJlYWQgc2VjcmV0cyAoZm9yIHNlY3JldHMgaW5qZWN0aW9uIGF0IHRhc2sgc3RhcnQpXG4gICAgdGhpcy5kYlNlY3JldC5ncmFudFJlYWQodGhpcy5lY3NFeGVjdXRpb25Sb2xlKTtcbiAgICB0aGlzLnJlZGlzQXV0aFNlY3JldC5ncmFudFJlYWQodGhpcy5lY3NFeGVjdXRpb25Sb2xlKTtcbiAgICB0aGlzLm1xU2VjcmV0LmdyYW50UmVhZCh0aGlzLmVjc0V4ZWN1dGlvblJvbGUpO1xuXG4gICAgLy8gVGFzayBSb2xlIOKAlCBhc3N1bWVkIGJ5IHRoZSBydW5uaW5nIGFwcGxpY2F0aW9uIGNvZGVcbiAgICB0aGlzLmVjc1Rhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFY3NUYXNrUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgJHtwcmVmaXh9LWVjcy10YXNrLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBYUmF5V3JpdGVQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgc2lkOiAnWFJheVdyaXRlJyxcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3hyYXk6UHV0VHJhY2VTZWdtZW50cycsXG4gICAgICAgICAgICAgICAgJ3hyYXk6UHV0VGVsZW1ldHJ5UmVjb3JkcycsXG4gICAgICAgICAgICAgICAgJ3hyYXk6R2V0U2FtcGxpbmdSdWxlcycsXG4gICAgICAgICAgICAgICAgJ3hyYXk6R2V0U2FtcGxpbmdUYXJnZXRzJyxcbiAgICAgICAgICAgICAgICAneHJheTpHZXRTYW1wbGluZ1N0YXRpc3RpY1N1bW1hcmllcycsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgU2VjcmV0c01hbmFnZXJSZWFkUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIHNpZDogJ1NlY3JldHNSZWFkJyxcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgICB0aGlzLmRiU2VjcmV0LnNlY3JldEFybixcbiAgICAgICAgICAgICAgICB0aGlzLnJlZGlzQXV0aFNlY3JldC5zZWNyZXRBcm4sXG4gICAgICAgICAgICAgICAgdGhpcy5tcVNlY3JldC5zZWNyZXRBcm4sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3NQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgc2lkOiAnQ1dMb2dzJyxcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcbiAgICAgICAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnYXJuOmF3czpsb2dzOio6Kjpsb2ctZ3JvdXA6L2Vjb21tZXJjZS8qJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgRWNyUmVhZFBvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBzaWQ6ICdFY3JSZWFkJyxcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JyxcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RhY2sgT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVnBjSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy52cGMudnBjSWQsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LXZwYy1pZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGJJbnN0YW5jZUVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMuZGJJbnN0YW5jZS5pbnN0YW5jZUVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1kYi1lbmRwb2ludGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGJTZWNyZXRBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5kYlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWRiLXNlY3JldC1hcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JlZGlzRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yZWRpc1NlcnZlcmxlc3NDYWNoZS5hdHRyRW5kcG9pbnRBZGRyZXNzLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1yZWRpcy1lbmRwb2ludGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTXFCcm9rZXJBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5tcUJyb2tlci5yZWYsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LW1xLWJyb2tlci1hcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09wZW5TZWFyY2hFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9wZW5TZWFyY2hEb21haW4uZG9tYWluRW5kcG9pbnQsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LW9wZW5zZWFyY2gtZW5kcG9pbnRgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Vjc0NsdXN0ZXJOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuZWNzQ2x1c3Rlci5jbHVzdGVyTmFtZSxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3ByZWZpeH0tZWNzLWNsdXN0ZXItbmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZURpc2NvdmVyeU5hbWVzcGFjZUlkJywge1xuICAgICAgdmFsdWU6IHRoaXMuc2VydmljZURpc2NvdmVyeU5hbWVzcGFjZS5uYW1lc3BhY2VJZCxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3ByZWZpeH0tc2QtbmFtZXNwYWNlLWlkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3NUYXNrUm9sZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmVjc1Rhc2tSb2xlLnJvbGVBcm4sXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWVjcy10YXNrLXJvbGUtYXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3NFeGVjdXRpb25Sb2xlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuZWNzRXhlY3V0aW9uUm9sZS5yb2xlQXJuLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1lY3MtZXhlY3V0aW9uLXJvbGUtYXJuYCxcbiAgICB9KTtcbiAgfVxufVxuIl19