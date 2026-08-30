/**
 * Reclaim — returns an expired credential's locked amount to the Broker's
 * shielded balance, exactly the action POST /reclaim-expired performs.
 *
 * Flow (Blueprint §2.11; ground truth from lib.cairo:189-205 and
 * @starkware-libs/starknet-privacy-sdk 0.14.3-rc.5 dist/interfaces.d.ts):
 *   1. The Broker declares an OPEN note for itself:
 *      `.with(STRK_TOKEN).transfer({ recipient: self, amount: Open })` —
 *      the documented pattern for funds whose amount is only known after the
 *      external contract runs (README "Anonymous swap (Ekubo)" / Vesu).
 *   2. An InvokeExternal action calls OxaCredentialIssuer.privacy_invoke(
 *      OxaOperation::Reclaim, commitmentHash, ..., reclaimSecret, noteId, ...).
 *      The issuer asserts the credential exists, is unused, is past expiry,
 *      and that poseidon_hash_span([OXA_RECLAIM_TAG, reclaim_secret]) matches
 *      the stored reclaim_commitment, marks it used, and returns
 *      OpenNoteDeposit { note_id, token, amount } (lib.cairo:202-204).
 *   3. The pool settles the open note from that return value; the SDK's
 *      `invoke` callback receives the SDK-assigned noteId via
 *      args.openNotes[0].noteId (interfaces.d.ts:175-190).
 *   4. SDK computes the STARK proof; poolTx.proveAndBroadcast submits the
 *      proof-carrying v3 transaction and waits for on-chain success.
 *   5. Only after success is the local store marked used:true (same
 *      credentials.json file mint.ts writes, via credentialStore.markUsed).
 *
 * Requires the credential's TTL to have elapsed on-chain
 * (lib.cairo:193 asserts get_block_timestamp() > expiry_timestamp — NOT_YET_EXPIRED
 * otherwise) and the reclaim secret to be in local custody (Decision 0001).
 */
import { loadConfig } from './config.js';
import { getCredential, markUsed } from './credentialStore.js';
import { createPoolClient, proveAndBroadcast, STRK_TOKEN } from './poolTx.js';

export async function reclaimExpiredCredential(
  commitmentHash: string,
): Promise<{ txHash: string }> {
  const config = loadConfig();

  // The reclaim secret only exists in local custody (credentialStore.ts — the
  // same store mint.ts writes after on-chain confirmation). No local entry →
  // fail loudly before any proving cost is incurred.
  const credential = getCredential(commitmentHash);
  if (credential === undefined) {
    throw new Error(`no local credential with commitment ${commitmentHash}`);
  }
  if (credential.used) {
    throw new Error(
      `credential ${commitmentHash} already marked used in the local store`,
    );
  }
  const reclaimSecret = credential.reclaimSecret;

  // `Open` — SDK sentinel for an open note (interfaces.d.ts:11-13, re-exported
  // from the package root). Dynamic import per poolTx.ts: the SDK is ESM-only.
  // NOTE: accessed as `sdk.Open` (not destructured) — destructuring a
  // `unique symbol` widens its type to `symbol` and fails assignability
  // against `Amount = bigint | unique symbol`.
  const sdk = await import('@starkware-libs/starknet-privacy-sdk');

  const client = await createPoolClient();

  const builder = client.transfers.build({
    autoRegister: false,
    autoSetup: true,
    autoDiscover: { notes: 'all', channels: 'missing' },
    autoSelectNotes: 'naive',
    provingBlockId: await client.provider.getBlockNumber() - 10,
  });

  // Open note owned by the Broker: amount is filled by the issuer's
  // OpenNoteDeposit return when the pool settles it (no withdraw of a known
  // amount is possible — the reclaimed amount comes from the issuer's stored
  // CredentialEntry, not from a Broker note; the Broker spends nothing here).
  builder.with(STRK_TOKEN, (t) => {
    t.transfer({ recipient: config.brokerAccountAddress, amount: sdk.Open });
  });

  builder.invoke((args) => ({
    contractAddress: config.credentialIssuerAddress,
    entrypoint: 'privacy_invoke',
    calldata: [
      '0x1', // OxaOperation::Reclaim — variant index 1 (lib.cairo:40-43; Mint is '0x0')
      commitmentHash,
      '0x0', // token — unused by Reclaim (issuer reads entry.token)
      '0x0', // amount — unused by Reclaim (issuer reads entry.amount)
      '0x0', // endpoint_id — unused
      '0x0', // expiry_timestamp — unused (issuer reads entry.expiry_timestamp)
      '0x0', // reclaim_commitment — unused (issuer compares against its stored value)
      reclaimSecret, // poseidon-validated against entry.reclaim_commitment (lib.cairo:195-196)
      args.openNotes[0].noteId, // note the returned OpenNoteDeposit fills
      '0x0', // owner — unused
      '0x0', // category — unused
    ],
  }));

  const { transactionHash } = await proveAndBroadcast(
    client,
    (provingBlockId) => builder.execute({ provingBlockId }),
  );

  // Mark custodial metadata used only after on-chain confirmation — same
  // store file and post-success ordering as mint.ts's saveCredential.
  markUsed(commitmentHash);

  console.log(
    `Reclaim confirmed: tx ${transactionHash} commitment ${commitmentHash} ` +
      `amount ${credential.amount} raw units returned to the Broker's shielded balance`,
  );

  return { txHash: transactionHash };
}
