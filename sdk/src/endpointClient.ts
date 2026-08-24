import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Account, Contract, RpcProvider } from 'starknet';
import type { OxaEndpointClient, RedeemParams, RedeemResult } from './types';

/**
 * Real ABI, copied from contracts/target/dev/
 * oxa_credential_issuer_OxaCredentialIssuer.contract_class.json (full Sierra
 * class JSON; its `abi` array is extracted below). Loaded via fs rather than a
 * JSON import to keep the Sierra program out of tsc's inference — same pattern
 * as broker/src/policyCheck.ts.
 *
 * Two candidate paths because __dirname differs between ts-node runs (sdk/src)
 * and compiled output (sdk/dist): tsc does not copy .json files to outDir, so
 * after a build we fall back to the source-tree copy.
 */
function loadIssuerAbi(): unknown[] {
  const candidates = [
    join(__dirname, 'abi', 'OxaCredentialIssuer.json'),
    join(__dirname, '..', 'src', 'abi', 'OxaCredentialIssuer.json'),
  ];
  let lastError: unknown;
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { abi?: unknown[] };
      return Array.isArray(parsed) ? parsed : (parsed.abi as unknown[]);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not load OxaCredentialIssuer ABI (looked in ${candidates.join(', ')}): ${String(lastError)}`,
  );
}

const ISSUER_ABI: unknown[] = loadIssuerAbi();

export interface StarknetEndpointClientOptions {
  rpcUrl: string;
  issuerContract: string;
  accountAddress: string;
  privateKey: string;
}

/**
 * Endpoint-side client: redeems an OXA credential on-chain by calling the
 * Credential Issuer contract's `redeem` entrypoint.
 */
export class StarknetEndpointClient implements OxaEndpointClient {
  private readonly options: StarknetEndpointClientOptions;

  constructor(options: StarknetEndpointClientOptions) {
    this.options = options;
  }

  async redeemCredential(params: RedeemParams): Promise<RedeemResult> {
    const provider = new RpcProvider({ nodeUrl: this.options.rpcUrl });
    const account = new Account({
      provider,
      address: this.options.accountAddress,
      signer: this.options.privateKey,
    });
    const contract = new Contract({
      abi: ISSUER_ABI,
      address: this.options.issuerContract,
      providerOrAccount: account,
    });

    // Real signed invoke (not a read call): redeem marks the credential used
    // on-chain and transfers tokens to the payout address.
    const result = await contract.redeem(
      params.credentialSecret,
      params.endpointId,
      params.payoutAddress,
    );

    const txHash: string = result.transaction_hash;

    // Best-effort: pull the redeemed amount off the CredentialRedeemed event in
    // the receipt. Event has no keys; data layout is [commitment_hash, token,
    // amount(u128), payout_address, timestamp].
    let amount = BigInt(0);
    try {
      const receipt = (await provider.waitForTransaction(txHash)) as {
        events?: Array<{ data?: string[] }>;
      };
      for (const ev of receipt.events ?? []) {
        if ((ev.data?.length ?? 0) >= 5 && ev.data !== undefined) {
          amount = BigInt(ev.data[2]);
          break;
        }
      }
    } catch {
      // Receipt not confirmable yet — tx hash is authoritative; amount stays 0n.
    }

    return { txHash, amount };
  }
}
