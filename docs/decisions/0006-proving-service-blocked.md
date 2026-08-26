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

---

## Addendum (2026-08-24): redeem() independently verified live

`sdk/src/endpointClient.ts`'s `StarknetEndpointClient` was wired against
the real, deployed `OxaCredentialIssuer` ABI and tested with a genuine
signed invoke transaction against live Sepolia. Called `redeem()` with a
deliberately nonexistent credential secret; the transaction reverted
inside the live contract itself with `CREDENTIAL_NOT_FOUND` — the
correct, expected result, since nothing has been minted yet.

This is meaningful, not a null result: the entrypoint selector was
computed by `starknet.js` from the real Sierra ABI (not hand-written),
the call executed against the correct declared class hash and deployed
address, and the revert reason came from our own contract's own
assertion — confirming ABI wiring, address wiring, and the signing flow
are all correct end-to-end. The only remaining gap for a full success
case is a real minted credential to redeem, which depends on the still-
blocked proving service above.

Attempted to resolve the proving-service blocker directly: checked the
vendored repo's own CI configs (`demo-deploy.yml` pulls
`BACKEND_PROVER_URL`/`BACKEND_INDEXER_URL` from GitHub Actions secrets —
confirmed deliberately private, not published anywhere in the public
repo), and queried Starknet's official 24/7 assistant
(`agent.starknet.io`), which had no STRK20-specific information indexed.
Escalated to the hackathon's Telegram and the Starknet Discord directly;
awaiting a response from a human.

---

## Addendum (2026-08-26): self-hosted prover working

Resolved the proving-service blocker via self-hosting, not via organizer
response (issue and Discord/Telegram messages remain unanswered as of
this writing). Built `starkware-libs/sequencer`'s
`crates/starknet_transaction_prover` locally via Docker — the official,
StarkWare-authored self-hosting path, confirmed genuine via API-spec
match against our vendored SDK's own committed fixture (see original
entry above). Build took ~85 minutes once dependency discovery was
complete (sparse-checkout of the full 115-crate workspace, required
because cargo needs the whole dependency graph's manifests even for a
single-crate build).

Two real, non-obvious bugs found and fixed while integrating it:

1. **`PRIVATE_KEY_NOT_CANONICAL`** — the pool enforces
   `key < HALF_ORDER` (half the STARK curve order) on registered viewing
   keys, a standard malleability-prevention constraint
   (`packages/privacy/src/utils.cairo::is_canonical_key`). Our originally
   generated viewing key was a uniformly random scalar with no such
   bound — roughly a coin flip whether it would land in the accepted
   range. Fixed by generating scalars in a loop, discarding any at or
   above `HALF_ORDER`, using `starknet.js`'s own `ec.starkCurve.CURVE.n`
   constant rather than a hardcoded value.
2. **Request timeout too short for local hardware** — the SDK's default
   proving-request timeout (30s) is calibrated to StarkWare's stated
   "~4s proving time" claim, which is almost certainly measured against
   their documented production sizing (48 vCPU / 96 GB), not commodity
   hardware. Confirmed via prover logs that proving was genuinely
   in-progress, not stuck, well past 30s. Fixed via the SDK's own
   `provingProvider.requestTimeoutMs` config option, raised to 5 minutes.

## What this changes

- The proving blocker is no longer external/unowned. Remaining risk is
  operational (keeping the prover container running reliably) and
  performance (proving time on modest hardware), not a missing unknown.
- For any demo requiring live availability during judging (not just
  recorded transactions), the prover needs to move from a local machine
  to a persistent host — tracked as a Phase 4 task, not yet done.
- Discovery service remains unresolved but is looking decreasingly
  necessary for Mint specifically — registration reached real proving
  and pool evaluation with no indexer configured at all.
