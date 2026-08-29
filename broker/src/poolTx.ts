/**
 * Shared STRK20 privacy-pool plumbing for Broker-driven pool operations.
 *
 * Brokers the SDK's execute-then-broadcast split exactly as
 * broker/scripts/register-broker.mjs does for registration: the SDK computes
 * the STARK proof and returns { callAndProof } — it NEVER broadcasts (verified
 * in @starkware-libs/starknet-privacy-sdk 0.14.3-rc.5 dist source). This module
 * provides the broadcast + waitForTransaction tail shared by every pool write
 * the Broker initiates.
 */
import { constants, Account, RpcProvider, Contract } from 'starknet';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';
import { ContractDiscoveryProvider, IndexerDiscoveryProvider } from '@starkware-libs/starknet-privacy-sdk/testing';

import { loadConfig } from './config.js';

/**
 * STRK fee token, same on all Starknet networks — grounded from the SDK's own
 * proof-facts module (dist/utils/proof-facts.js STRK_FEE_TOKEN_ADDRESS) and
 * verified on-chain by scripts/preflight.mjs (symbol() == "STRK").
 */
export const STRK_TOKEN =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export interface PoolClient {
  transfers: PrivateTransfersInterface;
  provider: RpcProvider;
  account: Account;
}

/**
 * Create the SDK transfers client bound to the Broker account from config.
 *
 * Uses an async dynamic import because @starkware-libs/starknet-privacy-sdk is
 * ESM-only (`"type": "module"`, no CommonJS entry) while this broker compiles
 * to CommonJS. Node resolves a runtime import() to the ESM build from a CJS
 * caller — the standard interop bridge (types come from a type-only import).
 */
export async function createPoolClient(): Promise<PoolClient> {
  const { createPrivateTransfers } = await import('@starkware-libs/starknet-privacy-sdk');
  const config = loadConfig();
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  const account = new Account({
    provider,
    address: config.brokerAccountAddress,
    signer: config.brokerPrivateKey,
    cairoVersion: '1',
  });
  const discoveryProvider = config.indexerUrl
    ? new IndexerDiscoveryProvider(config.indexerUrl, config.privacyPoolAddress)
    : new ContractDiscoveryProvider(
        new Contract({
          abi: (await provider.getClassAt(config.privacyPoolAddress)).abi,
          address: config.privacyPoolAddress,
          providerOrAccount: provider,
        }) as unknown as ConstructorParameters<typeof ContractDiscoveryProvider>[0],
      );

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: {
      getViewingKey: async () => BigInt(config.viewingKey),
    },
    provingProvider: {
      url: config.provingServiceUrl,
      chainId: constants.StarknetChainId.SN_SEPOLIA,
      requestTimeoutMs: 300000,
    },
    discoveryProvider,
    poolContractAddress: config.privacyPoolAddress,
  });
  return { transfers, provider, account };
}

export interface ProvenBroadcastResult {
  transactionHash: string;
  receipt: unknown;
}

/**
 * Run `executeFn` (which must resolve to an SDK ExecuteResult), then broadcast
 * the resulting proof-carrying v3 transaction and wait for finality. Enforces
 * the documented submission tail: conditional proofFacts/proof keys (never
 * empty arrays), mandatory tip for v3, head-10 proving block (re fetched here
 * so the producer and this broadcast agree).
 */
export async function proveAndBroadcast(
  client: PoolClient,
  executeFn: (provingBlockId: number) => Promise<{ callAndProof: { call: any; proof: any } }>,
): Promise<ProvenBroadcastResult> {
  const headBlock = await client.provider.getBlockNumber();
  const provingBlockId = headBlock - 10;

  const result = await executeFn(provingBlockId);
  const { call, proof } = result.callAndProof;

  const proofDetails =
    proof.proofFacts && proof.proofFacts.length > 0
      ? { proofFacts: proof.proofFacts, proof: proof.data }
      : {};

  const tx = await client.account.execute(call, { tip: 0n, ...proofDetails });
  const receipt = await client.provider.waitForTransaction(tx.transaction_hash, {
    retryInterval: 3000,
  });

  const status = (receipt as { execution_status?: string; status?: string }).execution_status
    ?? (receipt as { status?: string }).status;
  if (status !== 'SUCCEEDED') {
    throw new Error(
      `pool transaction ${tx.transaction_hash} did not succeed on-chain (status ${status}): ${JSON.stringify(receipt)}`,
    );
  }

  return { transactionHash: tx.transaction_hash, receipt };
}