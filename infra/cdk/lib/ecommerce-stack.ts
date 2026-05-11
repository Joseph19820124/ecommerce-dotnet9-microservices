import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cr from 'aws-cdk-lib/custom-resources';
import { EnvConfig } from './config';

export interface ECommerceStackProps extends cdk.StackProps {
  config: EnvConfig;
}

const ALL_SERVICES = [
  'api-gateway', 'catalog-api', 'order-api', 'identity-api',
  'inventory-api', 'payment-api', 'notification-api', 'blazor-frontend',
] as const;
type ServiceName = typeof ALL_SERVICES[number];

const SERVICE_CPU: Record<ServiceName, number> = {
  'api-gateway': 512, 'catalog-api': 512, 'order-api': 512,
  'identity-api': 512, 'inventory-api': 256, 'payment-api': 256,
  'notification-api': 256, 'blazor-frontend': 512,
};
const SERVICE_MEM: Record<ServiceName, number> = {
  'api-gateway': 1024, 'catalog-api': 1024, 'order-api': 1024,
  'identity-api': 1024, 'inventory-api': 512, 'payment-api': 512,
  'notification-api': 512, 'blazor-frontend': 1024,
};
const DB_SERVICES: Partial<Record<ServiceName, string>> = {
  'catalog-api': 'catalog_db', 'order-api': 'order_db',
  'identity-api': 'identity_db', 'inventory-api': 'inventory_db',
  'payment-api': 'payment_db',
};

export class ECommerceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ECommerceStackProps) {
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
        { name: 'Public',   subnetType: ec2.SubnetType.PUBLIC,            cidrMask: 24 },
        { name: 'Private',  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED,  cidrMask: 24 },
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
    const ecrRepos: Partial<Record<ServiceName, ecr.Repository>> = {};
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
        image: ecs.ContainerImage.fromEcrRepository(ecrRepos[svc]!, 'latest'),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: svc, logGroup }),
        portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
        environment: {
          ASPNETCORE_ENVIRONMENT: config.environment === 'dev' ? 'Development' : 'Production',
          ASPNETCORE_URLS: 'http://+:8080',
          AWS_REGION: config.region,
          DB_HOST: dbInstance.instanceEndpoint.hostname,
          DB_PORT: '5432',
          ...(DB_SERVICES[svc] ? { DB_NAME: DB_SERVICES[svc]! } : {}),
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
    new cdk.CfnOutput(this, 'AlbDns',         { value: alb.loadBalancerDnsName,          exportName: `${prefix}-alb-dns` });
    new cdk.CfnOutput(this, 'DbEndpoint',      { value: dbInstance.instanceEndpoint.hostname, exportName: `${prefix}-db-endpoint` });
    new cdk.CfnOutput(this, 'RedisEndpoint',   { value: redis.attrEndpointAddress,        exportName: `${prefix}-redis-endpoint` });
    new cdk.CfnOutput(this, 'OpenSearchEp',    { value: openSearchDomain.domainEndpoint,  exportName: `${prefix}-opensearch-endpoint` });
    new cdk.CfnOutput(this, 'ClusterName',     { value: cluster.clusterName,              exportName: `${prefix}-cluster-name` });
    new cdk.CfnOutput(this, 'DbSecretArn',     { value: dbSecret.secretArn,               exportName: `${prefix}-db-secret-arn` });
  }
}
