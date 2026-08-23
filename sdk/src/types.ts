/**
 * Shared OXA types — these mirror the project Blueprint exactly.
 * Do not add fields here without updating the Blueprint.
 */

export interface RequestCredentialParams {
  category: string;
  endpointId: string;
  amount: bigint;
  modeOverride?: 'private' | 'public';
}

export interface Credential {
  credentialSecret: string;
  endpointId: string;
  issuerContract: string;
  token: string;
  amount: bigint;
  expiryTimestamp: number;
  mode: 'private' | 'public';
}

export interface OxaBroker {
  requestCredential(params: RequestCredentialParams): Promise<Credential>;
  reclaimExpired(commitmentHash: string): Promise<{ txHash: string }>;
}

export interface RedeemParams {
  credentialSecret: string;
  endpointId: string;
  payoutAddress: string;
}

export interface RedeemResult {
  txHash: string;
  amount: bigint;
}

export interface OxaEndpointClient {
  redeemCredential(params: RedeemParams): Promise<RedeemResult>;
}
