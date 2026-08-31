// DRY-RUN ONLY COPY of register-broker.mjs targeting MAINNET.
// Contains a hard stop before any broadcast: it computes the proof and then
// REFUSES to send anything. This script can never broadcast a transaction.
import { Account, RpcProvider, constants } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import "dotenv/config";

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  const account = new Account({
    provider,
    address: process.env.BROKER_ACCOUNT_ADDRESS,
    signer: process.env.BROKER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: {
      getViewingKey: async () => BigInt(process.env.VIEWING_KEY),
    },
    provingProvider: {
      url: process.env.PROVING_SERVICE_URL,
      chainId: constants.StarknetChainId.SN_MAIN,
      requestTimeoutMs: 300000,
    },
    discoveryProvider: {
      url: process.env.INDEXER_URL || "",
    },
    poolContractAddress: process.env.PRIVACY_POOL_ADDRESS,
  });

  // Proof facts embed a recent block hash; the blockifier requires
  // proof_block <= current_block - 10 (STORED_BLOCK_HASH_BUFFER), so the proof
  // must be requested against head - 10, not the chain head. Mandated by both
  // the SDK's own testing/devnet.js comment and strk20-by-example.org.
  const headBlock = await provider.getBlockNumber();
  const provingBlockId = headBlock - 10;
  console.log(
    `Step 1/3 — prover computing real STARK proof against block ${provingBlockId} (head ${headBlock} - 10; up to 5 min)...`
  );
  const result = await transfers.build().register().execute({ provingBlockId });

  if (result.warnings && result.warnings.length > 0) {
    console.log("SDK warnings:", JSON.stringify(result.warnings, null, 2));
  }

  // The SDK does NOT broadcast. Verified against
  // @starkware-libs/starknet-privacy-sdk 0.14.3-rc.5 source:
  //   abstract-private-transfers.js execute() -> createProofInvocation() ->
  //   executeWithInvocation() -> buildExecuteResult() returns
  //   { callAndProof: { call, proof: { data, output, proofFacts, additionalData } }, registry, warnings }
  // (proof.data is returned at runtime by proving-service-provider.js prove()
  //  even though the .d.ts omits it). Broadcasting is the caller's job — a
  // SNIP-36 proof-carrying v3 transaction:
  //   - tip is mandatory for v3 in starknet.js 10.7.1 (V3Details requires it)
  //   - proofFacts: "Proof facts to include in the transaction (RPC 0.10.1+)"
  //   - proof: "Proof for the transaction (RPC 0.10.1+) - base64 encoded string"
  // Omit proof keys entirely when there are no proof facts — the official docs
  // warn that passing empty arrays serializes an invalid v3 transaction.
  const { call, proof } = result.callAndProof;
  const proofDetails =
    proof.proofFacts && proof.proofFacts.length > 0
      ? { proofFacts: proof.proofFacts, proof: proof.data }
      : {};
  // ===== READ-ONLY FEE SIMULATION (estimateFee — free, never broadcasts) =====
  // estimateFee is a read-only RPC simulation (starknet_estimateFee) of the
  // apply_actions call. It is what surfaces a contract-level OS-hash rejection
  // without sending anything. The result is logged but NEVER acted upon: the
  // hard stop below fires unconditionally, whatever estimateFee returns.
  try {
    const feeEstimate = await account.estimateInvokeFee(call, { tip: 0n });
    console.log(
      "ESTIMATE FEE (read-only simulation, NOT a broadcast) — SUCCEEDED:",
      JSON.stringify(feeEstimate, (k, v) => (typeof v === "bigint" ? v.toString() : v))
    );
  } catch (err) {
    console.log("ESTIMATE FEE (read-only simulation, NOT a broadcast) — FAILED:");
    console.dir(err, { depth: 4 });
  }

  // ===== HARD STOP — DRY RUN SAFEGUARD =====
  // The proof has been computed and the read-only fee simulation (above) has
  // been attempted. Everything after this throw would broadcast a real mainnet
  // transaction (account.execute -> send). Unreachable BY DESIGN — this script
  // cannot broadcast, even if estimateFee succeeded.
  throw new Error('DRY RUN: refusing to broadcast on mainnet, proof computed successfully, stopping here');

  console.log(
    `Step 2/3 — proof computed (proofFacts: ${proof.proofFacts?.length ?? 0} items, proof attached: ${"proof" in proofDetails}). Broadcasting apply_actions call to the pool:`
  );
  console.dir(call, { depth: null });

  const tx = await account.execute(call, { tip: 0n, ...proofDetails });
  console.log("Transaction hash:", tx.transaction_hash);

  console.log("Step 3/3 — waiting for on-chain confirmation...");
  const receipt = await provider.waitForTransaction(tx.transaction_hash, {
    retryInterval: 3000,
  });
  console.log("Execution status:", receipt.execution_status ?? receipt.status);
  console.log("Finality status:", receipt.finality_status);
  console.log("Actual fee:", JSON.stringify(receipt.actual_fee));

  if ((receipt.execution_status ?? receipt.status) !== "SUCCEEDED") {
    console.error("Transaction did NOT succeed on-chain — full receipt:");
    console.dir(receipt, { depth: null });
    process.exitCode = 1;
    return;
  }

  console.log("MAINNET (DRY RUN): ViewingKeySet registration transaction SUCCEEDED on MAINNET (DRY RUN).");
  console.log("Voyager MAINNET (DRY RUN) (tx):      https://voyager.online/tx/" + tx.transaction_hash);
  console.log(
    "Voyager MAINNET (DRY RUN) (account): https://voyager.online/contract/" +
      process.env.BROKER_ACCOUNT_ADDRESS
  );
}

main().catch((err) => {
  console.error("REGISTRATION FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exit(1);
});
