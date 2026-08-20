# Decision 0004: Privacy Package Grounding (Blueprint §2.5)

**Status:** Resolved
**Date:** 2026-08-19

## Decision

`OxaCredentialIssuer` will depend on the real `privacy` Cairo package from
`starkware-libs/starknet-privacy` (path `packages/privacy`), pinned at
commit `b59d8a141e49a9d940fb14dfe935cbecb8202814`. `OxaCredentialIssuer`'s
own `starknet` dependency is pinned to `2.17.0` to match the version the
`privacy` package itself was built against, rather than our locally
installed compiler's newer `2.20.0`, to avoid a dependency-resolution
conflict.

## Why

Blueprint §2.5's `IOxaCredentialIssuer` interface was written from the
`strk20-by-example.org` documentation and an "unofficial, StarkWare-flagged-
as-unaudited" Escrow reference, not from the actual protocol source. Cloned
`starkware-libs/starknet-privacy` directly to verify against ground truth
before writing contract code, per Directive §3 (no hardcoding without
checking whether the real thing is available).

Confirmed directly from source (`packages/privacy/src/utils.cairo`,
`packages/privacy/src/test_contracts/mock_swap_executor.cairo`):

- `INVOKE_SELECTOR = selector!("privacy_invoke")` — Blueprint's method name
  was correct.
- Real anonymizer contracts (`MockSwapExecutor`) return
  `Span<privacy::objects::OpenNoteDeposit>`, exactly as Blueprint specified.
- No Escrow example exists in this repo — Blueprint's own "unofficial"
  framing is accurate; `MockSwapExecutor` is the closest real, in-repo
  reference and is used as the grounding example instead.
- Parameter shape is anonymizer-specific, not protocol-mandated. The
  protocol only requires the function be named `privacy_invoke` and return
  the correct span type — there is no shared "operation" pattern across
  anonymizers. Blueprint's `OxaOperation` enum (discriminating Mint/Reclaim
  in one function) is therefore a valid OXA-specific design choice, not
  something copied from an existing pattern, and is recorded here as such.
- Access control is caller-address-based, not protocol-enforced:
  `MockSwapExecutor` captures `get_caller_address()` as the pool's address
  and treats matching it as the trust boundary — the anonymizer contract
  itself is responsible for this check. This directly grounds Blueprint
  §5.1's `CALLER_NOT_PRIVACY` error constant, which anticipated exactly
  this requirement. `OxaCredentialIssuer` will store the pool's address at
  construction and assert against it at the top of `privacy_invoke`.

## What this changes

- `contracts/OxaCredentialIssuer/Scarb.toml` depends on `privacy` via git,
  pinned to the commit above, not a hypothetical or guessed package path.
- `starknet` dependency pinned to `2.17.0` across our own contracts, not
  our compiler's latest supported version, for resolution compatibility
  with the `privacy` package.
- Blueprint §2.5's `IOxaCredentialIssuer` interface stands as designed
  (Mint/Reclaim via one `privacy_invoke` with an `OxaOperation` enum), now
  confirmed as a valid application of the real protocol requirement rather
  than an assumption about it.

## Sources

- https://github.com/starkware-libs/starknet-privacy
  (`packages/privacy/src/utils.cairo`,
  `packages/privacy/src/test_contracts/mock_swap_executor.cairo`,
  `packages/privacy/src/interface.cairo`), commit
  `b59d8a141e49a9d940fb14dfe935cbecb8202814`
