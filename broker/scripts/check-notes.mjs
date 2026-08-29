import { Account, RpcProvider, Contract, constants } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import "dotenv/config";

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  const account = new Account({
    provider,
    address: process.env.BROKER_ACCOUNT_ADDRESS,
    signer: process.env.BROKER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const { abi: poolAbi } = await provider.getClassAt(process.env.PRIVACY_POOL_ADDRESS);
  const poolContract = new Contract({
    abi: poolAbi,
    address: process.env.PRIVACY_POOL_ADDRESS,
    providerOrAccount: provider,
  });
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

  console.log("Discovering notes for the Broker account...");
  const { notes, timestamp } = await transfers.discoverNotes();

  console.log("Discovery timestamp:", timestamp);
  console.log("Tokens with notes found:", notes.size);

  for (const [token, tokenNotes] of notes.entries()) {
    const total = tokenNotes.reduce((sum, n) => sum + n.amount, 0n);
    console.log(`Token ${token}: ${tokenNotes.length} note(s), total amount (raw): ${total}`);
  }

  if (notes.size === 0) {
    console.log("No notes found yet. This can mean: the private transfer hasn't finalized/matured enough blocks, or discovery needs the exact block range. Try again in a minute.");
  }
}

main().catch((err) => {
  console.error("DISCOVERY FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exit(1);
});
