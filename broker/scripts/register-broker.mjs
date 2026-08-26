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
      chainId: constants.StarknetChainId.SN_SEPOLIA,
      requestTimeoutMs: 300000,
    },
    discoveryProvider: {
      url: process.env.INDEXER_URL || "",
    },
    poolContractAddress: process.env.PRIVACY_POOL_ADDRESS,
  });

  console.log("Submitting real ViewingKeySet registration to Sepolia pool...");
  console.log("This may take several minutes on local hardware — please wait.");

  try {
    const result = await transfers.build().register().execute({});
    console.log("REGISTRATION RESULT (full):");
    console.dir(result, { depth: null });
  } catch (err) {
    console.error("REGISTRATION FAILED — full raw error:");
    console.dir(err, { depth: null });
  }
}

main();
