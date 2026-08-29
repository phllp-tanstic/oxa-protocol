// One-off runner: mintCredential() from src/mint.ts, executed directly with the
// same loader mechanism the dev script uses ("dev": "node --loader ts-node/esm
// src/server.ts") — no build step. The import below uses the project's sibling
// .ts-module convention (see src/server.ts: `import { mintCredential } from './mint.js'`).
import { mintCredential } from "../src/mint.js";

// Live on-chain CategoryPolicy for (owner, 'test_mvl'), read from
// OxaPolicyRegistry.get_category_policy before writing this runner:
//   per_request_cap=1000, period_cap=5000, period_seconds=3600,
//   max_ttl_seconds=600, mode_locked=false, locked_mode=false
// 3600n was the original plan; on-chain max_ttl_seconds=600 is stricter, so
// per instruction the runner uses 600n — the exact on-chain ceiling.
const params = {
  category: "test_mvl",
  endpointId: "endpoint_1",
  amount: 100n, // raw u128 units, no decimal scaling — policyCheck.ts:163 compares params.amount directly to per_request_cap=1000 (5 STRK=5e18 raw reverted POLICY_CAP_EXCEEDED on-chain)
  maxTtlSeconds: 600n, // adjusted from 3600n to on-chain max_ttl_seconds=600
  ownerAddress: process.env.OWNER_ADDRESS,
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
