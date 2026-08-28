/**
 * Diagnostic harness for the Mint wiring. Run:
 *   npx ts-node --transpile-only scripts/smoke-mint.ts
 * Reads the real on-chain policy for the test category, then attempts a real
 * Mint. With the allowlist blocker unresolved (and no shielded broker note) the
 * Mint must FAIL HONESTLY — this verifies the full wiring up to the pool-write
 * boundary.
 */
import { checkPolicy } from '../src/policyCheck.js';
import { mintCredential } from '../src/mint.js';
import { loadConfig } from '../src/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('owner:', config.ownerAddress);

  const policy = await checkPolicy({
    owner: config.ownerAddress,
    category: 'test_mvl',
    endpointId: 'endpoint_1',
    amount: BigInt(1),
  });
  console.log(
    'policy:',
    JSON.stringify(policy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );

  if (!policy.allowed || policy.policy === undefined) {
    console.log('policy rejection — cannot attempt mint. Response above is the live on-chain truth.');
    return;
  }

  try {
    const cred = await mintCredential({
      category: 'test_mvl',
      endpointId: 'endpoint_1',
      amount: BigInt(1),
      maxTtlSeconds: policy.policy.maxTtlSeconds,
      ownerAddress: config.ownerAddress,
    });
    console.log(
      'credential (MINT SUCCEEDED):',
      JSON.stringify(cred, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  } catch (err) {
    console.log(
      'mint rejected as expected (allowlist/note-funding pending):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('HARNESS FAILED:', e);
    process.exit(1);
  });