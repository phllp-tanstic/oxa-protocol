/**
 * Mint — locks a credential amount behind a commitment via the STRK20 pool,
 * exactly the action POST /request-credential performs once policy passes.
 *
 * Flow (Blueprint §2.5, §2.10; ground truth from
 * @starkware-libs/starknet-privacy-sdk 0.14.3-rc.5):
 *   1. Broker spends its own shielded STRK note (auto-selected) and withdraws
 *      `amount` to OxaCredentialIssuer — the "plain, visible ERC-20 transfer"
 *      the pool makes to the anonymizer (Blueprint §2.2).
 *   2. An InvokeExternal action calls OxaCredentialIssuer.privacy_invoke(Mint,
 *      ...), which stores the CredentialEntry (commitment, token, amount,
 *      endpoint, expiry, reclaim_commitment) and asserts the pool is the caller.
 *   3. SDK computes the STARK proof; this module broadcasts the proof-carrying
 *      v3 transaction and waits for on-chain success (see poolTx.ts).
 *   4. Only after success are the custodial secrets written to broker/.data/
 *      and the claim payload returned.
 *
 * Requires the Broker to already hold a shielded STRK note (registered in the
 * pool, funded by the owner's private transfer) and a running indexer when
 * auto-discovery is enabled. Fails loudly and honestly otherwise.
 */
import { randomBytes } from 'node:crypto';

import type { Credential } from '@oxa/sdk';

import { computeCredentialCommitment, computeReclaimCommitment, feltFromParam } from './commitmentHash.js';
import { saveCredential } from './credentialStore.js';
import { loadConfig } from './config.js';
import { createPoolClient, proveAndBroadcast, STRK_TOKEN } from './poolTx.js';

export interface MintParams {
  category: string;
  endpointId: string;
  /** Raw token units (u128), consistent with the policy cap and claim payload. */
  amount: bigint;
  /** On-chain CategoryPolicy.max_ttl_seconds — the credential expiry window. */
  maxTtlSeconds: bigint;
  /** Policy-owning account (Decision 0001: distinct from the Broker). */
  ownerAddress: string;
}

export async function mintCredential(params: MintParams): Promise<Credential> {
  const config = loadConfig();

  const credentialSecret = `0x${randomBytes(16).toString('hex')}`;
  const reclaimSecret = `0x${randomBytes(16).toString('hex')}`;
  const commitmentHash = computeCredentialCommitment(credentialSecret, params.endpointId);
  const reclaimCommitment = computeReclaimCommitment(reclaimSecret);
  const endpointIdFelt = feltFromParam(params.endpointId);
  const categoryFelt = feltFromParam(params.category);
  const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000)) + params.maxTtlSeconds;

  const client = await createPoolClient();

  // Start from an empty registry: note discovery requires a running indexer
  // (INDEXER_URL). If one is configured, auto-discovery populates the registry;
  // otherwise the execute below fails with a precise "no notes" error.
  const builder = client.transfers.build({
    autoRegister: false,
    autoSetup: true,
    autoDiscover: { notes: 'all', channels: 'missing' },
    autoSelectNotes: 'naive',
    provingBlockId: await client.provider.getBlockNumber() - 10,
  });

  builder.with(STRK_TOKEN, (t) => {
    t.withdraw({
      recipient: config.credentialIssuerAddress,
      amount: params.amount,
    });
  });

  builder.surplusTo(config.brokerAccountAddress, false);

  builder.invoke(() => ({
    contractAddress: config.credentialIssuerAddress,
    entrypoint: 'privacy_invoke',
    calldata: [
      '0x0', // OxaOperation::Mint
      commitmentHash,
      STRK_TOKEN,
      `0x${params.amount.toString(16)}`, // u128
      endpointIdFelt,
      `0x${expiryTimestamp.toString(16)}`, // u64
      reclaimCommitment,
      '0x0', // reclaim_secret — unused in Mint
      '0x0', // note_id — unused in Mint
      params.ownerAddress,
      categoryFelt,
    ],
  }));

  const { transactionHash, receipt } = await proveAndBroadcast(
    client,
    (provingBlockId) => builder.execute({ provingBlockId }),
  );

  // Persist custody metadata only after on-chain confirmation.
  saveCredential({
    commitmentHash,
    credentialSecret,
    reclaimSecret,
    endpointId: params.endpointId,
    amount: params.amount.toString(),
    expiryTimestamp: Number(expiryTimestamp),
    createdAt: Math.floor(Date.now() / 1000),
    used: false,
  });

  console.log(
    `Mint confirmed: tx ${transactionHash} commitment ${commitmentHash} expiry ${expiryTimestamp} ` +
    `(status ${(receipt as { execution_status?: string }).execution_status})`,
  );

  return {
    credentialSecret,
    endpointId: params.endpointId,
    issuerContract: config.credentialIssuerAddress,
    token: STRK_TOKEN,
    amount: params.amount,
    expiryTimestamp: Number(expiryTimestamp),
    mode: 'private',
  };
}