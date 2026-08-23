import { Account, Contract, RpcProvider } from 'starknet';
import type { OxaEndpointClient, RedeemParams, RedeemResult } from './types';

// TODO: replace this placeholder ABI with the real ABI import path once the
// contracts are deployed to testnet and we have a real artifact to import, e.g.:
//   import oxaIssuerAbi = require('../abis/oxa_credential_issuer.json');
const PLACEHOLDER_ISSUER_ABI = [
  {
    name: 'redeem',
    type: 'function',
    inputs: [
      { name: 'credential_secret', type: 'felt252' },
      { name: 'endpoint_id', type: 'felt252' },
      { name: 'payout_address', type: 'ContractAddress' },
    ],
    outputs: [],
    state_mutability: 'external',
  },
];

export interface StarknetEndpointClientOptions {
  rpcUrl: string;
  issuerContract: string;
  accountAddress: string;
  privateKey: string;
}

/**
 * Endpoint-side client: redeems an OXA credential on-chain by calling the
 * Credential Issuer contract's `redeem` entrypoint.
 */
export class StarknetEndpointClient implements OxaEndpointClient {
  private readonly options: StarknetEndpointClientOptions;

  constructor(options: StarknetEndpointClientOptions) {
    this.options = options;
  }

  async redeemCredential(params: RedeemParams): Promise<RedeemResult> {
    const provider = new RpcProvider({ nodeUrl: this.options.rpcUrl });
    const account = new Account({
      provider,
      address: this.options.accountAddress,
      signer: this.options.privateKey,
    });
    const contract = new Contract({
      abi: PLACEHOLDER_ISSUER_ABI,
      address: this.options.issuerContract,
      providerOrAccount: account,
    });

    const result = await contract.redeem(
      params.credentialSecret,
      params.endpointId,
      params.payoutAddress,
    );

    return {
      txHash: result.transaction_hash,
      // TODO: parse the actual redeemed amount from the transaction receipt /
      // return data once the real ABI is wired in.
      amount: BigInt(result.amount ?? 0),
    };
  }
}
