# Decision 0001: Authority Mechanism (Blueprint §2.12)

**Status:** Resolved
**Date:** 2026-08-19

## Decision

Design B (Broker-operated Privacy SDK integration) is the authority mechanism
for OXA's mint-triggering flow. Design A (session-key delegation through the
Starknet Wallet API) is not used.

## Why

Design A requires a delegated signer to drive `strk20InvokeTransaction`
non-interactively. Per `strk20-by-example.org/starknet-wallet-api/overview`,
the connected wallet manages ZK proof generation and signatures internally,
using the user's viewing key, which the Wallet API never exposes outside the
wallet. Starknet's live meta-transaction standard (SNIP-9, Outside Execution)
and its proposed Session Keys SNIP both grant delegated *signing* authority,
not viewing-key or proving access — neither closes this specific gap, because
proof generation, not transaction signing, is the actual bottleneck.

Design B is concretely documented and functional today via
`@starkware-libs/starknet-privacy-sdk`'s `createPrivateTransfers` factory,
which takes an `Account` (its own keypair) and a `viewingKeyProvider`
supplying a scoped viewing key — exactly the Broker's use case.

## What this changes

- The Broker holds its own Starknet account and a policy-scoped viewing key,
  used only for the credential-issuance flow. The owner's main wallet, main
  viewing key, and main balance are never touched by the Broker.
- Threat T3 (Blueprint §5.4) is mitigated operationally: the Broker's account
  is funded conservatively and only ever holds what's actively in flight
  through the CredentialIssuer, since there is no session-key scope limit to
  rely on instead.
- This is a custodial tradeoff, stated here plainly per Directive §2: the
  Broker is a lightweight custodian for this one flow, not a fully
  non-custodial design.

## Sources

- https://strk20-by-example.org/starknet-wallet-api/overview
- https://strk20-by-example.org/sdk/getting-started
- https://strk20-by-example.org/starknet-wallet-api/starknet-js