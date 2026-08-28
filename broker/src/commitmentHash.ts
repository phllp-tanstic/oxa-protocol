/**
 * Commitment hashing — replicates EXACTLY what contracts/oxa_credential_issuer
 * computes on-chain:
 *
 *   pub const OXA_CREDENTIAL_TAG: felt252 = 'OXA_CREDENTIAL_TAG:V1';
 *   fn compute_credential_commitment(secret: felt252, endpoint_id: felt252) -> felt252 {
 *       core::poseidon::poseidon_hash_span([OXA_CREDENTIAL_TAG, secret, endpoint_id].span())
 *   }
 *
 * starknet.js's hash.computePoseidonHashOnElements implements the same
 * Starknet poseidon_hash_span over an element list (each element converted via
 * BigInt), so feeding [tag_felt, secret_felt, endpoint_id_felt] yields the
 * identical felt252 the contract stores.
 */
import { hash, num, shortString } from 'starknet';

/** Must match OXA_CREDENTIAL_TAG in contracts/oxa_credential_issuer/src/lib.cairo. */
export const OXA_CREDENTIAL_TAG = 'OXA_CREDENTIAL_TAG:V1';

/**
 * Convert a caller-friendly value into its felt252 representation:
 *  - hex ("0x…") or decimal strings pass through numerically;
 *  - anything else is treated as a Cairo short string and ASCII-encoded
 *    (e.g. "endpoint_1" -> 0x656e64706f696e745f31).
 */
export function feltFromParam(value: string): string {
  if (num.isHex(value) || /^-?\d+$/.test(value)) {
    return value;
  }
  return shortString.encodeShortString(value);
}

/**
 * computeCredentialCommitment — byte-for-byte equivalent of Cairo's
 * poseidon_hash_span([OXA_CREDENTIAL_TAG, secret, endpoint_id]).
 */
export function computeCredentialCommitment(secret: string, endpointId: string): string {
  return hash.computePoseidonHashOnElements([
    shortString.encodeShortString(OXA_CREDENTIAL_TAG),
    feltFromParam(secret),
    feltFromParam(endpointId),
  ]);
}

/** Must match OXA_RECLAIM_TAG in contracts/oxa_credential_issuer/src/lib.cairo. */
export const OXA_RECLAIM_TAG = 'OXA_RECLAIM_TAG:V1';

/**
 * computeReclaimCommitment — byte-for-byte equivalent of Cairo's
 * poseidon_hash_span([OXA_RECLAIM_TAG, reclaim_secret]) (lib.cairo
 * compute_reclaim_commitment). The reclaim secret stays with the broker
 * (Decision 0001 custodial scope) so expired credentials can be reclaimed.
 */
export function computeReclaimCommitment(reclaimSecret: string): string {
  return hash.computePoseidonHashOnElements([
    shortString.encodeShortString(OXA_RECLAIM_TAG),
    feltFromParam(reclaimSecret),
  ]);
}