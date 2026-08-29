// One-off runner: exercise the REAL redeem interface with the real credential
// minted tonight. There is no standalone exported redeem() function —
// sdk/src/endpointClient.ts exports the class StarknetEndpointClient, and
// redeemCredential() (sdk/src/endpointClient.ts:57) is its sole method. This
// import matches the project's own precedent for exactly this operation
// (broker/scripts/test-redeem.ts: `import { StarknetEndpointClient } from '@oxa/sdk'`),
// resolving to the compiled sdk/dist (built 8/28/2026 14:44).
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { StarknetEndpointClient } from "@oxa/sdk";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

// Real credential data — broker/.data/credentials.json (gitignored testnet data).
// RedeemParams = { credentialSecret, endpointId, payoutAddress } (sdk/src/types.ts:28-32);
// issuerContract/token/amount/expiry are NOT part of the redeem() call itself.
const credentials = JSON.parse(
  readFileSync(new URL("../.data/credentials.json", import.meta.url), "utf8"),
);
const [commitmentHash, credential] = Object.entries(credentials)
  .filter(([, c]) => c.used === false)
  .sort(([, a], [, b]) => b.createdAt - a.createdAt)[0];

const params = {
  credentialSecret: credential.credentialSecret,
  endpointId: credential.endpointId,
  // credentials.json stores no issuerContract/token fields; issuerContract is
  // taken from CREDENTIAL_ISSUER_ADDRESS (.env via loadConfig) — the same real
  // deployed OxaCredentialIssuer every other broker path uses. redeem()'s
  // interface takes no token parameter.
  payoutAddress: config.brokerAccountAddress,
};

console.log("Redeeming real credential from .data/credentials.json:");
console.log(`  commitmentHash   : ${commitmentHash}`);
console.log(`  credentialSecret : ${credential.credentialSecret}`);
console.log(`  endpointId       : ${credential.endpointId}`);
console.log(`  amount           : ${credential.amount} (raw units)`);
console.log(`  createdAt        : ${credential.createdAt}`);
console.log(`  expiryTimestamp  : ${credential.expiryTimestamp}`);
console.log(`  now (epoch s)    : ${Math.floor(Date.now() / 1000)}`);
console.log(`  used             : ${credential.used}`);
console.log(`  reclaimSecret    : ${credential.reclaimSecret}`);
console.log(`  issuerContract   : ${config.credentialIssuerAddress}`);
console.log(`  caller account   : ${config.brokerAccountAddress}`);
console.log(`  payoutAddress    : ${params.payoutAddress}`);

const client = new StarknetEndpointClient({
  rpcUrl: config.rpcUrl,
  issuerContract: config.credentialIssuerAddress,
  accountAddress: config.brokerAccountAddress,
  privateKey: config.brokerPrivateKey,
});

try {
  const result = await client.redeemCredential(params);
  console.log("REDEEM SUCCEEDED — full result object:");
  console.dir(result, { depth: null });
} catch (err) {
  // Complete raw error — every property, full depth, including any
  // chain-provided revert reason. No catching-and-summarizing.
  console.error("REDEEM FAILED — full raw error:");
  console.error(inspect(err, { depth: null, maxArrayLength: null, breakLength: 120 }));
  process.exitCode = 1;
}
