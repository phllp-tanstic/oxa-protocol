import { Account, RpcProvider, Contract, cairo } from "starknet";
import "dotenv/config";

const STRK_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  const account = new Account({
    provider,
    address: process.env.BROKER_ACCOUNT_ADDRESS,
    signer: process.env.BROKER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const spender = process.env.PRIVACY_POOL_ADDRESS;
  // Approve a large-but-bounded amount rather than max-uint256, since this is
  // testnet and we don't need unlimited exposure. Adjust AMOUNT_STRK below if
  // register()/deposit() needs more.
  const AMOUNT_STRK = 50n * 10n ** 18n; // 50 STRK, 18 decimals

  const { low, high } = cairo.uint256(AMOUNT_STRK);

  console.log(`Approving spender ${spender} for ${AMOUNT_STRK} (raw units) STRK...`);

  const call = {
    contractAddress: STRK_TOKEN_ADDRESS,
    entrypoint: "approve",
    calldata: [spender, low, high],
  };

  const tx = await account.execute(call);
  console.log("Approve tx hash:", tx.transaction_hash);

  console.log("Waiting for confirmation...");
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  console.log("Execution status:", receipt.execution_status ?? receipt.status);
  console.log("Finality status:", receipt.finality_status);

  if ((receipt.execution_status ?? receipt.status) !== "SUCCEEDED") {
    console.error("Approve did NOT succeed — full receipt:");
    console.dir(receipt, { depth: null });
    process.exitCode = 1;
    return;
  }

  console.log("CONFIRMED: approve() succeeded.");
  console.log(
    "Voyager (tx): https://sepolia.voyager.online/tx/" + tx.transaction_hash
  );
}

main().catch((err) => {
  console.error("APPROVE FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exit(1);
});
