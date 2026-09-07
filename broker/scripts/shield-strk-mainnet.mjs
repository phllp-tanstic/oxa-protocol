// Mainnet twin of scripts/shield-strk.mjs — shields STRK on mainnet.
//
// Purpose: give the deployer a SELF-CHANNEL with a real subchannel, so that
// surplus change-notes (CreateEncNote) work — which is the prerequisite for
// partial-amount mints (anything with surplus > 0). The 0.960804 STRK mint
// currently works because it has zero surplus; a proper self-channel unlocks
// partial mints and is good pool hygiene regardless.
//
// Cost model (matches the exact ratio of Ready Wallet's proven mainnet shield):
//   SHIELD_AMOUNT = 7 STRK gross → net ~1 STRK after the pool's fee. The 6 STRK
//   difference is the pool action fee (get_fee_amount() = 6 STRK on mainnet).
//   Deployer transparent STRK balance: ~27.64 STRK — sufficient.
//
// Run:
//   cd broker
//   node --loader ts-node/esm scripts/shield-strk-mainnet.mjs
//
// Required env vars (mainnet values):
//   STARKNET_CHAIN_ID=SN_MAIN
//   RPC_URL=https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/alch_...
//   BROKER_ACCOUNT_ADDRESS=0x0773d67893746d6a5a318429380d566cf01b19358ea9641ef6a1563f833ccc0e
//   BROKER_PRIVATE_KEY=<deployer key — starkli profile alpha-mainnet/oxa-mainnet-test>
//   VIEWING_KEY=<deployer viewing key>
//   PRIVACY_POOL_ADDRESS=0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
//   PROVING_SERVICE_URL=http://35.255.82.183:3010
import { Account, RpcProvider, Contract, constants, Signer } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
console.log("CHECKPOINT: imports done");

// ===== mainnet interlock =====
const MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const DEPLOYER = "0x0773d67893746d6a5a318429380d566cf01b19358ea9641ef6a1563f833ccc0e";
const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const SHIELD_AMOUNT = 7000000000000000000n;

function requireEnv(name, expected) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    console.error(`MISSING ENV: ${name}`);
    process.exit(1);
  }
  if (expected !== undefined && v.trim().toLowerCase() !== expected.toLowerCase()) {
    console.error(`ENV MISMATCH — stopping: ${name}=${v} but this mainnet runner requires ${expected}.`);
    process.exit(1);
  }
  return v.trim();
}

requireEnv("STARKNET_CHAIN_ID", "SN_MAIN");
requireEnv("RPC_URL");
const ALLOWED_MAINNET_ENDPOINTS = [
  "starknet-mainnet.g.alchemy.com",
  "mainnet.nodes.starknet.org",
];
if (!ALLOWED_MAINNET_ENDPOINTS.some((e) => process.env.RPC_URL.includes(e))) {
  console.error(`ENV MISMATCH — stopping: RPC_URL not a recognized mainnet endpoint.`);
  process.exit(1);
}
requireEnv("BROKER_ACCOUNT_ADDRESS", DEPLOYER);
requireEnv("BROKER_PRIVATE_KEY");
requireEnv("VIEWING_KEY");
requireEnv("PRIVACY_POOL_ADDRESS", MAINNET_POOL);
requireEnv("PROVING_SERVICE_URL");
if (process.env.PROVING_SERVICE_URL.trim() !== "http://35.255.82.183:3010") {
  console.warn("WARNING: PROVING_SERVICE_URL differs from tonight's http://35.255.82.183:3010.");
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  console.log("CHECKPOINT: provider created");

  // Pass private key directly as string — same pattern as working Sepolia shield-strk.mjs.
  const account = new Account({
    provider,
    address: process.env.BROKER_ACCOUNT_ADDRESS,
    signer: process.env.BROKER_PRIVATE_KEY,
    cairoVersion: "1",
  });
  console.log("CHECKPOINT: account created");

  const { abi: poolAbi } = await provider.getClassAt(process.env.PRIVACY_POOL_ADDRESS);
  console.log("CHECKPOINT: getClassAt done");
  const poolContract = new Contract({ abi: poolAbi, address: process.env.PRIVACY_POOL_ADDRESS, providerOrAccount: provider });
  const discoveryProvider = new ContractDiscoveryProvider(poolContract);

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => BigInt(process.env.VIEWING_KEY) },
    provingProvider: {
      url: process.env.PROVING_SERVICE_URL,
      chainId: constants.StarknetChainId.SN_MAIN,
      requestTimeoutMs: 300000,
    },
    discoveryProvider,
    poolContractAddress: process.env.PRIVACY_POOL_ADDRESS,
  });
  console.log("CHECKPOINT: createPrivateTransfers done");

  const self = process.env.BROKER_ACCOUNT_ADDRESS;

  const headBlock = await provider.getBlockNumber();
  const provingBlockId = headBlock - 10;
  console.log(`Step 1/3 — prover computing real STARK proof for Shield (${SHIELD_AMOUNT} raw units STRK) against block ${provingBlockId} (head ${headBlock} - 10; up to 5 min)...`);

  console.log("CHECKPOINT: about to call execute()");
  const result = await transfers
    .build({ provingBlockId, autoSetup: true })
    .with(STRK_TOKEN, (t) => t.deposit({ amount: SHIELD_AMOUNT }))
    .surplusTo(self)
    .execute({ provingBlockId });

  if (result.warnings && result.warnings.length > 0) {
    console.log("SDK warnings:", JSON.stringify(result.warnings, null, 2));
  }

  const { call, proof } = result.callAndProof;
  const proofDetails = proof.proofFacts && proof.proofFacts.length > 0 ? { proofFacts: proof.proofFacts, proof: proof.data } : {};
  console.log(`Step 2/3 — proof computed (proofFacts: ${proof.proofFacts?.length ?? 0} items, proof attached: ${"proof" in proofDetails}). Broadcasting apply_actions call to the pool:`);
  console.dir(call, { depth: null });

  const tx = await account.execute(call, { tip: 0n, ...proofDetails });
  console.log("Transaction hash:", tx.transaction_hash);

  console.log("Step 3/3 — waiting for on-chain confirmation...");
  const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 3000 });
  console.log("Execution status:", receipt.execution_status ?? receipt.status);
  console.log("Finality status:", receipt.finality_status);
  console.log("Actual fee:", JSON.stringify(receipt.actual_fee));

  if ((receipt.execution_status ?? receipt.status) !== "SUCCEEDED") {
    console.error("Transaction did NOT succeed on-chain — full receipt:");
    console.dir(receipt, { depth: null });
    process.exitCode = 1;
    return;
  }

  console.log(`CONFIRMED: Shield of ${SHIELD_AMOUNT} raw units STRK SUCCEEDED on MAINNET.`);
}

main().catch((err) => {
  console.error("SHIELD FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exit(1);
});
