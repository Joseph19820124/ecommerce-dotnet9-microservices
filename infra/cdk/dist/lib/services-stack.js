"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServicesStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecr = require("aws-cdk-lib/aws-ecr");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const logs = require("aws-cdk-lib/aws-logs");
const servicediscovery = require("aws-cdk-lib/aws-servicediscovery");
const config_1 = require("./config");
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
];
// ---------------------------------------------------------------------------
// ServicesStack
// ---------------------------------------------------------------------------
class ServicesStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, infraStack } = props;
        const prefix = `ecommerce-${config.environment}`;
        const { vpc, ecsCluster, ecsTaskRole, ecsExecutionRole, serviceDiscoveryNamespace, dbSecret, redisAuthSecret, mqSecret, dbInstance, redisServerlessCache, mqBroker, openSearchDomain, albSg, ecsSg, } = infraStack;
        // =========================================================================
        // 1. ECR Repositories — one per service
        // =========================================================================
        this.ecrRepos = {};
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
        const apiGatewayTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiGatewayTg', {
            targetGroupName: `${prefix}-api-gateway-tg`,
            vpc,
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP, // required for Fargate awsvpc
            healthCheck: {
                path: '/health',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                healthyHttpCodes: '200-299',
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });
        // Attach the target group to the HTTP listener as the default forward action
        httpListener.addTargetGroups('ApiGatewayForward', {
            targetGroups: [apiGatewayTargetGroup],
        });
        // =========================================================================
        // 4. Shared environment variables available to every service
        // =========================================================================
        const sharedEnvVars = {
            ASPNETCORE_ENVIRONMENT: config.environment === 'prod' ? 'Production' : 'Development',
            AWS_REGION: config.region,
            DB_HOST: dbInstance.instanceEndpoint.hostname,
            DB_PORT: dbInstance.instanceEndpoint.port.toString(),
            REDIS_ENDPOINT: redisServerlessCache.attrEndpointAddress,
            RABBITMQ_HOST: cdk.Fn.select(0, mqBroker.attrAmqpEndpoints),
            OPENSEARCH_ENDPOINT: `https://${openSearchDomain.domainEndpoint}`,
            SD_NAMESPACE: `${prefix}.local`,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317', // X-Ray via sidecar
            AWS_XRAY_DAEMON_ADDRESS: 'localhost:2000',
        };
        // Secrets injected into the task (ECS resolves them at launch time)
        const sharedSecrets = {
            DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
            DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
            REDIS_AUTH_TOKEN: ecs.Secret.fromSecretsManager(redisAuthSecret),
            RABBITMQ_USERNAME: ecs.Secret.fromSecretsManager(mqSecret, 'username'),
            RABBITMQ_PASSWORD: ecs.Secret.fromSecretsManager(mqSecret, 'password'),
        };
        // =========================================================================
        // 5. Create Fargate task definitions + ECS services for each microservice
        // =========================================================================
        const serviceMap = {};
        for (const svc of ALL_SERVICES) {
            const res = config_1.serviceResourceMap[svc];
            const dbName = config_1.serviceDatabaseMap[svc];
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
            const xrayVolume = {
                name: 'xray-socket',
            };
            taskDef.addVolume(xrayVolume);
            // --- Service environment (merge shared + per-service) ---
            const serviceEnv = {
                ...sharedEnvVars,
                SERVICE_NAME: svc,
                ...(dbName ? { DB_NAME: dbName } : {}),
            };
            // --- Application container ---
            const appContainer = taskDef.addContainer(`${svc}-app`, {
                containerName: svc,
                // Image is a placeholder — CI/CD pipeline will push real images.
                // Using a stub so CDK synthesises without requiring a real image.
                image: ecs.ContainerImage.fromEcrRepository(this.ecrRepos[svc], 'latest'),
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
                image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
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
                command: ['-o'], // -o = no EC2 metadata lookups (Fargate)
                cpu: 32,
                memoryReservationMiB: 256,
                essential: false, // Don't kill task if xray daemon crashes
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
                healthCheck: undefined, // ECS manages health via task health
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
                enableExecuteCommand: true, // allows `ecs exec` for debugging
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
exports.ServicesStack = ServicesStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmljZXMtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc2VydmljZXMtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBRW5DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLGdFQUFnRTtBQUNoRSw2Q0FBNkM7QUFFN0MscUVBQXFFO0FBR3JFLHFDQUtrQjtBQVdsQiwrQkFBK0I7QUFDL0IsTUFBTSxZQUFZLEdBQUc7SUFDbkIsYUFBYTtJQUNiLGFBQWE7SUFDYixXQUFXO0lBQ1gsY0FBYztJQUNkLGVBQWU7SUFDZixhQUFhO0lBQ2Isa0JBQWtCO0lBQ2xCLGlCQUFpQjtDQUNULENBQUM7QUFJWCw4RUFBOEU7QUFDOUUsZ0JBQWdCO0FBQ2hCLDhFQUE4RTtBQUU5RSxNQUFhLGFBQWMsU0FBUSxHQUFHLENBQUMsS0FBSztJQUkxQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlCO1FBQ2pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sRUFBRSxNQUFNLEVBQUUsVUFBVSxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQ3JDLE1BQU0sTUFBTSxHQUFHLGFBQWEsTUFBTSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBRWpELE1BQU0sRUFDSixHQUFHLEVBQ0gsVUFBVSxFQUNWLFdBQVcsRUFDWCxnQkFBZ0IsRUFDaEIseUJBQXlCLEVBQ3pCLFFBQVEsRUFDUixlQUFlLEVBQ2YsUUFBUSxFQUNSLFVBQVUsRUFDVixvQkFBb0IsRUFDcEIsUUFBUSxFQUNSLGdCQUFnQixFQUNoQixLQUFLLEVBQ0wsS0FBSyxHQUNOLEdBQUcsVUFBVSxDQUFDO1FBRWYsNEVBQTRFO1FBQzVFLHdDQUF3QztRQUN4Qyw0RUFBNEU7UUFDNUUsSUFBSSxDQUFDLFFBQVEsR0FBRyxFQUF5QyxDQUFDO1FBRTFELEtBQUssTUFBTSxHQUFH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QUFxQixDQUFDLENBQUM7WUFDdkUsQ0FBQztRQUNILENBQUM7UUFFRCw0RUFBNEU7UUFDNUUsbUJBQW1CO1FBQ25CLDRFQUE0RTtRQUM1RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7WUFDbkMsV0FBVyxFQUFFLHVEQUF1RDtZQUNwRSxVQUFVLEVBQUUsR0FBRyxNQUFNLFVBQVU7U0FDaEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDdkMsS0FBSyxFQUFFLFVBQVUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsRUFBRTtZQUMvQyxXQUFXLEVBQUUsK0JBQStCO1lBQzVDLFVBQVUsRUFBRSxHQUFHLE1BQU0sVUFBVTtTQUNoQyxDQUFDLENBQUM7UUFFSCxLQUFLLE1BQU0sR0FBRyxJQUFJLFlBQVksRUFBRSxDQUFDO1lBQy9CLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxHQUFHLEVBQUUsRUFBRTtnQkFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsYUFBYTtnQkFDdkMsV0FBVyxFQUFFLDBCQUEwQixHQUFHLEVBQUU7Z0JBQzVDLFVBQVUsRUFBRSxHQUFHLE1BQU0sUUFBUSxHQUFHLEVBQUU7YUFDbkMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUNILENBQUM7Q0FDRjtBQXhWRCxzQ0F3VkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBzZXJ2aWNlZGlzY292ZXJ5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZXJ2aWNlZGlzY292ZXJ5JztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCB7IEluZnJhU3RhY2sgfSBmcm9tICcuL2luZnJhLXN0YWNrJztcbmltcG9ydCB7XG4gIEVudkNvbmZpZyxcbiAgc2VydmljZVJlc291cmNlTWFwLFxuICBzZXJ2aWNlRGF0YWJhc2VNYXAsXG4gIFNlcnZpY2VSZXNvdXJjZXMsXG59IGZyb20gJy4vY29uZmlnJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgU2VydmljZXNTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBjb25maWc6IEVudkNvbmZpZztcbiAgaW5mcmFTdGFjazogSW5mcmFTdGFjaztcbn1cblxuLyoqIEFsbCA4IG1pY3Jvc2VydmljZSBuYW1lcyAqL1xuY29uc3QgQUxMX1NFUlZJQ0VTID0gW1xuICAnYXBpLWdhdGV3YXknLFxuICAnY2F0YWxvZy1hcGknLFxuICAnb3JkZXItYXBpJyxcbiAgJ2lkZW50aXR5LWFwaScsXG4gICdpbnZlbnRvcnktYXBpJyxcbiAgJ3BheW1lbnQtYXBpJyxcbiAgJ25vdGlmaWNhdGlvbi1hcGknLFxuICAnYmxhem9yLWZyb250ZW5kJyxcbl0gYXMgY29uc3Q7XG5cbnR5cGUgU2VydmljZU5hbWUgPSB0eXBlb2YgQUxMX1NFUlZJQ0VTW251bWJlcl07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2VydmljZXNTdGFja1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjbGFzcyBTZXJ2aWNlc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGFsYjogZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXI7XG4gIHB1YmxpYyByZWFkb25seSBlY3JSZXBvczogUmVjb3JkPFNlcnZpY2VOYW1lLCBlY3IuUmVwb3NpdG9yeT47XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNlcnZpY2VzU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgeyBjb25maWcsIGluZnJhU3RhY2sgfSA9IHByb3BzO1xuICAgIGNvbnN0IHByZWZpeCA9IGBlY29tbWVyY2UtJHtjb25maWcuZW52aXJvbm1lbnR9YDtcblxuICAgIGNvbnN0IHtcbiAgICAgIHZwYyxcbiAgICAgIGVjc0NsdXN0ZXIsXG4gICAgICBlY3NUYXNrUm9sZSxcbiAgICAgIGVjc0V4ZWN1dGlvblJvbGUsXG4gICAgICBzZXJ2aWNlRGlzY292ZXJ5TmFtZXNwYWNlLFxuICAgICAgZGJTZWNyZXQsXG4gICAgICByZWRpc0F1dGhTZWNyZXQsXG4gICAgICBtcVNlY3JldCxcbiAgICAgIGRiSW5zdGFuY2UsXG4gICAgICByZWRpc1NlcnZlcmxlc3NDYWNoZSxcbiAgICAgIG1xQnJva2VyLFxuICAgICAgb3BlblNlYXJjaERvbWFpbixcbiAgICAgIGFsYlNnLFxuICAgICAgZWNzU2csXG4gICAgfSA9IGluZnJhU3RhY2s7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMS4gRUNSIFJlcG9zaXRvcmllcyDigJQgb25lIHBlciBzZXJ2aWNlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZWNyUmVwb3MgPSB7fSBhcyBSZWNvcmQ8U2VydmljZU5hbWUsIGVjci5SZXBvc2l0b3J5PjtcblxuICAgIGZvciAoY29uc3Qgc3ZjIG9mIEFMTF9TRVJWSUNFUykge1xuICAgICAgY29uc3QgcmVwbyA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCBgRWNyLSR7c3ZjfWAsIHtcbiAgICAgICAgcmVwb3NpdG9yeU5hbWU6IGAke3ByZWZpeH0vJHtzdmN9YCxcbiAgICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgICBpbWFnZVRhZ011dGFiaWxpdHk6IGVjci5UYWdNdXRhYmlsaXR5Lk1VVEFCTEUsXG4gICAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICAgICAgdGFnU3RhdHVzOiBlY3IuVGFnU3RhdHVzLkFOWSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICB9KTtcbiAgICAgIHRoaXMuZWNyUmVwb3Nbc3ZjXSA9IHJlcG87XG5cbiAgICAgIC8vIEVDUiBwdWxsIGlzIGFscmVhZHkgY292ZXJlZCBieSBBbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeSBvbiBlY3NFeGVjdXRpb25Sb2xlXG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDIuIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIg4oCUIGludGVybmV0LWZhY2luZywgcHVibGljIHN1Ym5ldHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5hbGIgPSBuZXcgZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgJ0FsYicsIHtcbiAgICAgIGxvYWRCYWxhbmNlck5hbWU6IGAke3ByZWZpeH0tYWxiYCxcbiAgICAgIHZwYyxcbiAgICAgIGludGVybmV0RmFjaW5nOiB0cnVlLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMgfSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFsYlNnLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIC8vIEhUVFAgbGlzdGVuZXIg4oCUIHJlZGlyZWN0cyB0byBIVFRQUyAob3Igc2VydmVzIGRpcmVjdGx5IGZvciBkZXYpXG4gICAgY29uc3QgaHR0cExpc3RlbmVyID0gdGhpcy5hbGIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDgwLFxuICAgICAgb3BlbjogdHJ1ZSxcbiAgICAgIGRlZmF1bHRBY3Rpb246IGVsYnYyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoMjAwLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnRUNvbW1lcmNlIHBsYXRmb3JtIOKAlCBoZWFsdGh5JyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgLy8gSFRUUFMgbGlzdGVuZXIgKHNlbGYtc2lnbmVkIC8gQUNNIGNlcnQgd291bGQgYmUgaW5qZWN0ZWQgdmlhIGRvbWFpbk5hbWUpXG4gICAgLy8gRm9yIGRldiB3ZSBrZWVwIGl0IHNpbXBsZTogbm8gY2VydGlmaWNhdGUsIEhUVFAgb25seS5cbiAgICAvLyBJbiBwcm9kLCByZXBsYWNlIHRoZSBmaXhlZFJlc3BvbnNlIHdpdGggZm9yd2FyZFRvKGFwaUdhdGV3YXlUYXJnZXRHcm91cCkuXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMy4gQUxCIFRhcmdldCBHcm91cCDigJQgYXBpLWdhdGV3YXkgKHRoZSBvbmx5IGludGVybmV0LWZhY2luZyBzZXJ2aWNlKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhcGlHYXRld2F5VGFyZ2V0R3JvdXAgPSBuZXcgZWxidjIuQXBwbGljYXRpb25UYXJnZXRHcm91cChcbiAgICAgIHRoaXMsXG4gICAgICAnQXBpR2F0ZXdheVRnJyxcbiAgICAgIHtcbiAgICAgICAgdGFyZ2V0R3JvdXBOYW1lOiBgJHtwcmVmaXh9LWFwaS1nYXRld2F5LXRnYCxcbiAgICAgICAgdnBjLFxuICAgICAgICBwb3J0OiA4MDgwLFxuICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgICB0YXJnZXRUeXBlOiBlbGJ2Mi5UYXJnZXRUeXBlLklQLCAgICAvLyByZXF1aXJlZCBmb3IgRmFyZ2F0ZSBhd3N2cGNcbiAgICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgICBwYXRoOiAnL2hlYWx0aCcsXG4gICAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMC0yOTknLFxuICAgICAgICB9LFxuICAgICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICAvLyBBdHRhY2ggdGhlIHRhcmdldCBncm91cCB0byB0aGUgSFRUUCBsaXN0ZW5lciBhcyB0aGUgZGVmYXVsdCBmb3J3YXJkIGFjdGlvblxuICAgIGh0dHBMaXN0ZW5lci5hZGRUYXJnZXRHcm91cHMoJ0FwaUdhdGV3YXlGb3J3YXJkJywge1xuICAgICAgdGFyZ2V0R3JvdXBzOiBbYXBpR2F0ZXdheVRhcmdldEdyb3VwXSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA0LiBTaGFyZWQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGF2YWlsYWJsZSB0byBldmVyeSBzZXJ2aWNlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHNoYXJlZEVudlZhcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICBBU1BORVRDT1JFX0VOVklST05NRU5UOiAgY29uZmlnLmVudmlyb25tZW50ID09PSAncHJvZCcgPyAnUHJvZHVjdGlvbicgOiAnRGV2ZWxvcG1lbnQnLFxuICAgICAgQVdTX1JFR0lPTjogICAgICAgICAgICAgIGNvbmZpZy5yZWdpb24sXG4gICAgICBEQl9IT1NUOiAgICAgICAgICAgICAgICAgZGJJbnN0YW5jZS5pbnN0YW5jZUVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgREJfUE9SVDogICAgICAgICAgICAgICAgIGRiSW5zdGFuY2UuaW5zdGFuY2VFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICBSRURJU19FTkRQT0lOVDogICAgICAgICAgcmVkaXNTZXJ2ZXJsZXNzQ2FjaGUuYXR0ckVuZHBvaW50QWRkcmVzcyxcbiAgICAgIFJBQkJJVE1RX0hPU1Q6ICAgICAgICAgICBjZGsuRm4uc2VsZWN0KDAsIG1xQnJva2VyLmF0dHJBbXFwRW5kcG9pbnRzKSxcbiAgICAgIE9QRU5TRUFSQ0hfRU5EUE9JTlQ6ICAgICBgaHR0cHM6Ly8ke29wZW5TZWFyY2hEb21haW4uZG9tYWluRW5kcG9pbnR9YCxcbiAgICAgIFNEX05BTUVTUEFDRTogICAgICAgICAgICBgJHtwcmVmaXh9LmxvY2FsYCxcbiAgICAgIE9URUxfRVhQT1JURVJfT1RMUF9FTkRQT0lOVDogJ2h0dHA6Ly9sb2NhbGhvc3Q6NDMxNycsICAvLyBYLVJheSB2aWEgc2lkZWNhclxuICAgICAgQVdTX1hSQVlfREFFTU9OX0FERFJFU1M6ICdsb2NhbGhvc3Q6MjAwMCcsXG4gICAgfTtcblxuICAgIC8vIFNlY3JldHMgaW5qZWN0ZWQgaW50byB0aGUgdGFzayAoRUNTIHJlc29sdmVzIHRoZW0gYXQgbGF1bmNoIHRpbWUpXG4gICAgY29uc3Qgc2hhcmVkU2VjcmV0czogUmVjb3JkPHN0cmluZywgZWNzLlNlY3JldD4gPSB7XG4gICAgICBEQl9QQVNTV09SRDogICAgICAgZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIoZGJTZWNyZXQsICAgICAgICdwYXNzd29yZCcpLFxuICAgICAgREJfVVNFUk5BTUU6ICAgICAgIGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKGRiU2VjcmV0LCAgICAgICAndXNlcm5hbWUnKSxcbiAgICAgIFJFRElTX0FVVEhfVE9LRU46ICBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihyZWRpc0F1dGhTZWNyZXQpLFxuICAgICAgUkFCQklUTVFfVVNFUk5BTUU6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKG1xU2VjcmV0LCAgICAgICAndXNlcm5hbWUnKSxcbiAgICAgIFJBQkJJVE1RX1BBU1NXT1JEOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihtcVNlY3JldCwgICAgICAgJ3Bhc3N3b3JkJyksXG4gICAgfTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA1LiBDcmVhdGUgRmFyZ2F0ZSB0YXNrIGRlZmluaXRpb25zICsgRUNTIHNlcnZpY2VzIGZvciBlYWNoIG1pY3Jvc2VydmljZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBzZXJ2aWNlTWFwOiBSZWNvcmQ8c3RyaW5nLCBlY3MuRmFyZ2F0ZVNlcnZpY2U+ID0ge307XG5cbiAgICBmb3IgKGNvbnN0IHN2YyBvZiBBTExfU0VSVklDRVMpIHtcbiAgICAgIGNvbnN0IHJlczogU2VydmljZVJlc291cmNlcyA9IHNlcnZpY2VSZXNvdXJjZU1hcFtzdmNdO1xuICAgICAgY29uc3QgZGJOYW1lID0gc2VydmljZURhdGFiYXNlTWFwW3N2Y107XG5cbiAgICAgIC8vIC0tLSBDbG91ZFdhdGNoIExvZyBHcm91cCAtLS1cbiAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgYExvZ0dyb3VwLSR7c3ZjfWAsIHtcbiAgICAgICAgbG9nR3JvdXBOYW1lOiBgL2Vjb21tZXJjZS8ke2NvbmZpZy5lbnZpcm9ubWVudH0vJHtzdmN9YCxcbiAgICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIC0tLSBUYXNrIERlZmluaXRpb24gLS0tXG4gICAgICBjb25zdCB0YXNrRGVmID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgYFRhc2tEZWYtJHtzdmN9YCwge1xuICAgICAgICBmYW1pbHk6IGAke3ByZWZpeH0tJHtzdmN9YCxcbiAgICAgICAgY3B1OiByZXMuY3B1LFxuICAgICAgICBtZW1vcnlMaW1pdE1pQjogcmVzLm1lbW9yeU1pQixcbiAgICAgICAgdGFza1JvbGU6IGVjc1Rhc2tSb2xlLFxuICAgICAgICBleGVjdXRpb25Sb2xlOiBlY3NFeGVjdXRpb25Sb2xlLFxuICAgICAgICBydW50aW1lUGxhdGZvcm06IHtcbiAgICAgICAgICBvcGVyYXRpbmdTeXN0ZW1GYW1pbHk6IGVjcy5PcGVyYXRpbmdTeXN0ZW1GYW1pbHkuTElOVVgsXG4gICAgICAgICAgY3B1QXJjaGl0ZWN0dXJlOiBlY3MuQ3B1QXJjaGl0ZWN0dXJlLlg4Nl82NCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyAtLS0gU2hhcmVkIHZvbHVtZSBmb3IgWC1SYXkgc29ja2V0IC0tLVxuICAgICAgY29uc3QgeHJheVZvbHVtZTogZWNzLlZvbHVtZSA9IHtcbiAgICAgICAgbmFtZTogJ3hyYXktc29ja2V0JyxcbiAgICAgIH07XG4gICAgICB0YXNrRGVmLmFkZFZvbHVtZSh4cmF5Vm9sdW1lKTtcblxuICAgICAgLy8gLS0tIFNlcnZpY2UgZW52aXJvbm1lbnQgKG1lcmdlIHNoYXJlZCArIHBlci1zZXJ2aWNlKSAtLS1cbiAgICAgIGNvbnN0IHNlcnZpY2VFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIC4uLnNoYXJlZEVudlZhcnMsXG4gICAgICAgIFNFUlZJQ0VfTkFNRTogc3ZjLFxuICAgICAgICAuLi4oZGJOYW1lID8geyBEQl9OQU1FOiBkYk5hbWUgfSA6IHt9KSxcbiAgICAgIH07XG5cbiAgICAgIC8vIC0tLSBBcHBsaWNhdGlvbiBjb250YWluZXIgLS0tXG4gICAgICBjb25zdCBhcHBDb250YWluZXIgPSB0YXNrRGVmLmFkZENvbnRhaW5lcihgJHtzdmN9LWFwcGAsIHtcbiAgICAgICAgY29udGFpbmVyTmFtZTogc3ZjLFxuICAgICAgICAvLyBJbWFnZSBpcyBhIHBsYWNlaG9sZGVyIOKAlCBDSS9DRCBwaXBlbGluZSB3aWxsIHB1c2ggcmVhbCBpbWFnZXMuXG4gICAgICAgIC8vIFVzaW5nIGEgc3R1YiBzbyBDREsgc3ludGhlc2lzZXMgd2l0aG91dCByZXF1aXJpbmcgYSByZWFsIGltYWdlLlxuICAgICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KFxuICAgICAgICAgIHRoaXMuZWNyUmVwb3Nbc3ZjXSxcbiAgICAgICAgICAnbGF0ZXN0JyxcbiAgICAgICAgKSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHNlcnZpY2VFbnYsXG4gICAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgICAuLi5zaGFyZWRTZWNyZXRzLFxuICAgICAgICB9LFxuICAgICAgICBwb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjb250YWluZXJQb3J0OiA4MDgwLFxuICAgICAgICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgICAgICAgICBuYW1lOiBgJHtzdmN9LWh0dHBgLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgIGxvZ0dyb3VwLFxuICAgICAgICAgIHN0cmVhbVByZWZpeDogc3ZjLFxuICAgICAgICB9KSxcbiAgICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgICBjb21tYW5kOiBbXG4gICAgICAgICAgICAnQ01ELVNIRUxMJyxcbiAgICAgICAgICAgICdjdXJsIC1mIGh0dHA6Ly9sb2NhbGhvc3Q6ODA4MC9oZWFsdGggfHwgZXhpdCAxJyxcbiAgICAgICAgICBdLFxuICAgICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgICAgcmV0cmllczogMyxcbiAgICAgICAgICBzdGFydFBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgICB9LFxuICAgICAgICBlc3NlbnRpYWw6IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgLy8gTW91bnQgdGhlIHNoYXJlZCBYLVJheSBzb2NrZXQgdm9sdW1lIChyZWFkL3dyaXRlIGZvciBhcHApXG4gICAgICBhcHBDb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBjb250YWluZXJQYXRoOiAnL3RtcC94cmF5JyxcbiAgICAgICAgc291cmNlVm9sdW1lOiAneHJheS1zb2NrZXQnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tIFgtUmF5IERhZW1vbiBzaWRlY2FyIGNvbnRhaW5lciAtLS1cbiAgICAgIGNvbnN0IHhyYXlMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIGBYUmF5TG9nR3JvdXAtJHtzdmN9YCwge1xuICAgICAgICBsb2dHcm91cE5hbWU6IGAvZWNvbW1lcmNlLyR7Y29uZmlnLmVudmlyb25tZW50fS8ke3N2Y30veHJheWAsXG4gICAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHhyYXlDb250YWluZXIgPSB0YXNrRGVmLmFkZENvbnRhaW5lcihgJHtzdmN9LXhyYXktZGFlbW9uYCwge1xuICAgICAgICBjb250YWluZXJOYW1lOiAneHJheS1kYWVtb24nLFxuICAgICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21SZWdpc3RyeShcbiAgICAgICAgICAncHVibGljLmVjci5hd3MveHJheS9hd3MteHJheS1kYWVtb246bGF0ZXN0JyxcbiAgICAgICAgKSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBBV1NfUkVHSU9OOiBjb25maWcucmVnaW9uLFxuICAgICAgICB9LFxuICAgICAgICBwb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjb250YWluZXJQb3J0OiAyMDAwLFxuICAgICAgICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5VRFAsXG4gICAgICAgICAgICBuYW1lOiAneHJheS11ZHAnLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgIGxvZ0dyb3VwOiB4cmF5TG9nR3JvdXAsXG4gICAgICAgICAgc3RyZWFtUHJlZml4OiAneHJheScsXG4gICAgICAgIH0pLFxuICAgICAgICBjb21tYW5kOiBbJy1vJ10sICAgICAgICAgICAvLyAtbyA9IG5vIEVDMiBtZXRhZGF0YSBsb29rdXBzIChGYXJnYXRlKVxuICAgICAgICBjcHU6IDMyLFxuICAgICAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogMjU2LFxuICAgICAgICBlc3NlbnRpYWw6IGZhbHNlLCAgICAgICAgICAvLyBEb24ndCBraWxsIHRhc2sgaWYgeHJheSBkYWVtb24gY3Jhc2hlc1xuICAgICAgfSk7XG5cbiAgICAgIC8vIE1vdW50IHRoZSBzaGFyZWQgWC1SYXkgc29ja2V0IHZvbHVtZSAocmVhZC1vbmx5IGZvciB0aGUgZGFlbW9uKVxuICAgICAgeHJheUNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvdG1wL3hyYXknLFxuICAgICAgICBzb3VyY2VWb2x1bWU6ICd4cmF5LXNvY2tldCcsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBcHAgZGVwZW5kcyBvbiBYLVJheSBkYWVtb24gYmVpbmcgaGVhbHRoeSBiZWZvcmUgc3RhcnRpbmdcbiAgICAgIGFwcENvbnRhaW5lci5hZGRDb250YWluZXJEZXBlbmRlbmNpZXMoe1xuICAgICAgICBjb250YWluZXI6IHhyYXlDb250YWluZXIsXG4gICAgICAgIGNvbmRpdGlvbjogZWNzLkNvbnRhaW5lckRlcGVuZGVuY3lDb25kaXRpb24uU1RBUlQsXG4gICAgICB9KTtcblxuICAgICAgLy8gLS0tIENsb3VkIE1hcCBzZXJ2aWNlIGZvciBzZXJ2aWNlIGRpc2NvdmVyeSAtLS1cbiAgICAgIGNvbnN0IHNkU2VydmljZSA9IG5ldyBzZXJ2aWNlZGlzY292ZXJ5LlNlcnZpY2UodGhpcywgYFNkU2VydmljZS0ke3N2Y31gLCB7XG4gICAgICAgIG5hbWU6IHN2YyxcbiAgICAgICAgbmFtZXNwYWNlOiBzZXJ2aWNlRGlzY292ZXJ5TmFtZXNwYWNlLFxuICAgICAgICBkZXNjcmlwdGlvbjogYCR7c3ZjfSBzZXJ2aWNlIGRpc2NvdmVyeSByZWNvcmRgLFxuICAgICAgICBkbnNSZWNvcmRUeXBlOiBzZXJ2aWNlZGlzY292ZXJ5LkRuc1JlY29yZFR5cGUuQSxcbiAgICAgICAgZG5zVHRsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgIGhlYWx0aENoZWNrOiB1bmRlZmluZWQsICAgLy8gRUNTIG1hbmFnZXMgaGVhbHRoIHZpYSB0YXNrIGhlYWx0aFxuICAgICAgICBjdXN0b21IZWFsdGhDaGVjazoge1xuICAgICAgICAgIGZhaWx1cmVUaHJlc2hvbGQ6IDMsXG4gICAgICAgIH0sXG4gICAgICAgIHJvdXRpbmdQb2xpY3k6IHNlcnZpY2VkaXNjb3ZlcnkuUm91dGluZ1BvbGljeS5NVUxUSVZBTFVFLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIC0tLSBGYXJnYXRlIFNlcnZpY2UgLS0tXG4gICAgICBjb25zdCBmYXJnYXRlU2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgYEZhcmdhdGVTdmMtJHtzdmN9YCwge1xuICAgICAgICBzZXJ2aWNlTmFtZTogYCR7cHJlZml4fS0ke3N2Y31gLFxuICAgICAgICBjbHVzdGVyOiBlY3NDbHVzdGVyLFxuICAgICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZixcbiAgICAgICAgZGVzaXJlZENvdW50OiByZXMuZGVzaXJlZENvdW50LFxuICAgICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IFtlY3NTZ10sXG4gICAgICAgIGFzc2lnblB1YmxpY0lwOiBmYWxzZSxcbiAgICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHRydWUsICAgLy8gYWxsb3dzIGBlY3MgZXhlY2AgZm9yIGRlYnVnZ2luZ1xuICAgICAgICBjaXJjdWl0QnJlYWtlcjogeyByb2xsYmFjazogdHJ1ZSB9LFxuICAgICAgICBkZXBsb3ltZW50Q29udHJvbGxlcjoge1xuICAgICAgICAgIHR5cGU6IGVjcy5EZXBsb3ltZW50Q29udHJvbGxlclR5cGUuRUNTLFxuICAgICAgICB9LFxuICAgICAgICBjYXBhY2l0eVByb3ZpZGVyU3RyYXRlZ2llczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNhcGFjaXR5UHJvdmlkZXI6ICdGQVJHQVRFJyxcbiAgICAgICAgICAgIHdlaWdodDogMSxcbiAgICAgICAgICAgIGJhc2U6IDEsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjYXBhY2l0eVByb3ZpZGVyOiAnRkFSR0FURV9TUE9UJyxcbiAgICAgICAgICAgIHdlaWdodDogY29uZmlnLmVudmlyb25tZW50ID09PSAncHJvZCcgPyAwIDogMSxcbiAgICAgICAgICAgIGJhc2U6IDAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgY2xvdWRNYXBPcHRpb25zOiB7XG4gICAgICAgICAgY2xvdWRNYXBOYW1lc3BhY2U6IHNlcnZpY2VEaXNjb3ZlcnlOYW1lc3BhY2UsXG4gICAgICAgICAgbmFtZTogc3ZjLFxuICAgICAgICAgIGRuc1JlY29yZFR5cGU6IHNlcnZpY2VkaXNjb3ZlcnkuRG5zUmVjb3JkVHlwZS5BLFxuICAgICAgICAgIGRuc1R0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICB9LFxuICAgICAgICBtaW5IZWFsdGh5UGVyY2VudDogNTAsXG4gICAgICAgIG1heEhlYWx0aHlQZXJjZW50OiAyMDAsXG4gICAgICAgIHByb3BhZ2F0ZVRhZ3M6IGVjcy5Qcm9wYWdhdGVkVGFnU291cmNlLlNFUlZJQ0UsXG4gICAgICB9KTtcblxuICAgICAgc2VydmljZU1hcFtzdmNdID0gZmFyZ2F0ZVNlcnZpY2U7XG5cbiAgICAgIC8vIFJlZ2lzdGVyIGFwaS1nYXRld2F5IHdpdGggdGhlIEFMQiB0YXJnZXQgZ3JvdXBcbiAgICAgIGlmIChzdmMgPT09ICdhcGktZ2F0ZXdheScpIHtcbiAgICAgICAgZmFyZ2F0ZVNlcnZpY2UuYXR0YWNoVG9BcHBsaWNhdGlvblRhcmdldEdyb3VwKGFwaUdhdGV3YXlUYXJnZXRHcm91cCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIDYuIFN0YWNrIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FsYkRuc05hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5hbGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQUxCIHB1YmxpYyBETlMgbmFtZSDigJQgcG9pbnQgeW91ciBDTkFNRSAvIEEtYWxpYXMgaGVyZScsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWFsYi1kbnNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaUdhdGV3YXlVcmwnLCB7XG4gICAgICB2YWx1ZTogYGh0dHA6Ly8ke3RoaXMuYWxiLmxvYWRCYWxhbmNlckRuc05hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIEdhdGV3YXkgcHVibGljIFVSTCAoSFRUUCknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJlZml4fS1hcGktdXJsYCxcbiAgICB9KTtcblxuICAgIGZvciAoY29uc3Qgc3ZjIG9mIEFMTF9TRVJWSUNFUykge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgYEVjclJlcG8tJHtzdmN9YCwge1xuICAgICAgICB2YWx1ZTogdGhpcy5lY3JSZXBvc1tzdmNdLnJlcG9zaXRvcnlVcmksXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgRUNSIHJlcG9zaXRvcnkgVVJJIGZvciAke3N2Y31gLFxuICAgICAgICBleHBvcnROYW1lOiBgJHtwcmVmaXh9LWVjci0ke3N2Y31gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG4iXX0=