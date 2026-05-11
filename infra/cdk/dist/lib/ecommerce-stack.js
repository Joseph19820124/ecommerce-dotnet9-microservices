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
            natGateways: isProd ? 2 : 1,
            subnetConfiguration: [
                { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
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
            vpcSubnets: [{ subnets: [vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, onePerAz: true }).subnets[0]] }],
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
            userData: ec2.UserData.forLinux(),
        });
        const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
            autoScalingGroupName: `${prefix}-ecs-asg`,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
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
                vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNvbW1lcmNlLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL2Vjb21tZXJjZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyREFBMkQ7QUFDM0QsZ0VBQWdFO0FBQ2hFLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsZ0VBQWdFO0FBQ2hFLGlFQUFpRTtBQUNqRSxxRUFBcUU7QUFDckUsMkNBQTJDO0FBQzNDLDZDQUE2QztBQUM3QywyREFBMkQ7QUFDM0QsbURBQW1EO0FBT25ELE1BQU0sWUFBWSxHQUFHO0lBQ25CLGFBQWEsRUFBRSxhQUFhLEVBQUUsV0FBVyxFQUFFLGNBQWM7SUFDekQsZUFBZSxFQUFFLGFBQWEsRUFBRSxrQkFBa0IsRUFBRSxpQkFBaUI7Q0FDN0QsQ0FBQztBQUdYLE1BQU0sV0FBVyxHQUFnQztJQUMvQyxhQUFhLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEdBQUc7SUFDeEQsY0FBYyxFQUFFLEdBQUcsRUFBRSxlQUFlLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxHQUFHO0lBQzdELGtCQUFrQixFQUFFLEdBQUcsRUFBRSxpQkFBaUIsRUFBRSxHQUFHO0NBQ2hELENBQUM7QUFDRixNQUFNLFdBQVcsR0FBZ0M7SUFDL0MsYUFBYSxFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxJQUFJO0lBQzNELGNBQWMsRUFBRSxJQUFJLEVBQUUsZUFBZSxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsR0FBRztJQUM5RCxrQkFBa0IsRUFBRSxHQUFHLEVBQUUsaUJBQWlCLEVBQUUsSUFBSTtDQUNqRCxDQUFDO0FBQ0YsTUFBTSxXQUFXLEdBQXlDO0lBQ3hELGFBQWEsRUFBRSxZQUFZLEVBQUUsV0FBVyxFQUFFLFVBQVU7SUFDcEQsY0FBYyxFQUFF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O1FBQzlILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFNLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxTQUFTLEVBQWdCLFVBQVUsRUFBRSxHQUFHLE1BQU0sZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDO0lBQ2pJLENBQUM7Q0FDRjtBQXpYRCx3Q0F5WEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyByZHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJkcyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljYWNoZSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2FjaGUnO1xuaW1wb3J0ICogYXMgb3BlbnNlYXJjaCBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtb3BlbnNlYXJjaHNlcnZpY2UnO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHNlcnZpY2VkaXNjb3ZlcnkgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlcnZpY2VkaXNjb3ZlcnknO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBhdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXV0b3NjYWxpbmcnO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgeyBFbnZDb25maWcgfSBmcm9tICcuL2NvbmZpZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRUNvbW1lcmNlU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgY29uZmlnOiBFbnZDb25maWc7XG59XG5cbmNvbnN0IEFMTF9TRVJWSUNFUyA9IFtcbiAgJ2FwaS1nYXRld2F5JywgJ2NhdGFsb2ctYXBpJywgJ29yZGVyLWFwaScsICdpZGVudGl0eS1hcGknLFxuICAnaW52ZW50b3J5LWFwaScsICdwYXltZW50LWFwaScsICdub3RpZmljYXRpb24tYXBpJywgJ2JsYXpvci1mcm9udGVuZCcsXG5dIGFzIGNvbnN0O1xudHlwZSBTZXJ2aWNlTmFtZSA9IHR5cGVvZiBBTExfU0VSVklDRVNbbnVtYmVyXTtcblxuY29uc3QgU0VSVklDRV9DUFU6IFJlY29yZDxTZXJ2aWNlTmFtZSwgbnVtYmVyPiA9IHtcbiAgJ2FwaS1nYXRld2F5JzogNTEyLCAnY2F0YWxvZy1hcGknOiA1MTIsICdvcmRlci1hcGknOiA1MTIsXG4gICdpZGVudGl0eS1hcGknOiA1MTIsICdpbnZlbnRvcnktYXBpJzogMjU2LCAncGF5bWVudC1hcGknOiAyNTYsXG4gICdub3RpZmljYXRpb24tYXBpJzogMjU2LCAnYmxhem9yLWZyb250ZW5kJzogNTEyLFxufTtcbmNvbnN0IFNFUlZJQ0VfTUVNOiBSZWNvcmQ8U2VydmljZU5hbWUsIG51bWJlcj4gPSB7XG4gICdhcGktZ2F0ZXdheSc6IDEwMjQsICdjYXRhbG9nLWFwaSc6IDEwMjQsICdvcmRlci1hcGknOiAxMDI0LFxuICAnaWRlbnRpdHktYXBpJzogMTAyNCwgJ2ludmVudG9yeS1hcGknOiA1MTIsICdwYXltZW50LWFwaSc6IDUxMixcbiAgJ25vdGlmaWNhdGlvbi1hcGknOiA1MTIsICdibGF6b3ItZnJvbnRlbmQnOiAxMDI0LFxufTtcbmNvbnN0IERCX1NFUlZJQ0VTOiBQYXJ0aWFsPFJlY29yZDxTZXJ2aWNlTmFtZSwgc3RyaW5nPj4gPSB7XG4gICdjYXRhbG9nLWFwaSc6ICdjYXRhbG9nX2RiJywgJ29yZGVyLWFwaSc6ICdvcmRlcl9kYicsXG4gICdpZGVudGl0eS1hcGknOiAnaWRlbnRpdHlfZGInLCAnaW52ZW50b3J5LWFwaSc6ICdpbnZlbnRvcnlfZGInLFxuICAncGF5bWVudC1hcGknOiAncGF5bWVudF9kYicsXG59O1xuXG5leHBvcnQgY2xhc3MgRUNvbW1lcmNlU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogRUNvbW1lcmNlU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgeyBjb25maWcgfSA9IHByb3BzO1xuICAgIGNvbnN0IGlzUHJvZCA9IGNvbmZpZy5lbnZpcm9ubWVudCA9PT0gJ3Byb2QnO1xuICAgIGNvbnN0IHByZWZpeCA9IGBlY29tbWVyY2UtJHtjb25maWcuZW52aXJvbm1lbnR9YDtcblxuICAgIC8vIE1lc3NhZ2luZzogQW1hem9uIFNRUy9TTlMgdmlhIE1hc3NUcmFuc2l0IChyZXBsYWNlcyBBbWF6b24gTVEg4oCUIG5vIGJyb2tlciwgSUFNIGF1dGgpXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMS4gVlBDXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdWcGMnLCB7XG4gICAgICB2cGNOYW1lOiBgJHtwcmVmaXh9LXZwY2AsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogaXNQcm9kID8gMiA6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHsgbmFtZTogJ1B1YmxpYycsICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLCAgICAgICAgICAgIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgICB7IG5hbWU6ICdQcml2YXRlJywgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgICB7IG5hbWU6ICdJc29sYXRlZCcsIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsICBjaWRyTWFzazogMjQgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMi4gU2VjdXJpdHkgR3JvdXBzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsYlNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdBbGJTZycsIHsgdnBjLCBkZXNjcmlwdGlvbjogJ0FMQicsIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUgfSk7XG4gICAgYWxiU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoODApLCAnSFRUUCcpO1xuICAgIGFsYlNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDQ0MyksICdIVFRQUycpO1xuXG4gICAgY29uc3QgZWNzU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0Vjc1NnJywgeyB2cGMsIGRlc2NyaXB0aW9uOiAnRUNTIHRhc2tzJywgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSB9KTtcbiAgICBlY3NTZy5hZGRJbmdyZXNzUnVsZShhbGJTZywgZWMyLlBvcnQudGNwKDgwODApLCAnQUxCIHRvIEVDUycpO1xuICAgIGVjc1NnLmFkZEluZ3Jlc3NSdWxlKGVjc1NnLCBlYzIuUG9ydC5hbGxUY3AoKSwgJ1NlcnZpY2UgbWVzaCcpO1xuXG4gICAgY29uc3QgcmRzU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1Jkc1NnJywgeyB2cGMsIGRlc2NyaXB0aW9uOiAnUkRTJywgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UgfSk7XG4gICAgcmRzU2cuYWRkSW5ncmVzc1J1bGUoZWNzU2csIGVjMi5Qb3J0LnRjcCg1NDMyKSwgJ0VDUyB0byBSRFMnKTtcblxuICAgIGNvbnN0IHJlZGlzU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1JlZGlzU2cnLCB7IHZwYywgZGVzY3JpcHRpb246ICdSZWRpcycsIGFsbG93QWxsT3V0Ym91bmQ6IGZhbHNlIH0pO1xuICAgIHJlZGlzU2cuYWRkSW5ncmVzc1J1bGUoZWNzU2csIGVjMi5Qb3J0LnRjcCg2Mzc5KSwgJ0VDUyB0byBSZWRpcycpO1xuXG4gICAgY29uc3Qgb3BlblNlYXJjaFNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdPc1NnJywgeyB2cGMsIGRlc2NyaXB0aW9uOiAnT3BlblNlYXJjaCcsIGFsbG93QWxsT3V0Ym91bmQ6IGZhbHNlIH0pO1xuICAgIG9wZW5TZWFyY2hTZy5hZGRJbmdyZXNzUnVsZShlY3NTZywgZWMyLlBvcnQudGNwKDQ0MyksICdFQ1MgdG8gT3BlblNlYXJjaCcpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDMuIFNlY3JldHMgTWFuYWdlclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYlNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0RiU2VjcmV0Jywge1xuICAgICAgc2VjcmV0TmFtZTogYCR7cHJlZml4fS9yZHMvcG9zdGdyZXNgLFxuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHsgdXNlcm5hbWU6ICdlY29tbWVyY2VhZG1pbicgfSksXG4gICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAncGFzc3dvcmQnLFxuICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcXFwnJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCByZWRpc0F1dGhTZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdSZWRpc0F1dGhTZWNyZXQnLCB7XG4gICAgICBzZWNyZXROYW1lOiBgJHtwcmVmaXh9L3JlZGlzL2F1dGgtdG9rZW5gLFxuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHsgZXhjbHVkZUNoYXJhY3RlcnM6ICdcIkAvXFxcXFxcJycsIHBhc3N3b3JkTGVuZ3RoOiAzMiB9LFxuICAgIH0pO1xuXG4gICAgLy8gTVEgc2VjcmV0IGlzIGNyZWF0ZWQgbGF0ZXIgKHNlY3Rpb24gNikgdXNpbmcgdGhlIENmblBhcmFtZXRlciB2YWx1ZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA0LiBSRFMgUG9zdGdyZVNRTCAxNlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYkluc3RhbmNlID0gbmV3IHJkcy5EYXRhYmFzZUluc3RhbmNlKHRoaXMsICdSZHMnLCB7XG4gICAgICBpbnN0YW5jZUlkZW50aWZpZXI6IGAke3ByZWZpeH0tcG9zdGdyZXNgLFxuICAgICAgZW5naW5lOiByZHMuRGF0YWJhc2VJbnN0YW5jZUVuZ2luZS5wb3N0Z3Jlcyh7IHZlcnNpb246IHJkcy5Qb3N0Z3Jlc0VuZ2luZVZlcnNpb24uVkVSXzE2IH0pLFxuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlQzLCBlYzIuSW5zdGFuY2VTaXplLk1FRElVTSksXG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQgfSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbcmRzU2ddLFxuICAgICAgY3JlZGVudGlhbHM6IHJkcy5DcmVkZW50aWFscy5mcm9tU2VjcmV0KGRiU2VjcmV0KSxcbiAgICAgIG11bHRpQXo6IGlzUHJvZCxcbiAgICAgIHN0b3JhZ2VFbmNyeXB0ZWQ6IHRydWUsXG4gICAgICBkZWxldGlvblByb3RlY3Rpb246IGlzUHJvZCxcbiAgICAgIGJhY2t1cFJldGVudGlvbjogaXNQcm9kID8gY2RrLkR1cmF0aW9uLmRheXMoNykgOiBjZGsuRHVyYXRpb24uZGF5cygxKSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGlzUHJvZCA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gNS4gRWxhc3RpQ2FjaGUgU2VydmVybGVzcyBSZWRpc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCByZWRpc1N1Ym5ldEdyb3VwID0gbmV3IGVsYXN0aWNhY2hlLkNmblN1Ym5ldEdyb3VwKHRoaXMsICdSZWRpc1N1Ym5ldEdyb3VwJywge1xuICAgICAgZGVzY3JpcHRpb246IGAke3ByZWZpeH0gcmVkaXMgc3VibmV0IGdyb3VwYCxcbiAgICAgIHN1Ym5ldElkczogdnBjLnNlbGVjdFN1Ym5ldHMoeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVEIH0pLnN1Ym5ldElkcyxcbiAgICAgIGNhY2hlU3VibmV0R3JvdXBOYW1lOiBgJHtwcmVmaXh9LXJlZGlzLXN1Ym5ldGAsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZWRpcyA9IG5ldyBlbGFzdGljYWNoZS5DZm5TZXJ2ZXJsZXNzQ2FjaGUodGhpcywgJ1JlZGlzJywge1xuICAgICAgc2VydmVybGVzc0NhY2hlTmFtZTogYCR7cHJlZml4fS1yZWRpc2AsXG4gICAgICBlbmdpbmU6ICdyZWRpcycsXG4gICAgICBzdWJuZXRJZHM6IHZwYy5zZWxlY3RTdWJuZXRzKHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCB9KS5zdWJuZXRJZHMsXG4gICAgICBzZWN1cml0eUdyb3VwSWRzOiBbcmVkaXNTZy5zZWN1cml0eUdyb3VwSWRdLFxuICAgIH0pO1xuICAgIHJlZGlzLmFkZERlcGVuZGVuY3kocmVkaXNTdWJuZXRHcm91cCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gNi4gTWVzc2FnaW5nOiBBbWF6b24gU1FTL1NOUyAoTWFzc1RyYW5zaXQgYXV0by1jcmVhdGVzIHF1ZXVlcy90b3BpY3Mgb24gc3RhcnR1cClcbiAgICAvLyBObyBicm9rZXIgbmVlZGVkIOKAlCBJQU0gYXV0aCB2aWEgRUNTIHRhc2sgcm9sZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA3LiBBbWF6b24gT3BlblNlYXJjaCBTZXJ2aWNlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEVuc3VyZSBTZXJ2aWNlLUxpbmtlZCBSb2xlIGV4aXN0cyBiZWZvcmUgT3BlblNlYXJjaCBWUEMgZGVwbG95bWVudC5cbiAgICAvLyBpZ25vcmVFcnJvckNvZGVzTWF0Y2hpbmcgaGFuZGxlcyB0aGUgY2FzZSB3aGVyZSB0aGUgcm9sZSBhbHJlYWR5IGV4aXN0cy5cbiAgICBjb25zdCBvcGVuU2VhcmNoU2xyID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdPcGVuU2VhcmNoU0xSJywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0lBTScsXG4gICAgICAgIGFjdGlvbjogJ2NyZWF0ZVNlcnZpY2VMaW5rZWRSb2xlJyxcbiAgICAgICAgcGFyYW1ldGVyczogeyBBV1NTZXJ2aWNlTmFtZTogJ29wZW5zZWFyY2hzZXJ2aWNlLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgIGlnbm9yZUVycm9yQ29kZXNNYXRjaGluZzogJ0ludmFsaWRJbnB1dCcsXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdvcGVuc2VhcmNoLXNscicpLFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVNka0NhbGxzKHsgcmVzb3VyY2VzOiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5BTllfUkVTT1VSQ0UgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBvcGVuU2VhcmNoRG9tYWluID0gbmV3IG9wZW5zZWFyY2guRG9tYWluKHRoaXMsICdPcGVuU2VhcmNoJywge1xuICAgICAgZG9tYWluTmFtZTogYCR7cHJlZml4fS1zZWFyY2hgLFxuICAgICAgdmVyc2lvbjogb3BlbnNlYXJjaC5FbmdpbmVWZXJzaW9uLk9QRU5TRUFSQ0hfMl8xMyxcbiAgICAgIGNhcGFjaXR5OiB7XG4gICAgICAgIGRhdGFOb2RlczogaXNQcm9kID8gMyA6IDEsXG4gICAgICAgIGRhdGFOb2RlSW5zdGFuY2VUeXBlOiAndDMuc21hbGwuc2VhcmNoJyxcbiAgICAgICAgbXVsdGlBeldpdGhTdGFuZGJ5RW5hYmxlZDogZmFsc2UsXG4gICAgICB9LFxuICAgICAgZWJzOiB7IGVuYWJsZWQ6IHRydWUsIHZvbHVtZVNpemU6IDIwLCB2b2x1bWVUeXBlOiBlYzIuRWJzRGV2aWNlVm9sdW1lVHlwZS5HUDMgfSxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IFt7IHN1Ym5ldHM6IFt2cGMuc2VsZWN0U3VibmV0cyh7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsIG9uZVBlckF6OiB0cnVlIH0pLnN1Ym5ldHNbMF1dIH1dLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtvcGVuU2VhcmNoU2ddLFxuICAgICAgem9uZUF3YXJlbmVzczogeyBlbmFibGVkOiBmYWxzZSB9LFxuICAgICAgZW5mb3JjZUh0dHBzOiB0cnVlLFxuICAgICAgbm9kZVRvTm9kZUVuY3J5cHRpb246IHRydWUsXG4gICAgICBlbmNyeXB0aW9uQXRSZXN0OiB7IGVuYWJsZWQ6IHRydWUgfSxcbiAgICAgIHVzZVVuc2lnbmVkQmFzaWNBdXRoOiBmYWxzZSxcbiAgICAgIGZpbmVHcmFpbmVkQWNjZXNzQ29udHJvbDogeyBtYXN0ZXJVc2VyTmFtZTogJ2Vjb21tZXJjZS1vcy1hZG1pbicgfSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGlzUHJvZCA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG4gICAgb3BlblNlYXJjaERvbWFpbi5ub2RlLmFkZERlcGVuZGVuY3kob3BlblNlYXJjaFNscik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gOC4gRUNTIENsdXN0ZXIgKyBFQzIgQXV0byBTY2FsaW5nIEdyb3VwICsgQ2xvdWQgTWFwXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0NsdXN0ZXInLCB7XG4gICAgICBjbHVzdGVyTmFtZTogYCR7cHJlZml4fS1jbHVzdGVyYCxcbiAgICAgIHZwYyxcbiAgICAgIGNvbnRhaW5lckluc2lnaHRzVjI6IGVjcy5Db250YWluZXJJbnNpZ2h0cy5FTkFCTEVELFxuICAgIH0pO1xuXG4gICAgLy8gRXhwbGljaXQgTGF1bmNoIFRlbXBsYXRlIOKAlCBuZXcgQVdTIGFjY291bnRzIGRvbid0IHN1cHBvcnQgTGF1bmNoQ29uZmlndXJhdGlvblxuICAgIGNvbnN0IGluc3RhbmNlUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWNzSW5zdGFuY2VSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2VjMi5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUMyQ29udGFpbmVyU2VydmljZWZvckVDMlJvbGUnKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdBbWF6b25TU01NYW5hZ2VkSW5zdGFuY2VDb3JlJyksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbGF1bmNoVGVtcGxhdGUgPSBuZXcgZWMyLkxhdW5jaFRlbXBsYXRlKHRoaXMsICdFY3NMYXVuY2hUZW1wbGF0ZScsIHtcbiAgICAgIGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5UMywgZWMyLkluc3RhbmNlU2l6ZS5MQVJHRSksXG4gICAgICBtYWNoaW5lSW1hZ2U6IGVjcy5FY3NPcHRpbWl6ZWRJbWFnZS5hbWF6b25MaW51eDIwMjMoKSxcbiAgICAgIHJvbGU6IGluc3RhbmNlUm9sZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGVjc1NnLFxuICAgICAgcmVxdWlyZUltZHN2MjogdHJ1ZSxcbiAgICAgIHVzZXJEYXRhOiBlYzIuVXNlckRhdGEuZm9yTGludXgoKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFzZyA9IG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsICdFY3NBc2cnLCB7XG4gICAgICBhdXRvU2NhbGluZ0dyb3VwTmFtZTogYCR7cHJlZml4fS1lY3MtYXNnYCxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgbGF1bmNoVGVtcGxhdGUsXG4gICAgICBtaW5DYXBhY2l0eTogMixcbiAgICAgIG1heENhcGFjaXR5OiBpc1Byb2QgPyAxMCA6IDQsXG4gICAgICBkZXNpcmVkQ2FwYWNpdHk6IDIsXG4gICAgICBuZXdJbnN0YW5jZXNQcm90ZWN0ZWRGcm9tU2NhbGVJbjogZmFsc2UsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjYXBhY2l0eVByb3ZpZGVyID0gbmV3IGVjcy5Bc2dDYXBhY2l0eVByb3ZpZGVyKHRoaXMsICdBc2dDYXBhY2l0eVByb3ZpZGVyJywge1xuICAgICAgYXV0b1NjYWxpbmdHcm91cDogYXNnLFxuICAgICAgZW5hYmxlTWFuYWdlZFNjYWxpbmc6IHRydWUsXG4gICAgICBlbmFibGVNYW5hZ2VkVGVybWluYXRpb25Qcm90ZWN0aW9uOiBmYWxzZSxcbiAgICB9KTtcbiAgICBjbHVzdGVyLmFkZEFzZ0NhcGFjaXR5UHJvdmlkZXIoY2FwYWNpdHlQcm92aWRlcik7XG5cbiAgICBjb25zdCBuYW1lc3BhY2UgPSBuZXcgc2VydmljZWRpc2NvdmVyeS5Qcml2YXRlRG5zTmFtZXNwYWNlKHRoaXMsICdOYW1lc3BhY2UnLCB7XG4gICAgICBuYW1lOiBgJHtwcmVmaXh9LmxvY2FsYCxcbiAgICAgIHZwYyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA5LiBJQU0gUm9sZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWNzRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgJHtwcmVmaXh9LWVjcy1leGVjdXRpb24tcm9sZWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScpLFxuICAgICAgXSxcbiAgICB9KTtcbiAgICBkYlNlY3JldC5ncmFudFJlYWQoZXhlY3V0aW9uUm9sZSk7XG4gICAgcmVkaXNBdXRoU2VjcmV0LmdyYW50UmVhZChleGVjdXRpb25Sb2xlKTtcblxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFY3NUYXNrUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgJHtwcmVmaXh9LWVjcy10YXNrLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWyd4cmF5OlB1dFRyYWNlU2VnbWVudHMnLCAneHJheTpQdXRUZWxlbWV0cnlSZWNvcmRzJyxcbiAgICAgICAgICAgICAgICAneHJheTpHZXRTYW1wbGluZ1J1bGVzJywgJ3hyYXk6R2V0U2FtcGxpbmdUYXJnZXRzJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJywgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0J10sXG4gICAgICByZXNvdXJjZXM6IFtkYlNlY3JldC5zZWNyZXRBcm4sIHJlZGlzQXV0aFNlY3JldC5zZWNyZXRBcm5dLFxuICAgIH0pKTtcbiAgICAvLyBTUVMvU05TIGZvciBNYXNzVHJhbnNpdCAocmVwbGFjZXMgQW1hem9uIE1RKVxuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3NxczoqJyxcbiAgICAgICAgJ3NuczoqJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpzcXM6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OipgLFxuICAgICAgICAgICAgICAgICAgYGFybjphd3M6c25zOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToqYF0sXG4gICAgfSkpO1xuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dTdHJlYW0nLCAnbG9nczpQdXRMb2dFdmVudHMnXSxcbiAgICAgIHJlc291cmNlczogWydhcm46YXdzOmxvZ3M6KjoqOmxvZy1ncm91cDovZWNvbW1lcmNlLyonXSxcbiAgICB9KSk7XG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzc21tZXNzYWdlczpDcmVhdGVDb250cm9sQ2hhbm5lbCcsICdzc21tZXNzYWdlczpDcmVhdGVEYXRhQ2hhbm5lbCcsXG4gICAgICAgICAgICAgICAgJ3NzbW1lc3NhZ2VzOk9wZW5Db250cm9sQ2hhbm5lbCcsICdzc21tZXNzYWdlczpPcGVuRGF0YUNoYW5uZWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDEwLiBFQ1IgUmVwb3NpdG9yaWVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGVjclJlcG9zOiBQYXJ0aWFsPFJlY29yZDxTZXJ2aWNlTmFtZSwgZWNyLlJlcG9zaXRvcnk+PiA9IHt9O1xuICAgIGZvciAoY29uc3Qgc3ZjIG9mIEFMTF9TRVJWSUNFUykge1xuICAgICAgY29uc3QgcmVwbyA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCBgRWNyLSR7c3ZjfWAsIHtcbiAgICAgICAgcmVwb3NpdG9yeU5hbWU6IGAke3ByZWZpeH0vJHtzdmN9YCxcbiAgICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgICBsaWZlY3ljbGVSdWxlczogW3sgbWF4SW1hZ2VDb3VudDogMTAgfV0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgIH0pO1xuICAgICAgZWNyUmVwb3Nbc3ZjXSA9IHJlcG87XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDExLiBBTEJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxiID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdBbGInLCB7XG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiBgJHtwcmVmaXh9LWFsYmAsXG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDIH0sXG4gICAgICBzZWN1cml0eUdyb3VwOiBhbGJTZyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxpc3RlbmVyID0gYWxiLmFkZExpc3RlbmVyKCdIdHRwTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA4MCxcbiAgICAgIG9wZW46IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMTIuIEZhcmdhdGUgU2VydmljZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgZm9yIChjb25zdCBzdmMgb2YgQUxMX1NFUlZJQ0VTKSB7XG4gICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIGBMb2ctJHtzdmN9YCwge1xuICAgICAgICBsb2dHcm91cE5hbWU6IGAvZWNvbW1lcmNlLyR7Y29uZmlnLmVudmlyb25tZW50fS8ke3N2Y31gLFxuICAgICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgLy8gRUMyIHRhc2sgZGVmaW5pdGlvbiAobm8gRmFyZ2F0ZSB2Q1BVIHF1b3RhIHJlcXVpcmVkKVxuICAgICAgY29uc3QgdGFza0RlZiA9IG5ldyBlY3MuVGFza0RlZmluaXRpb24odGhpcywgYFRhc2stJHtzdmN9YCwge1xuICAgICAgICBmYW1pbHk6IGAke3ByZWZpeH0tJHtzdmN9YCxcbiAgICAgICAgY29tcGF0aWJpbGl0eTogZWNzLkNvbXBhdGliaWxpdHkuRUMyLFxuICAgICAgICBuZXR3b3JrTW9kZTogZWNzLk5ldHdvcmtNb2RlLkFXU19WUEMsXG4gICAgICAgIGNwdTogU3RyaW5nKFNFUlZJQ0VfQ1BVW3N2Y10pLFxuICAgICAgICBtZW1vcnlNaUI6IFN0cmluZyhTRVJWSUNFX01FTVtzdmNdKSxcbiAgICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgICAgdGFza1JvbGUsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgYXBwQ29udGFpbmVyID0gdGFza0RlZi5hZGRDb250YWluZXIoYGFwcGAsIHtcbiAgICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeShlY3JSZXBvc1tzdmNdISwgJ2xhdGVzdCcpLFxuICAgICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHsgc3RyZWFtUHJlZml4OiBzdmMsIGxvZ0dyb3VwIH0pLFxuICAgICAgICBwb3J0TWFwcGluZ3M6IFt7IGNvbnRhaW5lclBvcnQ6IDgwODAsIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQIH1dLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIEFTUE5FVENPUkVfRU5WSVJPTk1FTlQ6IGNvbmZpZy5lbnZpcm9ubWVudCA9PT0gJ2RldicgPyAnRGV2ZWxvcG1lbnQnIDogJ1Byb2R1Y3Rpb24nLFxuICAgICAgICAgIEFTUE5FVENPUkVfVVJMUzogJ2h0dHA6Ly8rOjgwODAnLFxuICAgICAgICAgIEFXU19SRUdJT046IGNvbmZpZy5yZWdpb24sXG4gICAgICAgICAgREJfSE9TVDogZGJJbnN0YW5jZS5pbnN0YW5jZUVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgICAgIERCX1BPUlQ6ICc1NDMyJyxcbiAgICAgICAgICAuLi4oREJfU0VSVklDRVNbc3ZjXSA/IHsgREJfTkFNRTogREJfU0VSVklDRVNbc3ZjXSEgfSA6IHt9KSxcbiAgICAgICAgICBSRURJU19FTkRQT0lOVDogcmVkaXMuYXR0ckVuZHBvaW50QWRkcmVzcyxcbiAgICAgICAgICBPUEVOU0VBUkNIX0VORFBPSU5UOiBgaHR0cHM6Ly8ke29wZW5TZWFyY2hEb21haW4uZG9tYWluRW5kcG9pbnR9YCxcbiAgICAgICAgICBBV1NfWFJBWV9EQUVNT05fQUREUkVTUzogJ3hyYXktZGFlbW9uOjIwMDAnLFxuICAgICAgICB9LFxuICAgICAgICBzZWNyZXRzOiB7XG4gICAgICAgICAgREJfU0VDUkVUX0pTT046IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKGRiU2VjcmV0KSxcbiAgICAgICAgfSxcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IFNFUlZJQ0VfTUVNW3N2Y10gLSAyNTYsXG4gICAgICAgIGVzc2VudGlhbDogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBYLVJheSBkYWVtb24gc2lkZWNhclxuICAgICAgY29uc3QgeHJheUNvbnRhaW5lciA9IHRhc2tEZWYuYWRkQ29udGFpbmVyKCd4cmF5LWRhZW1vbicsIHtcbiAgICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoJ3B1YmxpYy5lY3IuYXdzL3hyYXkvYXdzLXhyYXktZGFlbW9uOmxhdGVzdCcpLFxuICAgICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgICBzdHJlYW1QcmVmaXg6IGAke3N2Y30teHJheWAsXG4gICAgICAgICAgbG9nR3JvdXA6IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIGBYcmF5TG9nLSR7c3ZjfWAsIHtcbiAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogYC9lY29tbWVyY2UvJHtjb25maWcuZW52aXJvbm1lbnR9LyR7c3ZjfS94cmF5YCxcbiAgICAgICAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRIUkVFX0RBWVMsXG4gICAgICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KSxcbiAgICAgICAgcG9ydE1hcHBpbmdzOiBbeyBjb250YWluZXJQb3J0OiAyMDAwLCBwcm90b2NvbDogZWNzLlByb3RvY29sLlVEUCB9XSxcbiAgICAgICAgZXNzZW50aWFsOiBmYWxzZSxcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IDI1NixcbiAgICAgICAgY3B1OiAzMixcbiAgICAgIH0pO1xuXG4gICAgICBhcHBDb250YWluZXIuYWRkQ29udGFpbmVyRGVwZW5kZW5jaWVzKHtcbiAgICAgICAgY29udGFpbmVyOiB4cmF5Q29udGFpbmVyLFxuICAgICAgICBjb25kaXRpb246IGVjcy5Db250YWluZXJEZXBlbmRlbmN5Q29uZGl0aW9uLlNUQVJULFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGVjMlNlcnZpY2UgPSBuZXcgZWNzLkVjMlNlcnZpY2UodGhpcywgYFN2Yy0ke3N2Y31gLCB7XG4gICAgICAgIHNlcnZpY2VOYW1lOiBgJHtwcmVmaXh9LSR7c3ZjfWAsXG4gICAgICAgIGNsdXN0ZXIsXG4gICAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDAsIC8vIFN0YXJ0IGF0IDA7IHNjYWxlIHVwIGFmdGVyIHB1c2hpbmcgcmVhbCBpbWFnZXNcbiAgICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgICAgIHNlY3VyaXR5R3JvdXBzOiBbZWNzU2ddLFxuICAgICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgZW5hYmxlOiBmYWxzZSB9LCAvLyBEaXNhYmxlZCBkdXJpbmcgaW5pdGlhbCBpbmZyYSBkZXBsb3lcbiAgICAgICAgY2FwYWNpdHlQcm92aWRlclN0cmF0ZWdpZXM6IFt7XG4gICAgICAgICAgY2FwYWNpdHlQcm92aWRlcjogY2FwYWNpdHlQcm92aWRlci5jYXBhY2l0eVByb3ZpZGVyTmFtZSxcbiAgICAgICAgICB3ZWlnaHQ6IDEsXG4gICAgICAgIH1dLFxuICAgICAgICBjbG91ZE1hcE9wdGlvbnM6IHtcbiAgICAgICAgICBuYW1lOiBzdmMsXG4gICAgICAgICAgY2xvdWRNYXBOYW1lc3BhY2U6IG5hbWVzcGFjZSxcbiAgICAgICAgICBkbnNSZWNvcmRUeXBlOiBzZXJ2aWNlZGlzY292ZXJ5LkRuc1JlY29yZFR5cGUuQSxcbiAgICAgICAgICBkbnNUdGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBPbmx5IGFwaS1nYXRld2F5IGlzIHdpcmVkIHRvIHRoZSBBTEJcbiAgICAgIGlmIChzdmMgPT09ICdhcGktZ2F0ZXdheScpIHtcbiAgICAgICAgY29uc3QgdGcgPSBsaXN0ZW5lci5hZGRUYXJnZXRzKGBUZy0ke3N2Y31gLCB7XG4gICAgICAgICAgdGFyZ2V0R3JvdXBOYW1lOiBgJHtwcmVmaXh9LSR7c3ZjfWAsXG4gICAgICAgICAgcG9ydDogODA4MCxcbiAgICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgICAgIHRhcmdldHM6IFtlYzJTZXJ2aWNlXSxcbiAgICAgICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAgICAgcGF0aDogJy9oZWFsdGgnLFxuICAgICAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGJEbnMnLCAgICAgICAgIHsgdmFsdWU6IGFsYi5sb2FkQmFsYW5jZXJEbnNOYW1lLCAgICAgICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWFsYi1kbnNgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYkVuZHBvaW50JywgICAgICB7IHZhbHVlOiBkYkluc3RhbmNlLmluc3RhbmNlRW5kcG9pbnQuaG9zdG5hbWUsIGV4cG9ydE5hbWU6IGAke3ByZWZpeH0tZGItZW5kcG9pbnRgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZWRpc0VuZHBvaW50JywgICB7IHZhbHVlOiByZWRpcy5hdHRyRW5kcG9pbnRBZGRyZXNzLCAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1yZWRpcy1lbmRwb2ludGAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09wZW5TZWFyY2hFcCcsICAgIHsgdmFsdWU6IG9wZW5TZWFyY2hEb21haW4uZG9tYWluRW5kcG9pbnQsICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LW9wZW5zZWFyY2gtZW5kcG9pbnRgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsICAgICB7IHZhbHVlOiBjbHVzdGVyLmNsdXN0ZXJOYW1lLCAgICAgICAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1jbHVzdGVyLW5hbWVgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYlNlY3JldEFybicsICAgICB7IHZhbHVlOiBkYlNlY3JldC5zZWNyZXRBcm4sICAgICAgICAgICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1kYi1zZWNyZXQtYXJuYCB9KTtcbiAgfVxufVxuIl19