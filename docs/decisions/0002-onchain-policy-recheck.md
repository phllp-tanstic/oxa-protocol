
---

## Addendum (2026-08-20)

**Refinement, not a reversal.** On implementation, this decision required
adding `owner: ContractAddress` and `category: felt252` as plain parameters
to `privacy_invoke`, supplied by the Broker (which already knows the real
owner it's acting for, per Decision 0001). This is necessary because the
privacy pool's proof system deliberately hides the real owner's identity
from the anonymizer contract before `privacy_invoke` is ever called —
there is no cryptographic signal available inside `privacy_invoke` that
could independently verify which owner a withdrawal came from without
defeating the pool's own unlinkability guarantee. This is a structural
property of the pool, not a gap in this design.

**Consequently, the scope of what this on-chain check protects against is
narrower than originally stated.** It catches bugs in the Broker's
off-chain policy logic (a missed edge case, an off-by-one, a logic error).
It does not, and cannot, protect against a fully compromised Broker lying
about which owner/category a mint belongs to — that remains T3 (Broker
compromise), already documented in Blueprint §5.4, whose only real
mitigation is operational: keeping the Broker's own funded balance
conservative, per Decision 0001. T6 is resolved for the bug-catching case;
T3 is unaffected by this decision and stands on its own mitigation.
