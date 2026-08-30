// One-off runner: exercise the REAL reclaim interface for the expired credential.
//
// Step 1 findings (grep -rni reclaim across broker/src, sdk/src, broker/scripts):
//  - sdk/src/types.ts:25 — interface declaration on OxaBroker:
//        reclaimExpired(commitmentHash: string): Promise<{ txHash: string }>;
//  - sdk/src/brokerClient.ts:41 — HttpOxaBroker.reclaimExpired — the only
//    implemented client. POSTs serializeJson({ commitmentHash }) to
//    `${baseUrl}/reclaim-expired`; on non-2xx throws:
//        `reclaim-expired failed: HTTP <status> <statusText>: <body>`
//  - broker/src/server.ts:142-144 — the route it POSTs to is a stub:
//        app.post('/reclaim-expired', (_req, res) => {
//          res.status(501).json({ error: 'not implemented yet' });
//        });
//  - sdk/src/endpointClient.ts has NO reclaim method (only redeemCredential).
//  - On-chain reclaim logic exists (contracts/oxa_credential_issuer/src/lib.cairo:189-205,
//    privacy_invoke OxaOperation::Reclaim) but lib.cairo:157 enforces
//    CALLER_NOT_PRIVACY — only the privacy pool may call it, and no TS caller
//    for it exists anywhere in broker/ or sdk/.
// This runner therefore exercises the exact declared interface
// (HttpOxaBroker.reclaimExpired) against a locally running broker server,
// after verifying — with real, signature-known interfaces only — that every
// on-chain Reclaim precondition (lib.cairo:189-196) already holds.
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { RpcProvider, Contract } from "starknet";
import { HttpOxaBroker } from "@oxa/sdk";
import { loadConfig } from "../src/config.js";
import { computeReclaimCommitment } from "../src/commitmentHash.js";

const config = loadConfig();

// Step 2 target: the credential minted earlier tonight that has genuinely
// expired (expiryTimestamp 1788036681; current epoch was 1788039880 at task
// start — 3199 s past expiry).
const TARGET_COMMITMENT =
  "0x2d333cadddf2d9e1a3fcab7e958517f93c1e90c7fa53bf87168987a28dd7e68";

const credentials = JSON.parse(
  readFileSync(new URL("../.data/credentials.json", import.meta.url), "utf8"),
);
const credential = credentials[TARGET_COMMITMENT];
if (!credential) {
  console.error(`commitment ${TARGET_COMMITMENT} not found in credentials.json`);
  process.exit(1);
}

const nowEpoch = Math.floor(Date.now() / 1000);
console.log("Expired credential targeted for reclaim (from .data/credentials.json):");
console.log(`  commitmentHash     : ${credential.commitmentHash}`);
console.log(`  credentialSecret   : ${credential.credentialSecret}`);
console.log(`  reclaimSecret      : ${credential.reclaimSecret}`);
console.log(`  endpointId         : ${credential.endpointId}`);
console.log(`  amount             : ${credential.amount} (raw units)`);
console.log(`  createdAt          : ${credential.createdAt}`);
console.log(`  expiryTimestamp    : ${credential.expiryTimestamp}`);
console.log(`  now (epoch s)      : ${nowEpoch}`);
console.log(`  seconds past expiry: ${nowEpoch - credential.expiryTimestamp}`);
console.log(`  used               : ${credential.used}`);

// Real precondition check 1 — the exact local helper the implemented reclaim
// would rely on: computeReclaimCommitment(reclaimSecret) (commitmentHash.ts:54),
// byte-for-byte equivalent of Cairo's poseidon_hash_span([OXA_RECLAIM_TAG,
// reclaim_secret]) (lib.cairo:52-53).
const computedReclaimCommitment = computeReclaimCommitment(credential.reclaimSecret);
console.log(`  computeReclaimCommitment(reclaimSecret) = ${computedReclaimCommitment}`);

// Real precondition check 2 — the on-chain credential entry, via the issuer's
// get_credential view (real ABI from sdk/src/abi/OxaCredentialIssuer.json):
const issuerAbiFile = JSON.parse(
  readFileSync(
    new URL("../../sdk/src/abi/OxaCredentialIssuer.json", import.meta.url),
    "utf8",
  ),
);
const issuerAbi = Array.isArray(issuerAbiFile) ? issuerAbiFile : issuerAbiFile.abi;
const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
const issuer = new Contract({
  abi: issuerAbi,
  address: config.credentialIssuerAddress,
  providerOrAccount: provider,
});
const entry = await issuer.get_credential(credential.commitmentHash);
console.log("On-chain get_credential entry (full):");
console.dir(entry, { depth: null });
console.log(
  `  reclaim_commitment matches local helper: ${
    BigInt(`0x${entry.reclaim_commitment.toString(16)}`) === BigInt(computedReclaimCommitment)
  }`,
);
console.log(`  on-chain used flag       : ${entry.used}`);
console.log(
  `  on-chain expiry_timestamp: ${entry.expiry_timestamp} (expired vs now: ${
    nowEpoch > Number(entry.expiry_timestamp)
  })`,
);

// The exact interface found in Step 1: HttpOxaBroker.reclaimExpired(commitmentHash).
const broker = new HttpOxaBroker({ baseUrl: `http://localhost:${config.port}` });
try {
  const result = await broker.reclaimExpired(credential.commitmentHash);
  console.log("RECLAIM SUCCEEDED — full result object:");
  console.dir(result, { depth: null });
} catch (err) {
  // Complete raw error — every property, full depth. No summarizing.
  console.error("RECLAIM FAILED — full raw error:");
  console.error(inspect(err, { depth: null, maxArrayLength: null, breakLength: 120 }));
  process.exitCode = 1;
}
