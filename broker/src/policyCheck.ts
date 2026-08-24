/**
 * Off-chain policy pre-check against the live OxaPolicyRegistry on Sepolia.
 *
 * Plain read-only Starknet calls (no signing, no gas, no proving service):
 *   - get_category_policy(owner, category)  -> CategoryPolicy
 *   - is_endpoint_allowed(owner, category, endpoint_id) -> bool
 *
 * Mirrors the on-chain checks OxaCredentialIssuer enforces in privacy_invoke
 * (is_endpoint_allowed + per_request_cap), so a credential request that passes
 * here would also pass the contract-side re-check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Contract, RpcProvider } from 'starknet';

import { loadConfig } from './config';
import { feltFromParam } from './commitmentHash';

/**
 * Broker policy reads go through the single RPC endpoint configured for the
 * whole broker (RPC_URL in broker/.env — the operator-confirmed Sepolia
 * endpoint). The task originally pinned
 * https://free-rpc.nethermind.io/sepolia-juno/v0_7 here, but Nethermind
 * retired that host (NXDOMAIN confirmed via Google AND Cloudflare DoH), so the
 * .env value is now the source of truth.
 */

/**
 * ABI copied from contracts/target/dev/oxa_policy_registry_OxaPolicyRegistry.contract_class.json
 * (the full Sierra class JSON; we extract its `abi` array below). Loaded via fs
 * rather than a JSON import to keep the Sierra program out of tsc's inference.
 */
const CONTRACT_CLASS = JSON.parse(
  readFileSync(join(__dirname, 'abi', 'OxaPolicyRegistry.json'), 'utf8'),
) as { abi?: unknown[] };
const POLICY_REGISTRY_ABI: unknown[] = Array.isArray(CONTRACT_CLASS)
  ? CONTRACT_CLASS
  : (CONTRACT_CLASS.abi as unknown[]);

export interface PolicyCheckParams {
  owner: string;
  category: string;
  endpointId: string;
  amount: bigint;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

let cachedRegistry: Contract | null = null;

function getPolicyRegistry(): Contract {
  if (cachedRegistry === null) {
    const config = loadConfig();
    const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    cachedRegistry = new Contract({
      abi: POLICY_REGISTRY_ABI,
      address: config.policyRegistryAddress,
      providerOrAccount: provider,
    });
  }
  return cachedRegistry;
}

/** Read one member from a returned Cairo struct, tolerating both object and positional forms. */
function structField(result: unknown, name: string, index: number): unknown {
  if (result === null || result === undefined) return undefined;
  if (Array.isArray(result)) return result[index];
  return (result as Record<string, unknown>)[name];
}

/** Coerce a parsed Cairo value (felt/u128/bool) to bigint without precision loss. */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? BigInt(1) : BigInt(0);
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`cannot convert value to bigint: ${String(value)}`);
}

/**
 * Check whether `amount` may be spent by `owner` in `category` at `endpointId`.
 * Returns { allowed: false, reason } with a specific reason when blocked.
 */
export async function checkPolicy(params: PolicyCheckParams): Promise<PolicyCheckResult> {
  const registry = getPolicyRegistry();

  const owner = params.owner;
  const categoryFelt = feltFromParam(params.category);
  const endpointFelt = feltFromParam(params.endpointId);

  const [policyRaw, endpointAllowedRaw]: [unknown, unknown] = await Promise.all([
    registry.call('get_category_policy', [owner, categoryFelt]),
    registry.call('is_endpoint_allowed', [owner, categoryFelt, endpointFelt]),
  ]);

  // Normalize Cairo bool across parser variants (boolean | 1n | 0n).
  const endpointAllowed =
    endpointAllowedRaw === true ||
    endpointAllowedRaw === BigInt(1);

  if (!endpointAllowed) {
    return {
      allowed: false,
      reason:
        `endpoint '${params.endpointId}' is not allowlisted for owner ${owner} ` +
        `and category '${params.category}'`,
    };
  }

  const perRequestCap = toBigInt(structField(policyRaw, 'per_request_cap', 0) ?? 0);

  if (perRequestCap === BigInt(0)) {
    return {
      allowed: false,
      reason:
        `no spend policy configured for owner ${owner} and category ` +
        `'${params.category}' (per_request_cap is 0)`,
    };
  }

  if (params.amount > perRequestCap) {
    return {
      allowed: false,
      reason:
        `amount ${params.amount} exceeds per_request_cap ${perRequestCap} ` +
        `for owner ${owner} and category '${params.category}'`,
    };
  }

  return { allowed: true };
}