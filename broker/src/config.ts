import dotenv from 'dotenv';

// Load .env from the broker/ directory (cwd) into process.env.
dotenv.config();

export interface BrokerConfig {
  rpcUrl: string;
  brokerAccountAddress: string;
  brokerPrivateKey: string;
  viewingKey: string;
  provingServiceUrl: string;
  indexerUrl: string;
  privacyPoolAddress: string;
  policyRegistryAddress: string;
  credentialIssuerAddress: string;
  port: number;
}

const REQUIRED_STRING_VARS = [
  'RPC_URL',
  'BROKER_ACCOUNT_ADDRESS',
  'BROKER_PRIVATE_KEY',
  'VIEWING_KEY',
  'PROVING_SERVICE_URL',
  'INDEXER_URL',
  'PRIVACY_POOL_ADDRESS',
  'POLICY_REGISTRY_ADDRESS',
  'CREDENTIAL_ISSUER_ADDRESS',
] as const;

/**
 * Load and validate broker configuration from the environment.
 * Throws a single clear error listing every missing variable.
 */
export function loadConfig(): BrokerConfig {
  const missing: string[] = [];
  const values: Partial<Record<(typeof REQUIRED_STRING_VARS)[number], string>> = {};

  for (const name of REQUIRED_STRING_VARS) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      missing.push(name);
    } else {
      values[name] = raw.trim();
    }
  }

  let port: number | undefined;
  const portRaw = process.env.PORT;
  if (portRaw === undefined || portRaw.trim() === '') {
    missing.push('PORT');
  } else {
    const parsed = Number.parseInt(portRaw.trim(), 10);
    if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`Invalid PORT value: "${portRaw}" — must be an integer between 1 and 65535.`);
    }
    port = parsed;
  }

  if (missing.length > 0) {
    throw new Error(
      `Incomplete broker configuration — missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy broker/.env.example to broker/.env and fill in every variable before starting the server.',
    );
  }

  return {
    rpcUrl: values.RPC_URL as string,
    brokerAccountAddress: values.BROKER_ACCOUNT_ADDRESS as string,
    brokerPrivateKey: values.BROKER_PRIVATE_KEY as string,
    viewingKey: values.VIEWING_KEY as string,
    provingServiceUrl: values.PROVING_SERVICE_URL as string,
    indexerUrl: values.INDEXER_URL as string,
    privacyPoolAddress: values.PRIVACY_POOL_ADDRESS as string,
    policyRegistryAddress: values.POLICY_REGISTRY_ADDRESS as string,
    credentialIssuerAddress: values.CREDENTIAL_ISSUER_ADDRESS as string,
    port: port as number,
  };
}
