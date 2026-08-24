import dotenv from 'dotenv';

// Load .env from the broker/ directory (cwd) into process.env.
dotenv.config();

export interface BrokerConfig {
  rpcUrl: string;
  /** The Broker's own Starknet account — signing/transaction identity ONLY. */
  brokerAccountAddress: string;
  /**
   * The Owner identity whose on-chain spend policies this broker checks
   * against (Decision 0001: Broker and Owner are distinct accounts; policy
   * rows in OxaPolicyRegistry are keyed by the Owner's address, see
   * OWNER_ADDRESS in .env / docs/deployments.md).
   */
  ownerAddress: string;
  brokerPrivateKey: string;
  viewingKey: string;
  /**
   * May be empty: the real STRK20 proving service URL has NOT been confirmed
   * by the hackathon organizers yet. Until it is provided, any flow that needs
   * proving must fail loudly instead of guessing or faking a URL.
   */
  provingServiceUrl: string;
  /**
   * May be empty: the discovery/indexer service is parked today (its upstream
   * git dependency is unreachable from here), so there is no real URL to put
   * in yet. No route consumes indexerUrl; set it once the service runs locally.
   */
  indexerUrl: string;
  privacyPoolAddress: string;
  policyRegistryAddress: string;
  credentialIssuerAddress: string;
  port: number;
}

const REQUIRED_STRING_VARS = [
  'RPC_URL',
  'BROKER_ACCOUNT_ADDRESS',
  'OWNER_ADDRESS',
  'BROKER_PRIVATE_KEY',
  'VIEWING_KEY',
  'PRIVACY_POOL_ADDRESS',
  'POLICY_REGISTRY_ADDRESS',
  'CREDENTIAL_ISSUER_ADDRESS',
] as const;

// Optional vars — deliberately NOT in REQUIRED_STRING_VARS, each with a reason:
// - PROVING_SERVICE_URL: the real STRK20 proving service URL has NOT been
//   confirmed by the hackathon organizers yet; mint stays blocked meanwhile.
// - INDEXER_URL: the discovery/indexer service build is parked (upstream git
//   dependency unreachable from this machine); no route consumes it yet.
const OPTIONAL_STRING_VARS = ['PROVING_SERVICE_URL', 'INDEXER_URL'] as const;

/**
 * Load and validate broker configuration from the environment.
 * Throws a single clear error listing every missing variable.
 */
export function loadConfig(): BrokerConfig {
  const missing: string[] = [];
  const values: Partial<Record<string, string>> = {};

  for (const name of REQUIRED_STRING_VARS) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      missing.push(name);
    } else {
      values[name] = raw.trim();
    }
  }

  // Optional vars default to '' when unset or empty (see OPTIONAL_STRING_VARS).
  for (const name of OPTIONAL_STRING_VARS) {
    values[name] = process.env[name]?.trim() ?? '';
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
    ownerAddress: values.OWNER_ADDRESS as string,
    brokerPrivateKey: values.BROKER_PRIVATE_KEY as string,
    viewingKey: values.VIEWING_KEY as string,
    provingServiceUrl: values.PROVING_SERVICE_URL ?? '',
    indexerUrl: values.INDEXER_URL ?? '',
    privacyPoolAddress: values.PRIVACY_POOL_ADDRESS as string,
    policyRegistryAddress: values.POLICY_REGISTRY_ADDRESS as string,
    credentialIssuerAddress: values.CREDENTIAL_ISSUER_ADDRESS as string,
    port: port as number,
  };
}
