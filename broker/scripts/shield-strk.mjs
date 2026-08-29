import { Account, RpcProvider, Contract, constants } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import "dotenv/config";

// Amount to shield, in raw STRK units (18 decimals). 20 STRK chosen as a
// modest test amount: current Broker balance is ~94.99 STRK, and this
// leaves plenty of headroom for gas + a follow-up Mint test.
const SHIELD_AMOUNT = 20n * 10n ** 18n;

const STRK_TOKEN =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  const account = new Account({
    provider,
    address: process.env.BROKER_ACCOUNT_ADDRESS,
    signer: process.env.BROKER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  // No indexer deployed (INDEXER_URL is empty) — use ContractDiscoveryProvider
  // instead, which queries the pool contract directly via RPC. Per the SDK
  // README this is "best for development and testing" and needs no separate
  // indexer service. Fetch the ABI live rather than hardcoding it.
  const { abi: poolAbi } = await provider.getClassAt(process.env.PRIVACY_POOL_ADDRESS);
  const poolContract = new Contract({ abi: poolAbi, address: process.env.PRIVACY_POOL_ADDRESS, providerOrAccount: provider });
  const discoveryProvider = new ContractDiscoveryProvider(poolContract);

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: {
      getViewingKey: async () => BigInt(process.env.VIEWING_KEY),
    },
    provingProvider: {
      url: process.env.PROVING_SERVICE_URL,
      chainId: constants.StarknetChainId.SN_SEPOLIA,
      requestTimeoutMs: 300000,
    },
    discoveryProvider,
    poolContractAddress: process.env.PRIVACY_POOL_ADDRESS,
  });

  const self = process.env.BROKER_ACCOUNT_ADDRESS;

  const headBlock = await provider.getBlockNumber();
  const provingBlockId = headBlock - 10;
  console.log(
    `Step 1/3 — prover computing real STARK proof for Shield (${SHIELD_AMOUNT} raw units STRK) against block ${provingBlockId} (head ${headBlock} - 10; up to 5 min)...`
  );

  const result = await transfers
    .build({ provingBlockId, autoSetup: true })
    .with(STRK_TOKEN, (t) => t.deposit({ amount: SHIELD_AMOUNT }))
    .surplusTo(self)
    .execute({ provingBlockId });

  if (result.warnings && result.warnings.length > 0) {
    console.log("SDK warnings:", JSON.stringify(result.warnings, null, 2));
  }

  const { call, proof } = result.callAndProof;
  const proofDetails =
    proof.proofFacts && proof.proofFacts.length > 0
      ? { proofFacts: proof.proofFacts, proof: proof.data }
      : {};
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

  console.log(`CONFIRMED: Shield of ${SHIELD_AMOUNT} raw units STRK SUCCEEDED on Sepolia.`);
  console.log("Voyager (tx): https://sepolia.voyager.online/tx/" + tx.transaction_hash);
}

main().catch((err) => {
  console.error("SHIELD FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exit(1);
});
