"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ECommerceStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const rds = require("aws-cdk-lib/aws-rds");
const elasticache = require("aws-cdk-lib/aws-elasticache");
const opensearch = require("aws-cdk-lib/aws-opensearchservice");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecr = require("aws-cdk-lib/aws-ecr");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const servicediscovery = require("aws-cdk-lib/aws-servicediscovery");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
const cr = require("aws-cdk-lib/custom-resources");
const ALL_SERVICES = [
    'api-gateway', 'catalog-api', 'order-api', 'identity-api',
    'inventory-api', 'payment-api', 'notification-api', 'blazor-frontend',
];
const SERVICE_CPU = {
    'api-gateway': 512, 'catalog-api': 512, 'order-api': 512,
    'identity-api': 512, 'inventory-api': 256, 'payment-api': 256,
    'notification-api': 256, 'blazor-frontend': 512,
};
const SERVICE_MEM = {
    'api-gateway': 1024, 'catalog-api': 1024, 'order-api': 1024,
    'identity-api': 1024, 'inventory-api': 512, 'payment-api': 512,
    'notification-api': 512, 'blazor-frontend': 1024,
};
const DB_SERVICES = {
    'catalog-api': 'catalog_db', 'order-api': 'order_db',
    'identity-api': 'identity_db', 'inventory-api': 'inventory_db',
    'payment-api': 'payment_db',
};
class ECommerceStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config } = props;
        const isProd = config.environment === 'prod';
        const prefix = `ecommerce-${config.environment}`;
        // Messaging: Amazon SQS/SNS via MassTransit (replaces Amazon MQ — no broker, IAM auth)
        // =========================================================================
        // 1. VPC
        // =========================================================================
        const vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `${prefix}-vpc`,
            maxAzs: 2,
            natGateways: isProd ? 2 : 0, // dev: no NAT GW, EC2 gets public IP via public subnet
            subnetConfiguration: [
                { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
        });
        // =========================================================================
        // 2. Security Groups
        // =========================================================================
        const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'ALB', allowAllOutbound: true });
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
        const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', { vpc, description: 'ECS tasks', allowAllOutbound: true });
        ecsSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to ECS');
        ecsSg.addIngressRule(ecsSg, ec2.Port.allTcp(), 'Service mesh');
        const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', { vpc, description: 'RDS', allowAllOutbound: false });
        rdsSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), 'ECS to RDS');
        const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'Redis', allowAllOutbound: false });
        redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), 'ECS to Redis');
        const openSearchSg = new ec2.SecurityGroup(this, 'OsSg', { vpc, description: 'OpenSearch', allowAllOutbound: false });
        openSearchSg.addIngressRule(ecsSg, ec2.Port.tcp(443), 'ECS to OpenSearch');
        // =========================================================================
        // 3. Secrets Manager
        // =========================================================================
        const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
            secretName: `${prefix}/rds/postgres`,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: 'ecommerceadmin' }),
                generateStringKey: 'password',
                excludeCharacters: '"@/\\\'',
            },
        });
        const redisAuthSecret = new secretsmanager.Secret(this, 'RedisAuthSecret', {
            secretName: `${prefix}/redis/auth-token`,
            generateSecretString: { excludeCharacters: '"@/\\\'', passwordLength: 32 },
        });
        // MQ secret is created later (section 6) using the CfnParameter value
        // =========================================================================
        // 4. RDS PostgreSQL 16
        // =========================================================================
        const dbInstance = new rds.DatabaseInstance(this, 'Rds', {
            instanceIdentifier: `${prefix}-postgres`,
            engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [rdsSg],
            credentials: rds.Credentials.fromSecret(dbSecret),
            multiAz: isProd,
            storageEncrypted: true,
            deletionProtection: isProd,
            backupRetention: isProd ? cdk.Duration.days(7) : cdk.Duration.days(1),
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });
        // =========================================================================
        // 5. ElastiCache Serverless Redis
        // =========================================================================
        const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
            description: `${prefix} redis subnet group`,
            subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
            cacheSubnetGroupName: `${prefix}-redis-subnet`,
        });
        const redis = new elasticache.CfnServerlessCache(this, 'Redis', {
            serverlessCacheName: `${prefix}-redis`,
            engine: 'redis',
            subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
            securityGroupIds: [redisSg.securityGroupId],
        });
        redis.addDependency(redisSubnetGroup);
        // =========================================================================
        // 6. Messaging: Amazon SQS/SNS (MassTransit auto-creates queues/topics on startup)
        // No broker needed — IAM auth via ECS task role
        // =========================================================================
        // 7. Amazon OpenSearch Service
        // =========================================================================
        // Ensure Service-Linked Role exists before OpenSearch VPC deployment.
        // ignoreErrorCodesMatching handles the case where the role already exists.
        const openSearchSlr = new cr.AwsCustomResource(this, 'OpenSearchSLR', {
            onCreate: {
                service: 'IAM',
                action: 'createServiceLinkedRole',
                parameters: { AWSServiceName: 'opensearchservice.amazonaws.com' },
                ignoreErrorCodesMatching: 'InvalidInput',
                physicalResourceId: cr.PhysicalResourceId.of('opensearch-slr'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
        });
        const openSearchDomain = new opensearch.Domain(this, 'OpenSearch', {
            domainName: `${prefix}-search`,
            version: opensearch.EngineVersion.OPENSEARCH_2_13,
            capacity: {
                dataNodes: isProd ? 3 : 1,
                dataNodeInstanceType: 't3.small.search',
                multiAzWithStandbyEnabled: false,
            },
            ebs: { enabled: true, volumeSize: 20, volumeType: ec2.EbsDeviceVolumeType.GP3 },
            vpc,
            vpcSubnets: [{ subnets: [vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED, onePerAz: true }).subnets[0]] }],
            securityGroups: [openSearchSg],
            zoneAwareness: { enabled: false },
            enforceHttps: true,
            nodeToNodeEncryption: true,
            encryptionAtRest: { enabled: true },
            useUnsignedBasicAuth: false,
            fineGrainedAccessControl: { masterUserName: 'ecommerce-os-admin' },
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });
        openSearchDomain.node.addDependency(openSearchSlr);
        // =========================================================================
        // 8. ECS Cluster + EC2 Auto Scaling Group + Cloud Map
        // =========================================================================
        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `${prefix}-cluster`,
            vpc,
            containerInsightsV2: ecs.ContainerInsights.ENABLED,
        });
        // Explicit Launch Template — new AWS accounts don't support LaunchConfiguration
        const instanceRole = new iam.Role(this, 'EcsInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });
        const launchTemplate = new ec2.LaunchTemplate(this, 'EcsLaunchTemplate', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            role: instanceRole,
            securityGroup: ecsSg,
            requireImdsv2: true,
            associatePublicIpAddress: !isProd, // dev: public IP replaces NAT Gateway
            userData: ec2.UserData.forLinux(),
        });
        const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
            autoScalingGroupName: `${prefix}-ecs-asg`,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            launchTemplate,
            minCapacity: 2,
            maxCapacity: isProd ? 10 : 4,
            desiredCapacity: 2,
            newInstancesProtectedFromScaleIn: false,
        });
        const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
            autoScalingGroup: asg,
            enableManagedScaling: true,
            enableManagedTerminationProtection: false,
        });
        cluster.addAsgCapacityProvider(capacityProvider);
        const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
            name: `${prefix}.local`,
            vpc,
        });
        // =========================================================================
        // 9. IAM Roles
        // =========================================================================
        const executionRole = new iam.Role(this, 'EcsExecutionRole', {
            roleName: `${prefix}-ecs-execution-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });
        dbSecret.grantRead(executionRole);
        redisAuthSecret.grantRead(executionRole);
        const taskRole = new iam.Role(this, 'EcsTaskRole', {
            roleName: `${prefix}-ecs-task-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords',
                'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            resources: [dbSecret.secretArn, redisAuthSecret.secretArn],
        }));
        // SQS/SNS for MassTransit (replaces Amazon MQ)
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'sqs:*',
                'sns:*',
            ],
            resources: [`arn:aws:sqs:${this.region}:${this.account}:*`,
                `arn:aws:sns:${this.region}:${this.account}:*`],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: ['arn:aws:logs:*:*:log-group:/ecommerce/*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
                'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'],
            resources: ['*'],
        }));
        // =========================================================================
        // 10. ECR Repositories
        // =========================================================================
        const ecrRepos = {};
        for (const svc of ALL_SERVICES) {
            const repo = new ecr.Repository(this, `Ecr-${svc}`, {
                repositoryName: `${prefix}/${svc}`,
                imageScanOnPush: true,
                lifecycleRules: [{ maxImageCount: 10 }],
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });
            ecrRepos[svc] = repo;
        }
        // =========================================================================
        // 11. ALB
        // =========================================================================
        const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            loadBalancerName: `${prefix}-alb`,
            vpc,
            internetFacing: true,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            securityGroup: albSg,
        });
        const listener = alb.addListener('HttpListener', {
            port: 80,
            open: true,
        });
        // =========================================================================
        // 12. Fargate Services
        // =========================================================================
        for (const svc of ALL_SERVICES) {
            const logGroup = new logs.LogGroup(this, `Log-${svc}`, {
                logGroupName: `/ecommerce/${config.environment}/${svc}`,
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });
            // EC2 task definition (no Fargate vCPU quota required)
            const taskDef = new ecs.TaskDefinition(this, `Task-${svc}`, {
                family: `${prefix}-${svc}`,
                compatibility: ecs.Compatibility.EC2,
                networkMode: ecs.NetworkMode.AWS_VPC,
                cpu: String(SERVICE_CPU[svc]),
                memoryMiB: String(SERVICE_MEM[svc]),
                executionRole,
                taskRole,
            });
            const appContainer = taskDef.addContainer(`app`, {
                image: ecs.ContainerImage.fromEcrRepository(ecrRepos[svc], 'latest'),
                logging: ecs.LogDrivers.awsLogs({ streamPrefix: svc, logGroup }),
                portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
                environment: {
                    ASPNETCORE_ENVIRONMENT: config.environment === 'dev' ? 'Development' : 'Production',
                    ASPNETCORE_URLS: 'http://+:8080',
                    AWS_REGION: config.region,
                    DB_HOST: dbInstance.instanceEndpoint.hostname,
                    DB_PORT: '5432',
                    ...(DB_SERVICES[svc] ? { DB_NAME: DB_SERVICES[svc] } : {}),
                    REDIS_ENDPOINT: redis.attrEndpointAddress,
                    OPENSEARCH_ENDPOINT: `https://${openSearchDomain.domainEndpoint}`,
                    AWS_XRAY_DAEMON_ADDRESS: 'xray-daemon:2000',
                },
                secrets: {
                    DB_SECRET_JSON: ecs.Secret.fromSecretsManager(dbSecret),
                },
                memoryLimitMiB: SERVICE_MEM[svc] - 256,
                essential: true,
            });
            // X-Ray daemon sidecar
            const xrayContainer = taskDef.addContainer('xray-daemon', {
                image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
                logging: ecs.LogDrivers.awsLogs({
                    streamPrefix: `${svc}-xray`,
                    logGroup: new logs.LogGroup(this, `XrayLog-${svc}`, {
                        logGroupName: `/ecommerce/${config.environment}/${svc}/xray`,
                        retention: logs.RetentionDays.THREE_DAYS,
                        removalPolicy: cdk.RemovalPolicy.DESTROY,
                    }),
                }),
                portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }],
                essential: false,
                memoryLimitMiB: 256,
                cpu: 32,
            });
            appContainer.addContainerDependencies({
                container: xrayContainer,
                condition: ecs.ContainerDependencyCondition.START,
            });
            const ec2Service = new ecs.Ec2Service(this, `Svc-${svc}`, {
                serviceName: `${prefix}-${svc}`,
                cluster,
                taskDefinition: taskDef,
                desiredCount: 0, // Start at 0; scale up after pushing real images
                vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
                securityGroups: [ecsSg],
                enableExecuteCommand: true,
                circuitBreaker: { enable: false }, // Disabled during initial infra deploy
                capacityProviderStrategies: [{
                        capacityProvider: capacityProvider.capacityProviderName,
                        weight: 1,
                    }],
                cloudMapOptions: {
                    name: svc,
                    cloudMapNamespace: namespace,
                    dnsRecordType: servicediscovery.DnsRecordType.A,
                    dnsTtl: cdk.Duration.seconds(30),
                },
            });
            // Only api-gateway is wired to the ALB
            if (svc === 'api-gateway') {
                const tg = listener.addTargets(`Tg-${svc}`, {
                    targetGroupName: `${prefix}-${svc}`,
                    port: 8080,
                    protocol: elbv2.ApplicationProtocol.HTTP,
                    targets: [ec2Service],
                    healthCheck: {
                        path: '/health',
                        interval: cdk.Duration.seconds(30),
                        timeout: cdk.Duration.seconds(5),
                        healthyHttpCodes: '200',
                    },
                    deregistrationDelay: cdk.Duration.seconds(30),
                });
            }
        }
        // =========================================================================
        // Outputs
        // =========================================================================
        new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName, exportName: `${prefix}-alb-dns` });
        new cdk.CfnOutput(this, 'DbEndpoint', { value: dbInstance.instanceEndpoint.hostname, exportName: `${prefix}-db-endpoint` });
        new cdk.CfnOutput(this, 'RedisEndpoint', { value: redis.attrEndpointAddress, exportName: `${prefix}-redis-endpoint` });
        new cdk.CfnOutput(this, 'OpenSearchEp', { value: openSearchDomain.domainEndpoint, exportName: `${prefix}-opensearch-endpoint` });
        new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName, exportName: `${prefix}-cluster-name` });
        new cdk.CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn, exportName: `${prefix}-db-secret-arn` });
    }
}
exports.ECommerceStack = ECommerceStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNvbW1lcmNlLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL2Vjb21tZXJjZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyREFBMkQ7QUFDM0QsZ0VBQWdFO0FBQ2hFLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsZ0VBQWdFO0FBQ2hFLGlFQUFpRTtBQUNqRSxxRUFBcUU7QUFDckUsMkNBQTJDO0FBQzNDLDZDQUE2QztBQUM3QywyREFBMkQ7QUFDM0QsbURBQW1EO0FBT25ELE1BQU0sWUFBWSxHQUFHO0lBQ25CLGFBQWEsRUFBRSxhQUFhLEVBQUUsV0FBVyxFQUFFLGNBQWM7SUFDekQsZUFBZSxFQUFFLGFBQWEsRUFBRSxrQkFBa0IsRUFBRSxpQkFBaUI7Q0FDN0QsQ0FBQztBQUdYLE1BQU0sV0FBVyxHQUFnQztJQUMvQyxhQUFhLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEdBQUc7SUFDeEQsY0FBYyxFQUFFLEdBQUcsRUFBRSxlQUFlLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxHQUFHO0lBQzdELGtCQUFrQixFQUFFLEdBQUcsRUFBRSxpQkFBaUIsRUFBRSxHQUFHO0NBQ2hELENBQUM7QUFDRixNQUFNLFdBQVcsR0FBZ0M7SUFDL0MsYUFBYSxFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxJQUFJO0lBQzNELGNBQWMsRUFBRSxJQUFJLEVBQUUsZUFBZSxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsR0FBRztJQUM5RCxrQkFBa0IsRUFBRSxHQUFHLEVBQUUsaUJBQWlCLEVBQUUsSUFBSTtDQUNqRCxDQUFDO0FBQ0YsTUFBTSxXQUFXLEdBQXlDO0lBQ3hELGFBQWEsRUFBRSxZQUFZLEVBQUUsV0FBVyxFQUFFLFVBQVU7SUFDcEQsY0FBYyxFQUFF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LEVBQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLFNBQVMsRUFBZ0IsVUFBVSxFQUFFLEdBQUcsTUFBTSxnQkFBZ0IsRUFBRSxDQUFDLENBQUM7SUFDakksQ0FBQztDQUNGO0FBelhELHdDQXlYQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIHJkcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtcmRzJztcbmltcG9ydCAqIGFzIGVsYXN0aWNhY2hlIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljYWNoZSc7XG5pbXBvcnQgKiBhcyBvcGVuc2VhcmNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1vcGVuc2VhcmNoc2VydmljZSc7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0ICogYXMgc2VydmljZWRpc2NvdmVyeSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VydmljZWRpc2NvdmVyeSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcbmltcG9ydCB7IEVudkNvbmZpZyB9IGZyb20gJy4vY29uZmlnJztcblxuZXhwb3J0IGludGVyZmFjZSBFQ29tbWVyY2VTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBjb25maWc6IEVudkNvbmZpZztcbn1cblxuY29uc3QgQUxMX1NFUlZJQ0VTID0gW1xuICAnYXBpLWdhdGV3YXknLCAnY2F0YWxvZy1hcGknLCAnb3JkZXItYXBpJywgJ2lkZW50aXR5LWFwaScsXG4gICdpbnZlbnRvcnktYXBpJywgJ3BheW1lbnQtYXBpJywgJ25vdGlmaWNhdGlvbi1hcGknLCAnYmxhem9yLWZyb250ZW5kJyxcbl0gYXMgY29uc3Q7XG50eXBlIFNlcnZpY2VOYW1lID0gdHlwZW9mIEFMTF9TRVJWSUNFU1tudW1iZXJdO1xuXG5jb25zdCBTRVJWSUNFX0NQVTogUmVjb3JkPFNlcnZpY2VOYW1lLCBudW1iZXI+ID0ge1xuICAnYXBpLWdhdGV3YXknOiA1MTIsICdjYXRhbG9nLWFwaSc6IDUxMiwgJ29yZGVyLWFwaSc6IDUxMixcbiAgJ2lkZW50aXR5LWFwaSc6IDUxMiwgJ2ludmVudG9yeS1hcGknOiAyNTYsICdwYXltZW50LWFwaSc6IDI1NixcbiAgJ25vdGlmaWNhdGlvbi1hcGknOiAyNTYsICdibGF6b3ItZnJvbnRlbmQnOiA1MTIsXG59O1xuY29uc3QgU0VSVklDRV9NRU06IFJlY29yZDxTZXJ2aWNlTmFtZSwgbnVtYmVyPiA9IHtcbiAgJ2FwaS1nYXRld2F5JzogMTAyNCwgJ2NhdGFsb2ctYXBpJzogMTAyNCwgJ29yZGVyLWFwaSc6IDEwMjQsXG4gICdpZGVudGl0eS1hcGknOiAxMDI0LCAnaW52ZW50b3J5LWFwaSc6IDUxMiwgJ3BheW1lbnQtYXBpJzogNTEyLFxuICAnbm90aWZpY2F0aW9uLWFwaSc6IDUxMiwgJ2JsYXpvci1mcm9udGVuZCc6IDEwMjQsXG59O1xuY29uc3QgREJfU0VSVklDRVM6IFBhcnRpYWw8UmVjb3JkPFNlcnZpY2VOYW1lLCBzdHJpbmc+PiA9IHtcbiAgJ2NhdGFsb2ctYXBpJzogJ2NhdGFsb2dfZGInLCAnb3JkZXItYXBpJzogJ29yZGVyX2RiJyxcbiAgJ2lkZW50aXR5LWFwaSc6ICdpZGVudGl0eV9kYicsICdpbnZlbnRvcnktYXBpJzogJ2ludmVudG9yeV9kYicsXG4gICdwYXltZW50LWFwaSc6ICdwYXltZW50X2RiJyxcbn07XG5cbmV4cG9ydCBjbGFzcyBFQ29tbWVyY2VTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBFQ29tbWVyY2VTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB7IGNvbmZpZyB9ID0gcHJvcHM7XG4gICAgY29uc3QgaXNQcm9kID0gY29uZmlnLmVudmlyb25tZW50ID09PSAncHJvZCc7XG4gICAgY29uc3QgcHJlZml4ID0gYGVjb21tZXJjZS0ke2NvbmZpZy5lbnZpcm9ubWVudH1gO1xuXG4gICAgLy8gTWVzc2FnaW5nOiBBbWF6b24gU1FTL1NOUyB2aWEgTWFzc1RyYW5zaXQgKHJlcGxhY2VzIEFtYXpvbiBNUSDigJQgbm8gYnJva2VyLCBJQU0gYXV0aClcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAxLiBWUENcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1ZwYycsIHtcbiAgICAgIHZwY05hbWU6IGAke3ByZWZpeH0tdnBjYCxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiBpc1Byb2QgPyAyIDogMCwgLy8gZGV2OiBubyBOQVQgR1csIEVDMiBnZXRzIHB1YmxpYyBJUCB2aWEgcHVibGljIHN1Ym5ldFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7IG5hbWU6ICdQdWJsaWMnLCAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQywgICAgICAgICAgIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgICB7IG5hbWU6ICdJc29sYXRlZCcsIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAyLiBTZWN1cml0eSBHcm91cHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxiU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0FsYlNnJywgeyB2cGMsIGRlc2NyaXB0aW9uOiAnQUxCJywgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSB9KTtcbiAgICBhbGJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcCg4MCksICdIVFRQJyk7XG4gICAgYWxiU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoNDQzKSwgJ0hUVFBTJyk7XG5cbiAgICBjb25zdCBlY3NTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRWNzU2cnLCB7IHZwYywgZGVzY3JpcHRpb246ICdFQ1MgdGFza3MnLCBhbGxvd0FsbE91dGJvdW5kOiB0cnVlIH0pO1xuICAgIGVjc1NnLmFkZEluZ3Jlc3NSdWxlKGFsYlNnLCBlYzIuUG9ydC50Y3AoODA4MCksICdBTEIgdG8gRUNTJyk7XG4gICAgZWNzU2cuYWRkSW5ncmVzc1J1bGUoZWNzU2csIGVjMi5Qb3J0LmFsbFRjcCgpLCAnU2VydmljZSBtZXNoJyk7XG5cbiAgICBjb25zdCByZHNTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnUmRzU2cnLCB7IHZwYywgZGVzY3JpcHRpb246ICdSRFMnLCBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSB9KTtcbiAgICByZHNTZy5hZGRJbmdyZXNzUnVsZShlY3NTZywgZWMyLlBvcnQudGNwKDU0MzIpLCAnRUNTIHRvIFJEUycpO1xuXG4gICAgY29uc3QgcmVkaXNTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnUmVkaXNTZycsIHsgdnBjLCBkZXNjcmlwdGlvbjogJ1JlZGlzJywgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UgfSk7XG4gICAgcmVkaXNTZy5hZGRJbmdyZXNzUnVsZShlY3NTZywgZWMyLlBvcnQudGNwKDYzNzkpLCAnRUNTIHRvIFJlZGlzJyk7XG5cbiAgICBjb25zdCBvcGVuU2VhcmNoU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ09zU2cnLCB7IHZwYywgZGVzY3JpcHRpb246ICdPcGVuU2VhcmNoJywgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UgfSk7XG4gICAgb3BlblNlYXJjaFNnLmFkZEluZ3Jlc3NSdWxlKGVjc1NnLCBlYzIuUG9ydC50Y3AoNDQzKSwgJ0VDUyB0byBPcGVuU2VhcmNoJyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMy4gU2VjcmV0cyBNYW5hZ2VyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGRiU2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnRGJTZWNyZXQnLCB7XG4gICAgICBzZWNyZXROYW1lOiBgJHtwcmVmaXh9L3Jkcy9wb3N0Z3Jlc2AsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoeyB1c2VybmFtZTogJ2Vjb21tZXJjZWFkbWluJyB9KSxcbiAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdwYXNzd29yZCcsXG4gICAgICAgIGV4Y2x1ZGVDaGFyYWN0ZXJzOiAnXCJAL1xcXFxcXCcnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlZGlzQXV0aFNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ1JlZGlzQXV0aFNlY3JldCcsIHtcbiAgICAgIHNlY3JldE5hbWU6IGAke3ByZWZpeH0vcmVkaXMvYXV0aC10b2tlbmAsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzogeyBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcXFwnJywgcGFzc3dvcmRMZW5ndGg6IDMyIH0sXG4gICAgfSk7XG5cbiAgICAvLyBNUSBzZWNyZXQgaXMgY3JlYXRlZCBsYXRlciAoc2VjdGlvbiA2KSB1c2luZyB0aGUgQ2ZuUGFyYW1ldGVyIHZhbHVlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDQuIFJEUyBQb3N0Z3JlU1FMIDE2XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGRiSW5zdGFuY2UgPSBuZXcgcmRzLkRhdGFiYXNlSW5zdGFuY2UodGhpcywgJ1JkcycsIHtcbiAgICAgIGluc3RhbmNlSWRlbnRpZmllcjogYCR7cHJlZml4fS1wb3N0Z3Jlc2AsXG4gICAgICBlbmdpbmU6IHJkcy5EYXRhYmFzZUluc3RhbmNlRW5naW5lLnBvc3RncmVzKHsgdmVyc2lvbjogcmRzLlBvc3RncmVzRW5naW5lVmVyc2lvbi5WRVJfMTYgfSksXG4gICAgICBpbnN0YW5jZVR5cGU6IGVjMi5JbnN0YW5jZVR5cGUub2YoZWMyLkluc3RhbmNlQ2xhc3MuVDMsIGVjMi5JbnN0YW5jZVNpemUuTUVESVVNKSxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCB9LFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtyZHNTZ10sXG4gICAgICBjcmVkZW50aWFsczogcmRzLkNyZWRlbnRpYWxzLmZyb21TZWNyZXQoZGJTZWNyZXQpLFxuICAgICAgbXVsdGlBejogaXNQcm9kLFxuICAgICAgc3RvcmFnZUVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogaXNQcm9kLFxuICAgICAgYmFja3VwUmV0ZW50aW9uOiBpc1Byb2QgPyBjZGsuRHVyYXRpb24uZGF5cyg3KSA6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA1LiBFbGFzdGlDYWNoZSBTZXJ2ZXJsZXNzIFJlZGlzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHJlZGlzU3VibmV0R3JvdXAgPSBuZXcgZWxhc3RpY2FjaGUuQ2ZuU3VibmV0R3JvdXAodGhpcywgJ1JlZGlzU3VibmV0R3JvdXAnLCB7XG4gICAgICBkZXNjcmlwdGlvbjogYCR7cHJlZml4fSByZWRpcyBzdWJuZXQgZ3JvdXBgLFxuICAgICAgc3VibmV0SWRzOiB2cGMuc2VsZWN0U3VibmV0cyh7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQgfSkuc3VibmV0SWRzLFxuICAgICAgY2FjaGVTdWJuZXRHcm91cE5hbWU6IGAke3ByZWZpeH0tcmVkaXMtc3VibmV0YCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlZGlzID0gbmV3IGVsYXN0aWNhY2hlLkNmblNlcnZlcmxlc3NDYWNoZSh0aGlzLCAnUmVkaXMnLCB7XG4gICAgICBzZXJ2ZXJsZXNzQ2FjaGVOYW1lOiBgJHtwcmVmaXh9LXJlZGlzYCxcbiAgICAgIGVuZ2luZTogJ3JlZGlzJyxcbiAgICAgIHN1Ym5ldElkczogdnBjLnNlbGVjdFN1Ym5ldHMoeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVEIH0pLnN1Ym5ldElkcyxcbiAgICAgIHNlY3VyaXR5R3JvdXBJZHM6IFtyZWRpc1NnLnNlY3VyaXR5R3JvdXBJZF0sXG4gICAgfSk7XG4gICAgcmVkaXMuYWRkRGVwZW5kZW5jeShyZWRpc1N1Ym5ldEdyb3VwKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA2LiBNZXNzYWdpbmc6IEFtYXpvbiBTUVMvU05TIChNYXNzVHJhbnNpdCBhdXRvLWNyZWF0ZXMgcXVldWVzL3RvcGljcyBvbiBzdGFydHVwKVxuICAgIC8vIE5vIGJyb2tlciBuZWVkZWQg4oCUIElBTSBhdXRoIHZpYSBFQ1MgdGFzayByb2xlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDcuIEFtYXpvbiBPcGVuU2VhcmNoIFNlcnZpY2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRW5zdXJlIFNlcnZpY2UtTGlua2VkIFJvbGUgZXhpc3RzIGJlZm9yZSBPcGVuU2VhcmNoIFZQQyBkZXBsb3ltZW50LlxuICAgIC8vIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZyBoYW5kbGVzIHRoZSBjYXNlIHdoZXJlIHRoZSByb2xlIGFscmVhZHkgZXhpc3RzLlxuICAgIGNvbnN0IG9wZW5TZWFyY2hTbHIgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ09wZW5TZWFyY2hTTFInLCB7XG4gICAgICBvbkNyZWF0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnSUFNJyxcbiAgICAgICAgYWN0aW9uOiAnY3JlYXRlU2VydmljZUxpbmtlZFJvbGUnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7IEFXU1NlcnZpY2VOYW1lOiAnb3BlbnNlYXJjaHNlcnZpY2UuYW1hem9uYXdzLmNvbScgfSxcbiAgICAgICAgaWdub3JlRXJyb3JDb2Rlc01hdGNoaW5nOiAnSW52YWxpZElucHV0JyxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ29wZW5zZWFyY2gtc2xyJyksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU2RrQ2FsbHMoeyByZXNvdXJjZXM6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LkFOWV9SRVNPVVJDRSB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG9wZW5TZWFyY2hEb21haW4gPSBuZXcgb3BlbnNlYXJjaC5Eb21haW4odGhpcywgJ09wZW5TZWFyY2gnLCB7XG4gICAgICBkb21haW5OYW1lOiBgJHtwcmVmaXh9LXNlYXJjaGAsXG4gICAgICB2ZXJzaW9uOiBvcGVuc2VhcmNoLkVuZ2luZVZlcnNpb24uT1BFTlNFQVJDSF8yXzEzLFxuICAgICAgY2FwYWNpdHk6IHtcbiAgICAgICAgZGF0YU5vZGVzOiBpc1Byb2QgPyAzIDogMSxcbiAgICAgICAgZGF0YU5vZGVJbnN0YW5jZVR5cGU6ICd0My5zbWFsbC5zZWFyY2gnLFxuICAgICAgICBtdWx0aUF6V2l0aFN0YW5kYnlFbmFibGVkOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICBlYnM6IHsgZW5hYmxlZDogdHJ1ZSwgdm9sdW1lU2l6ZTogMjAsIHZvbHVtZVR5cGU6IGVjMi5FYnNEZXZpY2VWb2x1bWVUeXBlLkdQMyB9LFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogW3sgc3VibmV0czogW3ZwYy5zZWxlY3RTdWJuZXRzKHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCwgb25lUGVyQXo6IHRydWUgfSkuc3VibmV0c1swXV0gfV0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW29wZW5TZWFyY2hTZ10sXG4gICAgICB6b25lQXdhcmVuZXNzOiB7IGVuYWJsZWQ6IGZhbHNlIH0sXG4gICAgICBlbmZvcmNlSHR0cHM6IHRydWUsXG4gICAgICBub2RlVG9Ob2RlRW5jcnlwdGlvbjogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb25BdFJlc3Q6IHsgZW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgdXNlVW5zaWduZWRCYXNpY0F1dGg6IGZhbHNlLFxuICAgICAgZmluZUdyYWluZWRBY2Nlc3NDb250cm9sOiB7IG1hc3RlclVzZXJOYW1lOiAnZWNvbW1lcmNlLW9zLWFkbWluJyB9LFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcbiAgICBvcGVuU2VhcmNoRG9tYWluLm5vZGUuYWRkRGVwZW5kZW5jeShvcGVuU2VhcmNoU2xyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA4LiBFQ1MgQ2x1c3RlciArIEVDMiBBdXRvIFNjYWxpbmcgR3JvdXAgKyBDbG91ZCBNYXBcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnQ2x1c3RlcicsIHtcbiAgICAgIGNsdXN0ZXJOYW1lOiBgJHtwcmVmaXh9LWNsdXN0ZXJgLFxuICAgICAgdnBjLFxuICAgICAgY29udGFpbmVySW5zaWdodHNWMjogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOQUJMRUQsXG4gICAgfSk7XG5cbiAgICAvLyBFeHBsaWNpdCBMYXVuY2ggVGVtcGxhdGUg4oCUIG5ldyBBV1MgYWNjb3VudHMgZG9uJ3Qgc3VwcG9ydCBMYXVuY2hDb25maWd1cmF0aW9uXG4gICAgY29uc3QgaW5zdGFuY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFY3NJbnN0YW5jZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWMyLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQzJDb250YWluZXJTZXJ2aWNlZm9yRUMyUm9sZScpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0FtYXpvblNTTU1hbmFnZWRJbnN0YW5jZUNvcmUnKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBsYXVuY2hUZW1wbGF0ZSA9IG5ldyBlYzIuTGF1bmNoVGVtcGxhdGUodGhpcywgJ0Vjc0xhdW5jaFRlbXBsYXRlJywge1xuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlQzLCBlYzIuSW5zdGFuY2VTaXplLkxBUkdFKSxcbiAgICAgIG1hY2hpbmVJbWFnZTogZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MjAyMygpLFxuICAgICAgcm9sZTogaW5zdGFuY2VSb2xlLFxuICAgICAgc2VjdXJpdHlHcm91cDogZWNzU2csXG4gICAgICByZXF1aXJlSW1kc3YyOiB0cnVlLFxuICAgICAgYXNzb2NpYXRlUHVibGljSXBBZGRyZXNzOiAhaXNQcm9kLCAvLyBkZXY6IHB1YmxpYyBJUCByZXBsYWNlcyBOQVQgR2F0ZXdheVxuICAgICAgdXNlckRhdGE6IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXNnID0gbmV3IGF1dG9zY2FsaW5nLkF1dG9TY2FsaW5nR3JvdXAodGhpcywgJ0Vjc0FzZycsIHtcbiAgICAgIGF1dG9TY2FsaW5nR3JvdXBOYW1lOiBgJHtwcmVmaXh9LWVjcy1hc2dgLFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMgfSxcbiAgICAgIGxhdW5jaFRlbXBsYXRlLFxuICAgICAgbWluQ2FwYWNpdHk6IDIsXG4gICAgICBtYXhDYXBhY2l0eTogaXNQcm9kID8gMTAgOiA0LFxuICAgICAgZGVzaXJlZENhcGFjaXR5OiAyLFxuICAgICAgbmV3SW5zdGFuY2VzUHJvdGVjdGVkRnJvbVNjYWxlSW46IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2FwYWNpdHlQcm92aWRlciA9IG5ldyBlY3MuQXNnQ2FwYWNpdHlQcm92aWRlcih0aGlzLCAnQXNnQ2FwYWNpdHlQcm92aWRlcicsIHtcbiAgICAgIGF1dG9TY2FsaW5nR3JvdXA6IGFzZyxcbiAgICAgIGVuYWJsZU1hbmFnZWRTY2FsaW5nOiB0cnVlLFxuICAgICAgZW5hYmxlTWFuYWdlZFRlcm1pbmF0aW9uUHJvdGVjdGlvbjogZmFsc2UsXG4gICAgfSk7XG4gICAgY2x1c3Rlci5hZGRBc2dDYXBhY2l0eVByb3ZpZGVyKGNhcGFjaXR5UHJvdmlkZXIpO1xuXG4gICAgY29uc3QgbmFtZXNwYWNlID0gbmV3IHNlcnZpY2VkaXNjb3ZlcnkuUHJpdmF0ZURuc05hbWVzcGFjZSh0aGlzLCAnTmFtZXNwYWNlJywge1xuICAgICAgbmFtZTogYCR7cHJlZml4fS5sb2NhbGAsXG4gICAgICB2cGMsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gOS4gSUFNIFJvbGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vjc0V4ZWN1dGlvblJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7cHJlZml4fS1lY3MtZXhlY3V0aW9uLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgfSk7XG4gICAgZGJTZWNyZXQuZ3JhbnRSZWFkKGV4ZWN1dGlvblJvbGUpO1xuICAgIHJlZGlzQXV0aFNlY3JldC5ncmFudFJlYWQoZXhlY3V0aW9uUm9sZSk7XG5cbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWNzVGFza1JvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7cHJlZml4fS1lY3MtdGFzay1yb2xlYCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsneHJheTpQdXRUcmFjZVNlZ21lbnRzJywgJ3hyYXk6UHV0VGVsZW1ldHJ5UmVjb3JkcycsXG4gICAgICAgICAgICAgICAgJ3hyYXk6R2V0U2FtcGxpbmdSdWxlcycsICd4cmF5OkdldFNhbXBsaW5nVGFyZ2V0cyddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCddLFxuICAgICAgcmVzb3VyY2VzOiBbZGJTZWNyZXQuc2VjcmV0QXJuLCByZWRpc0F1dGhTZWNyZXQuc2VjcmV0QXJuXSxcbiAgICB9KSk7XG4gICAgLy8gU1FTL1NOUyBmb3IgTWFzc1RyYW5zaXQgKHJlcGxhY2VzIEFtYXpvbiBNUSlcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzcXM6KicsXG4gICAgICAgICdzbnM6KicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6c3FzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToqYCxcbiAgICAgICAgICAgICAgICAgIGBhcm46YXdzOnNuczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06KmBdLFxuICAgIH0pKTtcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXG4gICAgICByZXNvdXJjZXM6IFsnYXJuOmF3czpsb2dzOio6Kjpsb2ctZ3JvdXA6L2Vjb21tZXJjZS8qJ10sXG4gICAgfSkpO1xuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnc3NtbWVzc2FnZXM6Q3JlYXRlQ29udHJvbENoYW5uZWwnLCAnc3NtbWVzc2FnZXM6Q3JlYXRlRGF0YUNoYW5uZWwnLFxuICAgICAgICAgICAgICAgICdzc21tZXNzYWdlczpPcGVuQ29udHJvbENoYW5uZWwnLCAnc3NtbWVzc2FnZXM6T3BlbkRhdGFDaGFubmVsJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAxMC4gRUNSIFJlcG9zaXRvcmllc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBlY3JSZXBvczogUGFydGlhbDxSZWNvcmQ8U2VydmljZU5hbWUsIGVjci5SZXBvc2l0b3J5Pj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IHN2YyBvZiBBTExfU0VSVklDRVMpIHtcbiAgICAgIGNvbnN0IHJlcG8gPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgYEVjci0ke3N2Y31gLCB7XG4gICAgICAgIHJlcG9zaXRvcnlOYW1lOiBgJHtwcmVmaXh9LyR7c3ZjfWAsXG4gICAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IG1heEltYWdlQ291bnQ6IDEwIH1dLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICB9KTtcbiAgICAgIGVjclJlcG9zW3N2Y10gPSByZXBvO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAxMS4gQUxCXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsYiA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnQWxiJywge1xuICAgICAgbG9hZEJhbGFuY2VyTmFtZTogYCR7cHJlZml4fS1hbGJgLFxuICAgICAgdnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IHRydWUsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyB9LFxuICAgICAgc2VjdXJpdHlHcm91cDogYWxiU2csXG4gICAgfSk7XG5cbiAgICBjb25zdCBsaXN0ZW5lciA9IGFsYi5hZGRMaXN0ZW5lcignSHR0cExpc3RlbmVyJywge1xuICAgICAgcG9ydDogODAsXG4gICAgICBvcGVuOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDEyLiBGYXJnYXRlIFNlcnZpY2VzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGZvciAoY29uc3Qgc3ZjIG9mIEFMTF9TRVJWSUNFUykge1xuICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBgTG9nLSR7c3ZjfWAsIHtcbiAgICAgICAgbG9nR3JvdXBOYW1lOiBgL2Vjb21tZXJjZS8ke2NvbmZpZy5lbnZpcm9ubWVudH0vJHtzdmN9YCxcbiAgICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEVDMiB0YXNrIGRlZmluaXRpb24gKG5vIEZhcmdhdGUgdkNQVSBxdW90YSByZXF1aXJlZClcbiAgICAgIGNvbnN0IHRhc2tEZWYgPSBuZXcgZWNzLlRhc2tEZWZpbml0aW9uKHRoaXMsIGBUYXNrLSR7c3ZjfWAsIHtcbiAgICAgICAgZmFtaWx5OiBgJHtwcmVmaXh9LSR7c3ZjfWAsXG4gICAgICAgIGNvbXBhdGliaWxpdHk6IGVjcy5Db21wYXRpYmlsaXR5LkVDMixcbiAgICAgICAgbmV0d29ya01vZGU6IGVjcy5OZXR3b3JrTW9kZS5BV1NfVlBDLFxuICAgICAgICBjcHU6IFN0cmluZyhTRVJWSUNFX0NQVVtzdmNdKSxcbiAgICAgICAgbWVtb3J5TWlCOiBTdHJpbmcoU0VSVklDRV9NRU1bc3ZjXSksXG4gICAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICAgIHRhc2tSb2xlLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGFwcENvbnRhaW5lciA9IHRhc2tEZWYuYWRkQ29udGFpbmVyKGBhcHBgLCB7XG4gICAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoZWNyUmVwb3Nbc3ZjXSEsICdsYXRlc3QnKSxcbiAgICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7IHN0cmVhbVByZWZpeDogc3ZjLCBsb2dHcm91cCB9KSxcbiAgICAgICAgcG9ydE1hcHBpbmdzOiBbeyBjb250YWluZXJQb3J0OiA4MDgwLCBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCB9XSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBBU1BORVRDT1JFX0VOVklST05NRU5UOiBjb25maWcuZW52aXJvbm1lbnQgPT09ICdkZXYnID8gJ0RldmVsb3BtZW50JyA6ICdQcm9kdWN0aW9uJyxcbiAgICAgICAgICBBU1BORVRDT1JFX1VSTFM6ICdodHRwOi8vKzo4MDgwJyxcbiAgICAgICAgICBBV1NfUkVHSU9OOiBjb25maWcucmVnaW9uLFxuICAgICAgICAgIERCX0hPU1Q6IGRiSW5zdGFuY2UuaW5zdGFuY2VFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgICAgICBEQl9QT1JUOiAnNTQzMicsXG4gICAgICAgICAgLi4uKERCX1NFUlZJQ0VTW3N2Y10gPyB7IERCX05BTUU6IERCX1NFUlZJQ0VTW3N2Y10hIH0gOiB7fSksXG4gICAgICAgICAgUkVESVNfRU5EUE9JTlQ6IHJlZGlzLmF0dHJFbmRwb2ludEFkZHJlc3MsXG4gICAgICAgICAgT1BFTlNFQVJDSF9FTkRQT0lOVDogYGh0dHBzOi8vJHtvcGVuU2VhcmNoRG9tYWluLmRvbWFpbkVuZHBvaW50fWAsXG4gICAgICAgICAgQVdTX1hSQVlfREFFTU9OX0FERFJFU1M6ICd4cmF5LWRhZW1vbjoyMDAwJyxcbiAgICAgICAgfSxcbiAgICAgICAgc2VjcmV0czoge1xuICAgICAgICAgIERCX1NFQ1JFVF9KU09OOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihkYlNlY3JldCksXG4gICAgICAgIH0sXG4gICAgICAgIG1lbW9yeUxpbWl0TWlCOiBTRVJWSUNFX01FTVtzdmNdIC0gMjU2LFxuICAgICAgICBlc3NlbnRpYWw6IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgLy8gWC1SYXkgZGFlbW9uIHNpZGVjYXJcbiAgICAgIGNvbnN0IHhyYXlDb250YWluZXIgPSB0YXNrRGVmLmFkZENvbnRhaW5lcigneHJheS1kYWVtb24nLCB7XG4gICAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KCdwdWJsaWMuZWNyLmF3cy94cmF5L2F3cy14cmF5LWRhZW1vbjpsYXRlc3QnKSxcbiAgICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgICAgc3RyZWFtUHJlZml4OiBgJHtzdmN9LXhyYXlgLFxuICAgICAgICAgIGxvZ0dyb3VwOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBgWHJheUxvZy0ke3N2Y31gLCB7XG4gICAgICAgICAgICBsb2dHcm91cE5hbWU6IGAvZWNvbW1lcmNlLyR7Y29uZmlnLmVudmlyb25tZW50fS8ke3N2Y30veHJheWAsXG4gICAgICAgICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5USFJFRV9EQVlTLFxuICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSksXG4gICAgICAgIHBvcnRNYXBwaW5nczogW3sgY29udGFpbmVyUG9ydDogMjAwMCwgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5VRFAgfV0sXG4gICAgICAgIGVzc2VudGlhbDogZmFsc2UsXG4gICAgICAgIG1lbW9yeUxpbWl0TWlCOiAyNTYsXG4gICAgICAgIGNwdTogMzIsXG4gICAgICB9KTtcblxuICAgICAgYXBwQ29udGFpbmVyLmFkZENvbnRhaW5lckRlcGVuZGVuY2llcyh7XG4gICAgICAgIGNvbnRhaW5lcjogeHJheUNvbnRhaW5lcixcbiAgICAgICAgY29uZGl0aW9uOiBlY3MuQ29udGFpbmVyRGVwZW5kZW5jeUNvbmRpdGlvbi5TVEFSVCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBlYzJTZXJ2aWNlID0gbmV3IGVjcy5FYzJTZXJ2aWNlKHRoaXMsIGBTdmMtJHtzdmN9YCwge1xuICAgICAgICBzZXJ2aWNlTmFtZTogYCR7cHJlZml4fS0ke3N2Y31gLFxuICAgICAgICBjbHVzdGVyLFxuICAgICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZixcbiAgICAgICAgZGVzaXJlZENvdW50OiAwLCAvLyBTdGFydCBhdCAwOyBzY2FsZSB1cCBhZnRlciBwdXNoaW5nIHJlYWwgaW1hZ2VzXG4gICAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDIH0sXG4gICAgICAgIHNlY3VyaXR5R3JvdXBzOiBbZWNzU2ddLFxuICAgICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgZW5hYmxlOiBmYWxzZSB9LCAvLyBEaXNhYmxlZCBkdXJpbmcgaW5pdGlhbCBpbmZyYSBkZXBsb3lcbiAgICAgICAgY2FwYWNpdHlQcm92aWRlclN0cmF0ZWdpZXM6IFt7XG4gICAgICAgICAgY2FwYWNpdHlQcm92aWRlcjogY2FwYWNpdHlQcm92aWRlci5jYXBhY2l0eVByb3ZpZGVyTmFtZSxcbiAgICAgICAgICB3ZWlnaHQ6IDEsXG4gICAgICAgIH1dLFxuICAgICAgICBjbG91ZE1hcE9wdGlvbnM6IHtcbiAgICAgICAgICBuYW1lOiBzdmMsXG4gICAgICAgICAgY2xvdWRNYXBOYW1lc3BhY2U6IG5hbWVzcGFjZSxcbiAgICAgICAgICBkbnNSZWNvcmRUeXBlOiBzZXJ2aWNlZGlzY292ZXJ5LkRuc1JlY29yZFR5cGUuQSxcbiAgICAgICAgICBkbnNUdGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBPbmx5IGFwaS1nYXRld2F5IGlzIHdpcmVkIHRvIHRoZSBBTEJcbiAgICAgIGlmIChzdmMgPT09ICdhcGktZ2F0ZXdheScpIHtcbiAgICAgICAgY29uc3QgdGcgPSBsaXN0ZW5lci5hZGRUYXJnZXRzKGBUZy0ke3N2Y31gLCB7XG4gICAgICAgICAgdGFyZ2V0R3JvdXBOYW1lOiBgJHtwcmVmaXh9LSR7c3ZjfWAsXG4gICAgICAgICAgcG9ydDogODA4MCxcbiAgICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgICAgIHRhcmdldHM6IFtlYzJTZXJ2aWNlXSxcbiAgICAgICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAgICAgcGF0aDogJy9oZWFsdGgnLFxuICAgICAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGJEbnMnLCAgICAgICAgIHsgdmFsdWU6IGFsYi5sb2FkQmFsYW5jZXJEbnNOYW1lLCAgICAgICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWFsYi1kbnNgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYkVuZHBvaW50JywgICAgICB7IHZhbHVlOiBkYkluc3RhbmNlLmluc3RhbmNlRW5kcG9pbnQuaG9zdG5hbWUsIGV4cG9ydE5hbWU6IGAke3ByZWZpeH0tZGItZW5kcG9pbnRgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZWRpc0VuZHBvaW50JywgICB7IHZhbHVlOiByZWRpcy5hdHRyRW5kcG9pbnRBZGRyZXNzLCAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1yZWRpcy1lbmRwb2ludGAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09wZW5TZWFyY2hFcCcsICAgIHsgdmFsdWU6IG9wZW5TZWFyY2hEb21haW4uZG9tYWluRW5kcG9pbnQsICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LW9wZW5zZWFyY2gtZW5kcG9pbnRgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsICAgICB7IHZhbHVlOiBjbHVzdGVyLmNsdXN0ZXJOYW1lLCAgICAgICAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1jbHVzdGVyLW5hbWVgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYlNlY3JldEFybicsICAgICB7IHZhbHVlOiBkYlNlY3JldC5zZWNyZXRBcm4sICAgICAgICAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1kYi1zZWNyZXQtYXJuYCB9KTtcbiAgfVxufVxuIl19