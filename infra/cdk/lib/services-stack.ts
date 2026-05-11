import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as iam from 'aws-cdk-lib/aws-iam';
import { InfraStack } from './infra-stack';
import {
  EnvConfig,
  serviceResourceMap,
  serviceDatabaseMap,
  ServiceResources,
} from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServicesStackProps extends cdk.StackProps {
  config: EnvConfig;
  infraStack: InfraStack;
}

/** All 8 microservice names */
const ALL_SERVICES = [
  'api-gateway',
  'catalog-api',
  'order-api',
  'identity-api',
  'inventory-api',
  'payment-api',
  'notification-api',
  'blazor-frontend',
] as const;

type ServiceName = typeof ALL_SERVICES[number];

// ---------------------------------------------------------------------------
// ServicesStack
// ---------------------------------------------------------------------------

export class ServicesStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly ecrRepos: Record<ServiceName, ecr.Repository>;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const { config, infraStack } = props;
    const prefix = `ecommerce-${config.environment}`;

    const {
      vpc,
      ecsCluster,
      ecsTaskRole,
      ecsExecutionRole,
      serviceDiscoveryNamespace,
      dbSecret,
      redisAuthSecret,
      mqSecret,
      dbInstance,
      redisServerlessCache,
      mqBroker,
      openSearchDomain,
      albSg,
      ecsSg,
    } = infraStack;

    // =========================================================================
    // 1. ECR Repositories — one per service
    // =========================================================================
    this.ecrRepos = {} as Record<ServiceName, ecr.Repository>;

    for (const svc of ALL_SERVICES) {
      const repo = new ecr.Repository(this, `Ecr-${svc}`, {
        repositoryName: `${prefix}/${svc}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        lifecycleRules: [
          {
            description: 'Keep last 10 images',
            maxImageCount: 10,
            tagStatus: ecr.TagStatus.ANY,
          },
        ],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      this.ecrRepos[svc] = repo;

      // ECR pull is already covered by AmazonECSTaskExecutionRolePolicy on ecsExecutionRole
    }

    // =========================================================================
    // 2. Application Load Balancer — internet-facing, public subnets
    // =========================================================================
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${prefix}-alb`,
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
      deletionProtection: false,
    });

    // HTTP listener — redirects to HTTPS (or serves directly for dev)
    const httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'ECommerce platform — healthy',
      }),
    });

    // HTTPS listener (self-signed / ACM cert would be injected via domainName)
    // For dev we keep it simple: no certificate, HTTP only.
    // In prod, replace the fixedResponse with forwardTo(apiGatewayTargetGroup).

    // =========================================================================
    // 3. ALB Target Group — api-gateway (the only internet-facing service)
    // =========================================================================
    const apiGatewayTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'ApiGatewayTg',
      {
        targetGroupName: `${prefix}-api-gateway-tg`,
        vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,    // required for Fargate awsvpc
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: '200-299',
        },
        deregistrationDelay: cdk.Duration.seconds(30),
      },
    );

    // Attach the target group to the HTTP listener as the default forward action
    httpListener.addTargetGroups('ApiGatewayForward', {
      targetGroups: [apiGatewayTargetGroup],
    });

    // =========================================================================
    // 4. Shared environment variables available to every service
    // =========================================================================
    const sharedEnvVars: Record<string, string> = {
      ASPNETCORE_ENVIRONMENT:  config.environment === 'prod' ? 'Production' : 'Development',
      AWS_REGION:              config.region,
      DB_HOST:                 dbInstance.instanceEndpoint.hostname,
      DB_PORT:                 dbInstance.instanceEndpoint.port.toString(),
      REDIS_ENDPOINT:          redisServerlessCache.attrEndpointAddress,
      RABBITMQ_HOST:           cdk.Fn.select(0, mqBroker.attrAmqpEndpoints),
      OPENSEARCH_ENDPOINT:     `https://${openSearchDomain.domainEndpoint}`,
      SD_NAMESPACE:            `${prefix}.local`,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',  // X-Ray via sidecar
      AWS_XRAY_DAEMON_ADDRESS: 'localhost:2000',
    };

    // Secrets injected into the task (ECS resolves them at launch time)
    const sharedSecrets: Record<string, ecs.Secret> = {
      DB_PASSWORD:       ecs.Secret.fromSecretsManager(dbSecret,       'password'),
      DB_USERNAME:       ecs.Secret.fromSecretsManager(dbSecret,       'username'),
      REDIS_AUTH_TOKEN:  ecs.Secret.fromSecretsManager(redisAuthSecret),
      RABBITMQ_USERNAME: ecs.Secret.fromSecretsManager(mqSecret,       'username'),
      RABBITMQ_PASSWORD: ecs.Secret.fromSecretsManager(mqSecret,       'password'),
    };

    // =========================================================================
    // 5. Create Fargate task definitions + ECS services for each microservice
    // =========================================================================
    const serviceMap: Record<string, ecs.FargateService> = {};

    for (const svc of ALL_SERVICES) {
      const res: ServiceResources = serviceResourceMap[svc];
      const dbName = serviceDatabaseMap[svc];

      // --- CloudWatch Log Group ---
      const logGroup = new logs.LogGroup(this, `LogGroup-${svc}`, {
        logGroupName: `/ecommerce/${config.environment}/${svc}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // --- Task Definition ---
      const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef-${svc}`, {
        family: `${prefix}-${svc}`,
        cpu: res.cpu,
        memoryLimitMiB: res.memoryMiB,
        taskRole: ecsTaskRole,
        executionRole: ecsExecutionRole,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
        },
      });

      // --- Shared volume for X-Ray socket ---
      const xrayVolume: ecs.Volume = {
        name: 'xray-socket',
      };
      taskDef.addVolume(xrayVolume);

      // --- Service environment (merge shared + per-service) ---
      const serviceEnv: Record<string, string> = {
        ...sharedEnvVars,
        SERVICE_NAME: svc,
        ...(dbName ? { DB_NAME: dbName } : {}),
      };

      // --- Application container ---
      const appContainer = taskDef.addContainer(`${svc}-app`, {
        containerName: svc,
        // Image is a placeholder — CI/CD pipeline will push real images.
        // Using a stub so CDK synthesises without requiring a real image.
        image: ecs.ContainerImage.fromEcrRepository(
          this.ecrRepos[svc],
          'latest',
        ),
        environment: serviceEnv,
        secrets: {
          ...sharedSecrets,
        },
        portMappings: [
          {
            containerPort: 8080,
            protocol: ecs.Protocol.TCP,
            name: `${svc}-http`,
          },
        ],
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: svc,
        }),
        healthCheck: {
          command: [
            'CMD-SHELL',
            'curl -f http://localhost:8080/health || exit 1',
          ],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(60),
        },
        essential: true,
      });

      // Mount the shared X-Ray socket volume (read/write for app)
      appContainer.addMountPoints({
        containerPath: '/tmp/xray',
        sourceVolume: 'xray-socket',
        readOnly: false,
      });

      // --- X-Ray Daemon sidecar container ---
      const xrayLogGroup = new logs.LogGroup(this, `XRayLogGroup-${svc}`, {
        logGroupName: `/ecommerce/${config.environment}/${svc}/xray`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const xrayContainer = taskDef.addContainer(`${svc}-xray-daemon`, {
        containerName: 'xray-daemon',
        image: ecs.ContainerImage.fromRegistry(
          'public.ecr.aws/xray/aws-xray-daemon:latest',
        ),
        environment: {
          AWS_REGION: config.region,
        },
        portMappings: [
          {
            containerPort: 2000,
            protocol: ecs.Protocol.UDP,
            name: 'xray-udp',
          },
        ],
        logging: ecs.LogDrivers.awsLogs({
          logGroup: xrayLogGroup,
          streamPrefix: 'xray',
        }),
        command: ['-o'],           // -o = no EC2 metadata lookups (Fargate)
        cpu: 32,
        memoryReservationMiB: 256,
        essential: false,          // Don't kill task if xray daemon crashes
      });

      // Mount the shared X-Ray socket volume (read-only for the daemon)
      xrayContainer.addMountPoints({
        containerPath: '/tmp/xray',
        sourceVolume: 'xray-socket',
        readOnly: false,
      });

      // App depends on X-Ray daemon being healthy before starting
      appContainer.addContainerDependencies({
        container: xrayContainer,
        condition: ecs.ContainerDependencyCondition.START,
      });

      // --- Cloud Map service for service discovery ---
      const sdService = new servicediscovery.Service(this, `SdService-${svc}`, {
        name: svc,
        namespace: serviceDiscoveryNamespace,
        description: `${svc} service discovery record`,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
        healthCheck: undefined,   // ECS manages health via task health
        customHealthCheck: {
          failureThreshold: 3,
        },
        routingPolicy: servicediscovery.RoutingPolicy.MULTIVALUE,
      });

      // --- Fargate Service ---
      const fargateService = new ecs.FargateService(this, `FargateSvc-${svc}`, {
        serviceName: `${prefix}-${svc}`,
        cluster: ecsCluster,
        taskDefinition: taskDef,
        desiredCount: res.desiredCount,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ecsSg],
        assignPublicIp: false,
        enableExecuteCommand: true,   // allows `ecs exec` for debugging
        circuitBreaker: { rollback: true },
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
        capacityProviderStrategies: [
          {
            capacityProvider: 'FARGATE',
            weight: 1,
            base: 1,
          },
          {
            capacityProvider: 'FARGATE_SPOT',
            weight: config.environment === 'prod' ? 0 : 1,
            base: 0,
          },
        ],
        cloudMapOptions: {
          cloudMapNamespace: serviceDiscoveryNamespace,
          name: svc,
          dnsRecordType: servicediscovery.DnsRecordType.A,
          dnsTtl: cdk.Duration.seconds(10),
        },
        minHealthyPercent: 50,
        maxHealthyPercent: 200,
        propagateTags: ecs.PropagatedTagSource.SERVICE,
      });

      serviceMap[svc] = fargateService;

      // Register api-gateway with the ALB target group
      if (svc === 'api-gateway') {
        fargateService.attachToApplicationTargetGroup(apiGatewayTargetGroup);
      }
    }

    // =========================================================================
    // 6. Stack Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB public DNS name — point your CNAME / A-alias here',
      exportName: `${prefix}-alb-dns`,
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: `http://${this.alb.loadBalancerDnsName}`,
      description: 'API Gateway public URL (HTTP)',
      exportName: `${prefix}-api-url`,
    });

    for (const svc of ALL_SERVICES) {
      new cdk.CfnOutput(this, `EcrRepo-${svc}`, {
        value: this.ecrRepos[svc].repositoryUri,
        description: `ECR repository URI for ${svc}`,
        exportName: `${prefix}-ecr-${svc}`,
      });
    }
  }
}
