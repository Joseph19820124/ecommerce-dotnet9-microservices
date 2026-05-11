import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InfraStack } from './infra-stack';
import { EnvConfig } from './config';
export interface ServicesStackProps extends cdk.StackProps {
    config: EnvConfig;
    infraStack: InfraStack;
}
/** All 8 microservice names */
declare const ALL_SERVICES: readonly ["api-gateway", "catalog-api", "order-api", "identity-api", "inventory-api", "payment-api", "notification-api", "blazor-frontend"];
type ServiceName = typeof ALL_SERVICES[number];
export declare class ServicesStack extends cdk.Stack {
    readonly alb: elbv2.ApplicationLoadBalancer;
    readonly ecrRepos: Record<ServiceName, ecr.Repository>;
    constructor(scope: Construct, id: string, props: ServicesStackProps);
}
export {};
