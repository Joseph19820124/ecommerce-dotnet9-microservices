export interface EnvConfig {
    account: string;
    region: string;
    environment: 'dev' | 'staging' | 'prod';
    domainName?: string;
}
export declare const devConfig: EnvConfig;
export declare const stagingConfig: EnvConfig;
export declare const prodConfig: EnvConfig;
export declare function getConfig(): EnvConfig;
/** CPU and memory units for each service (Fargate vCPU / MiB) */
export interface ServiceResources {
    cpu: number;
    memoryMiB: number;
    desiredCount: number;
}
export declare const serviceResourceMap: Record<string, ServiceResources>;
/** Database names provisioned inside the shared RDS instance */
export declare const databases: string[];
/** Mapping of service name -> database it owns (undefined = no direct DB) */
export declare const serviceDatabaseMap: Record<string, string | undefined>;
