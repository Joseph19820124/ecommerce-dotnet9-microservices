export interface EnvConfig {
  account: string;
  region: string;
  environment: 'dev' | 'staging' | 'prod';
  domainName?: string;
}

export const devConfig: EnvConfig = {
  account: '319125696988',
  region: 'us-east-1',
  environment: 'dev',
};

export const stagingConfig: EnvConfig = {
  account: '319125696988',
  region: 'us-east-1',
  environment: 'staging',
};

export const prodConfig: EnvConfig = {
  account: '319125696988',
  region: 'us-east-1',
  environment: 'prod',
  domainName: process.env.DOMAIN_NAME,
};

export function getConfig(): EnvConfig {
  const env = process.env.DEPLOY_ENV ?? 'dev';
  switch (env) {
    case 'staging':
      return stagingConfig;
    case 'prod':
      return prodConfig;
    default:
      return devConfig;
  }
}

/** CPU and memory units for each service (Fargate vCPU / MiB) */
export interface ServiceResources {
  cpu: number;
  memoryMiB: number;
  desiredCount: number;
}

export const serviceResourceMap: Record<string, ServiceResources> = {
  'api-gateway':       { cpu: 512,  memoryMiB: 1024, desiredCount: 2 },
  'catalog-api':       { cpu: 512,  memoryMiB: 1024, desiredCount: 2 },
  'order-api':         { cpu: 512,  memoryMiB: 1024, desiredCount: 2 },
  'identity-api':      { cpu: 256,  memoryMiB: 512,  desiredCount: 2 },
  'inventory-api':     { cpu: 256,  memoryMiB: 512,  desiredCount: 2 },
  'payment-api':       { cpu: 512,  memoryMiB: 1024, desiredCount: 2 },
  'notification-api':  { cpu: 256,  memoryMiB: 512,  desiredCount: 2 },
  'blazor-frontend':   { cpu: 512,  memoryMiB: 1024, desiredCount: 2 },
};

/** Database names provisioned inside the shared RDS instance */
export const databases = [
  'catalog_db',
  'order_db',
  'identity_db',
  'inventory_db',
  'payment_db',
];

/** Mapping of service name -> database it owns (undefined = no direct DB) */
export const serviceDatabaseMap: Record<string, string | undefined> = {
  'catalog-api':      'catalog_db',
  'order-api':        'order_db',
  'identity-api':     'identity_db',
  'inventory-api':    'inventory_db',
  'payment-api':      'payment_db',
  'notification-api': undefined,
  'api-gateway':      undefined,
  'blazor-frontend':  undefined,
};
