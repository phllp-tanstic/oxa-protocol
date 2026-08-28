// Read-only preflight for broker registration. Prints NO secret values.
// Confirms: env vars present, live nonce (baseline), account class (Cairo0/1),
// STRK balance (v3 fees are paid in STRK), prover reachability.
import { RpcProvider } from "starknet";
import "dotenv/config";

// STRK fee token — grounded from the SDK's own proof-facts module
// (node_modules/@starkware-libs/starknet-privacy-sdk/dist/utils/proof-facts.js:
//  STRK_FEE_TOKEN_ADDRESS, "same on all Starknet networks"), and verified
// on-chain below via symbol() == "STRK" before its balance is trusted.
const STRK_TOKEN =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

function feltToAscii(felt) {
  let v = BigInt(felt);
  let s = "";
  while (v > 0n) {
    s = String.fromCharCode(Number(v & 0xffn)) + s;
    v >>= 8n;
  }
  return s;
}

function checkEnv(name) {
  const v = process.env[name];
  console.log(`${name}: ${v && v.length > 0 ? "set (value hidden)" : "MISSING"}`);
  return v;
}

async function main() {
  const needed = [
    "RPC_URL",
    "BROKER_ACCOUNT_ADDRESS",
    "BROKER_PRIVATE_KEY",
    "VIEWING_KEY",
    "PROVING_SERVICE_URL",
    "PRIVACY_POOL_ADDRESS",
  ];
  for (const n of needed) checkEnv(n);

  const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });
  const addr = process.env.BROKER_ACCOUNT_ADDRESS;

  const nonce = await provider.getNonceForAddress(addr);
  console.log("broker account nonce:", nonce);

  const classHash = await provider.getClassHashAt(addr);
  const cls = await provider.getClassAt(addr);
  console.log("account classHash:", classHash);
  console.log("account is Sierra (Cairo1):", !!cls.sierra_program);

  const sym = await provider.callContract({
    contractAddress: STRK_TOKEN,
    entrypoint: "symbol",
    calldata: [],
  });
  // Cairo1 ByteArray felts arrive as [data..., pending_word, pending_len] style
  // arrays — e.g. symbol -> ["0x0","0x5354524b","0x4"] for "STRK". Decode every
  // element's hex payload and keep the non-empty parts.
  const decoded = sym
    .map((x) =>
      BigInt(x)
        .toString(16)
        .match(/../g)
        ?.map((b) => String.fromCharCode(parseInt(b, 16)))
        .join("") ?? ""
    )
    .filter((s) => s.length > 0)
    .join("");
  const symbol = decoded;
  console.log("symbol() at STRK fee-token address:", JSON.stringify(symbol));
  if (symbol !== "STRK") {
    throw new Error(
      `Address ${STRK_TOKEN} did not resolve to STRK on this chain — refusing to trust any balance read from it.`
    );
  }

  const bal = await provider.callContract({
    contractAddress: STRK_TOKEN,
    entrypoint: "balance_of",
    calldata: [addr],
  });
  const wei = BigInt(bal[0]) + (BigInt(bal[1]) << 128n);
  console.log(
    "broker STRK balance:",
    wei.toString(),
    "wei =",
    (Number(wei) / 1e18).toFixed(6),
    "STRK"
  );

  const base = process.env.PROVING_SERVICE_URL;
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(8000) });
    console.log(`prover base URL reachable: HTTP ${r.status} (any HTTP response = connectivity OK)`);
  } catch (e) {
    console.log(`prover base URL UNREACHABLE: ${e && e.cause ? e.cause.code || String(e.cause) : String(e)}`);
    console.log("Per HANDOVER §2: fix firewall rule FIRST before assuming the prover is broken:");
    console.log("  gcloud compute firewall-rules update allow-prover-dev-access --source-ranges=$(curl -s https://ifconfig.me)/32");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PREFLIGHT FAILED:", e);
    process.exit(1);
  });
