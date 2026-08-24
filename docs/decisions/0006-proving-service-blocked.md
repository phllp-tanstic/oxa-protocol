# Decision 0006: Mint Flow Verified End-to-End Except Proving (Blocked)

**Status:** Partially resolved — one real external blocker remains
**Date:** 2026-08-24

## What's verified, against live Sepolia, right now

- `OxaPolicyRegistry` and `OxaCredentialIssuer` deployed and wired
  (`docs/deployments.md`).
- The Broker's off-chain policy pre-check (`broker/src/policyCheck.ts`)
  performs real read-only calls against the deployed `OxaPolicyRegistry`
  and correctly returns both outcomes: rejecting an unconfigured
  owner/category (`endpoint_1 not allowlisted`, confirmed against a real
  zeroed policy on-chain) and passing a correctly-configured one.
- Broker/Owner identity separation (Decision 0001) is correctly wired:
  policy lookups use `OWNER_ADDRESS`, distinct from `BROKER_ACCOUNT_ADDRESS`,
  which is reserved for the Broker's own signing identity.
- Commitment hash computation (`broker/src/commitmentHash.ts`) is
  confirmed byte-identical to the Cairo contract's own
  `poseidon_hash_span([OXA_CREDENTIAL_TAG, secret, endpoint_id])`.
- `POST /request-credential` end-to-end: a real request against live
  Sepolia state correctly returns `policyCheckPassed: true` and a genuine
  commitment hash once policy is configured.

## What's blocked, and why

Two distinct blockers, both required only for the final `Mint` step:

1. **`PROVING_SERVICE_URL`** — the real STRK20 proving service endpoint is
   not published anywhere we could find (not in the SDK repo's own
   examples, not in public docs). Even StarkWare's own mainnet example
   config has this as an unfilled `TODO`. Asked the hackathon organizers
   directly via Telegram; awaiting response.
2. **Discovery service (`INDEXER_URL`)** — technically self-hostable
   (`vendor/starknet-privacy/crates/discovery-service`, confirmed
   stateless, RPC-backed, no other external dependency), but its build is
   currently stalled on a git-fetch issue pulling a large upstream
   dependency (`starkware-libs/sequencer`) into the vendored repo —
   confirmed via direct `git fetch`/`git ls-remote` testing that this is
   a network/infrastructure issue on this specific large repo, not a
   configuration mistake. Parked for now; not blocking anything else.

## What this means for scope

The `Mint` operation itself — the one piece requiring real STARK proof
generation — cannot be tested until (1) is resolved. Every other part of
the system (both contracts, policy enforcement, commitment scheme,
Broker/Owner separation, standalone `redeem`'s logic) is built and
verified. Once a working `PROVING_SERVICE_URL` is available, wiring it in
is expected to be small — the SDK's `createPrivateTransfers` builder
pattern is already the target integration point (Decision 0001), nothing
upstream of it needs to change.
