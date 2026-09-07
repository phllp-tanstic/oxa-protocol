// STATUS: BLOCKED — not a signature bug. Root cause found 2026-09-07 via
// unsigned compile_actions view calls (read-only, no signature, no broadcast):
//
//   The deployer has NO self-channel on the mainnet pool. The one channel they
//   have is an INCOMING channel (sender ≠ deployer). The compiler emits a
//   CreateEncNote action whenever there's surplus (balance > 0n, compiler.ts:738),
//   and CreateEncNote requires a subchannel on a SELF-channel — which doesn't
//   exist. The pool reverts with SUBCHANNEL_NOT_FOUND before any signature check.
//
//   Confirmed: compile_actions view SUCCEEDS with zero surplus (full-note withdraw,
//   no CreateEncNote) and FAILS with any surplus > 0 (CreateEncNote → SUBCHANNEL_NOT_FOUND).
//
// WORKAROUND: mint the FULL note value (960804000000000000n = 0.960804 STRK).
// This produces zero surplus, so no CreateEncNote is emitted, and the pool
// accepts the bundle. per_request_cap for 'inference' is 1 STRK — 0.960804 fits.
//
// To mint partial amounts later, the deployer must first open a self-channel
// and register a STRK subchannel on it. Until then, this script is full-note-only.
// Mainnet twin of scripts/run-mint.mjs — one-off runner: mintCredential() from
// src/mint.ts, executed directly with the same loader mechanism the dev script
// uses ("dev": "node --loader ts-node/esm src/server.ts") — no build step:
//   cd broker
//   node --loader ts-node/esm scripts/mint-mainnet.mjs
//
// All config beyond the params below is passed as RUNTIME ENV VARS (the same
// pattern as register-broker-mainnet.mjs / check-notes-mainnet.mjs). broker/.env
// is deliberately NOT touched — it is the proven Sepolia setup.
//
// Required env vars (mainnet values used tonight):
//   STARKNET_CHAIN_ID=SN_MAIN
//       → proving-provider chain in src/poolTx.ts createPoolClient(); requires
//         the chainId-parameterization diff (config.chainId, default SN_SEPOLIA).
//   RPC_URL=https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/alch_...
//   BROKER_ACCOUNT_ADDRESS=0x0773d67893746d6a5a318429380d566cf01b19358ea9641ef6a1563f833ccc0e
//   BROKER_PRIVATE_KEY=<deployer key — starkli profile alpha-mainnet/oxa-mainnet-test>
//   VIEWING_KEY=<deployer viewing key>
//   PRIVACY_POOL_ADDRESS=0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
//   CREDENTIAL_ISSUER_ADDRESS=0x04cffa828f59b34c98a124b05ef7874b206249635eaf4512417efee6fcf44c22
//   PROVING_SERVICE_URL=http://35.255.82.183:3010
//   INDEXER_URL= (optional — empty ⇒ ContractDiscoveryProvider over the pool,
//     same discovery path as every mainnet run tonight)
//
// Mainnet state this relies on (verified live on-chain via fresh reads):
//   get_category_policy(deployer, 'inference') = {per_request_cap: 1 STRK,
//     period_cap: 5 STRK, period_seconds: 3600, max_ttl_seconds: 3600,
//     mode_locked: false, locked_mode: false} — PRE-EXISTING production
//     policy, configured before tonight; the fresh read is non-zero, so NO
//     registry writes are needed (or were performed) for this run.
//   is_endpoint_allowed(deployer, 'inference', 'weather_relay') = true (fresh read).
//   get_authorized_issuer(deployer) = 0x04cffa828f59b34c98a124b05ef7874b206249635eaf4512417efee6fcf44c22
//   Deployer shielded balance: exactly ONE note of 0.960804 STRK (raw 960804000000000000)
//
// ⚠ PRECONDITION: the prover at http://35.255.82.183:3010 must be reachable —
// as of the writing of this file /health and / both returned HTTP 000 (timeout)
// from this machine, most likely the stale GCP firewall rule
// `allow-prover-dev-access` (see docs/HANDOVER.md §2). Mint cannot run until
// that is fixed; refresh the rule with:
//   gcloud compute firewall-rules update allow-prover-dev-access \
//     --source-ranges=$(curl -s https://ifconfig.me)/32
// (also confirm the rule allows the port the prover actually listens on —
// tonight's runs used 3010, the rule documented in HANDOVER.md says 3000).
import { mintCredential } from "../src/mint.js";

// ===== mainnet interlock — refuse to run against any non-mainnet config =====
const MAINNET_ISSUER = "0x04cffa828f59b34c98a124b05ef7874b206249635eaf4512417efee6fcf44c22";
const MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const DEPLOYER = "0x0773d67893746d6a5a318429380d566cf01b19358ea9641ef6a1563f833ccc0e";

function requireEnv(name, expected) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    console.error(
      `MISSING ENV: ${name} — mainnet config is passed at runtime, never via broker/.env. See the env list in this file's header.`
    );
    process.exit(1);
  }
  if (expected !== undefined && v.trim().toLowerCase() !== expected.toLowerCase()) {
    console.error(
      `ENV MISMATCH — stopping: ${name}=${v} but this mainnet runner requires ${expected}.`
    );
    process.exit(1);
  }
  return v.trim();
}

requireEnv("STARKNET_CHAIN_ID", "SN_MAIN"); // poolTx.ts proving provider chain
requireEnv("RPC_URL");
if (!process.env.RPC_URL.includes("starknet-mainnet")) {
  console.error("ENV MISMATCH — stopping: RPC_URL does not look like a mainnet endpoint.");
  process.exit(1);
}
requireEnv("BROKER_ACCOUNT_ADDRESS", DEPLOYER); // pool-registered account AND policy owner
requireEnv("BROKER_PRIVATE_KEY");
requireEnv("VIEWING_KEY");
requireEnv("PRIVACY_POOL_ADDRESS", MAINNET_POOL);
requireEnv("CREDENTIAL_ISSUER_ADDRESS", MAINNET_ISSUER);
requireEnv("PROVING_SERVICE_URL");
if (process.env.PROVING_SERVICE_URL.trim() !== "http://35.255.82.183:3010") {
  console.warn(
    "WARNING: PROVING_SERVICE_URL differs from tonight's http://35.255.82.183:3010 — continuing, but verify this is intentional."
  );
}
// AMOUNT — FULL note value: 0.960804 STRK, raw u128.
//
// FULL-NOTE-ONLY CONSTRAINT (see STATUS header): the deployer has no self-channel,
// so any surplus > 0 triggers CreateEncNote → SUBCHANNEL_NOT_FOUND. Minting the
// full note value produces zero surplus, bypassing the issue. To mint partial
// amounts later, open a self-channel + STRK subchannel first.
//
// Cost model (measured, not guessed — proven Sepolia mint tx 0x4d41aaa4... plus
// tonight's mainnet shield receipt and live pool getters):
//   - The shielded note funds `amount` 1:1: gross note spend equals the minted
//     amount exactly, with NO note-side overhead (the Sepolia mint's pool paid
//     out exactly 100 raw — the minted amount — and nothing else).
//   - The real cost is paid from the actor's TRANSPARENT STRK balance:
//     ~8.7 STRK per mint = 6 STRK pool action fee (live mainnet
//     get_fee_amount(), pulled to fee collector 0xd7904163...) + ~2.7 STRK
//     proof-carrying v3 gas (measured shield actual_fee: 2.6705 STRK).
//   - Deployer transparent balance: 27.64 STRK — comfortably sufficient.
//     Re-read get_fee_amount() right before running: the protocol can change
//     it via set_fee_amount.
const AMOUNT = 960804000000000000n; // FULL note value — 0.960804 STRK, raw u128.
// Using the full note avoids CreateEncNote (surplus routing), which requires a
// self-channel the deployer doesn't have (confirmed via unsigned compile_actions
// view: SUBCHANNEL_NOT_FOUND with any surplus > 0; SUCCEEDED with zero surplus).
// per_request_cap for 'inference' is 1 STRK — 0.960804 STRK fits under it.
if (typeof AMOUNT !== "bigint" || AMOUNT <= 0n) {
  console.error(
    "AMOUNT is invalid (see the AMOUNT comment in scripts/mint-mainnet.mjs)."
  );
  process.exit(1);
}

// Mainnet params — mirror of run-mint.mjs's params, pointed at the live,
// PRE-EXISTING 'inference' policy (no registry writes needed for this
// category — see header). Caps are compared raw; max_ttl uses the exact
// on-chain ceiling of 3600s for this category.
const params = {
  category: "inference",       // was "test_mvl" — the real, pre-configured production category
  endpointId: "weather_relay", // was "endpoint_1"
  amount: AMOUNT,               // FULL note: 960804000000000000n (0.960804 STRK) — fits under the 1 STRK per_request_cap
  maxTtlSeconds: 3600n,          // was 600n — matches on-chain max_ttl_seconds=3600 for "inference", not the test_mvl value
  ownerAddress: DEPLOYER,
};

try {
  const credential = await mintCredential(params);
  console.log("MINT SUCCEEDED — resolved Credential object:");
  console.dir(credential, { depth: null });
} catch (err) {
  console.error("MINT FAILED — full raw error:");
  console.dir(err, { depth: null });
  process.exitCode = 1;
}

