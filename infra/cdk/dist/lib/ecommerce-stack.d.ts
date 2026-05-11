import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvConfig } from './config';
export interface ECommerceStackProps extends cdk.StackProps {
    config: EnvConfig;
}
export declare class ECommerceStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ECommerceStackProps);
}
