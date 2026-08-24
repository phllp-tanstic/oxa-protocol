/**
 * One-off live-Sepolia check for StarknetEndpointClient.redeemCredential.
 *
 * Expected outcome: an on-chain revert with CREDENTIAL_NOT_FOUND — no credential
 * has ever been minted (minting is blocked pending PROVING_SERVICE_URL,
 * docs/decisions/0006-proving-service-blocked.md), so redeeming a made-up
 * secret must revert. That revert still proves the ABI, contract address, and
 * signed-invoke flow are wired correctly against the real deployed contract.
 *
 * Redeem is caller-independent by design, so using the Broker's own key here
 * is fine; no new key material is introduced.
 */
import { inspect } from 'node:util';

import { StarknetEndpointClient } from '@oxa/sdk';

import { loadConfig } from '../src/config';

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('Submitting real signed redeem() invoke against live OxaCredentialIssuer…');
  console.log(`issuer contract : ${config.credentialIssuerAddress}`);
  console.log(`caller account  : ${config.brokerAccountAddress}`);
  console.log('params          : credentialSecret=0xdeadbeef endpointId="endpoint_1" payout=<caller account>');

  const client = new StarknetEndpointClient({
    rpcUrl: config.rpcUrl,
    issuerContract: config.credentialIssuerAddress,
    accountAddress: config.brokerAccountAddress,
    privateKey: config.brokerPrivateKey,
  });

  try {
    const result = await client.redeemCredential({
      credentialSecret: '0xdeadbeef',
      endpointId: 'endpoint_1',
      payoutAddress: config.brokerAccountAddress,
    });
    console.log('SUCCESS — full result:');
    console.log(JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
    process.exit(0);
  } catch (err) {
    // Print the COMPLETE raw error — every property, full depth, including any
    // chain-provided revert reason. No catching-and-summarizing.
    console.error('REDEEM FAILED — complete raw error:');
    console.error(inspect(err, { depth: null, maxArrayLength: null, breakLength: 120 }));
    process.exit(1);
  }
}

void main();