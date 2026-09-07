# OXA

Scoped, single-use payment credentials for autonomous agents, issued against the STRK20 privacy pool on Starknet.

An owner shields funds into the privacy pool once. The broker then issues per-purchase credentials: a fixed amount of STRK locked behind a Poseidon commitment, redeemable exactly once, by exactly one endpoint ID, within a fixed TTL. Unused credentials are reclaimed to the broker's shielded balance after expiry.

**Status** (verified transactions in [`strk20.json`](strk20.json)):

| Operation | Sepolia | Mainnet |
|---|---|---|
| Register (viewing key) | ✅ | ✅ |
| Shield | ✅ | ✅ |
| Private send | ✅ | ✅ |
| Mint | ✅ | ❌ blocked — see [Known Limitations](#known-limitations) |
| Redeem | ✅ | ❌ not run |
| Reclaim | ✅ | ❌ not run |

## Architecture

| Component | Path | Role |
|---|---|---|
| Cairo contracts | `contracts/` | `OxaPolicyRegistry` (per-owner spend policies, endpoint allowlists) and `OxaCredentialIssuer` (credential storage; Mint/Reclaim via `privacy_invoke`, standalone `redeem`). Scarb workspace, Cairo `2024_07`, `starknet` 2.17.0, `privacy` package pinned at `b59d8a14…`. |
| Broker | `broker/` | Express service (port 3000). Checks policy off-chain, mints by driving the STRK20 SDK (proof → broadcast), persists credential secrets to gitignored `broker/.data/`, reclaims expired credentials. |
| TypeScript SDK | `sdk/` | `@oxa/sdk`: `HttpOxaBroker` (broker HTTP client) and `StarknetEndpointClient` (on-chain `redeem()` for endpoints). |
| STRK20 SDK (vendored) | `vendor/starknet-privacy/sdk` | `@starkware-libs/starknet-privacy-sdk` 0.14.3-rc.5 (ESM-only, `file:` dependency). Computes STARK proofs and returns `{ call, proof }`; never broadcasts — the broker signs and submits the proof-carrying v3 transaction. |
| Prover | external | Self-hosted STRK20 proving service (`PROVING_SERVICE_URL`), built from `starkware-libs/sequencer` `crates/starknet_transaction_prover`, pinned to tag `APOLLO-0.14.3-RC.17` (`.github/workflows/build-prover.yml`). Required for every pool operation. |
| MCP server | `broker/scripts/mcp-server.mjs` | Streamable HTTP JSON-RPC at `POST /mcp` (port 3002). Tools: `oxa_request_credential`, `oxa_call_endpoint`, `oxa_reclaim_expired`. |
| Inference relay | `broker/scripts/inference-relay.mjs` | Paid-endpoint example (port 3001). Serves `POST /infer` (Open-Meteo) only after independently verifying the credential was genuinely redeemed on-chain; otherwise 402. |

Trust boundaries: the broker is a lightweight custodian (Decision 0001) holding its own Starknet account and a policy-scoped viewing key; it never touches the owner's wallet or main balance. The issuer accepts `privacy_invoke` only from the pool (`CALLER_NOT_PRIVACY`); the registry accepts spend records only from its configured `authorized_issuer`. Details in [Security](#security--trust-model).

## Protocol Flow

Actors: **Owner** (sets policy), **Broker** (issues credentials), **Endpoint** (redeems). Contracts: `OxaPolicyRegistry`, `OxaCredentialIssuer`, the external STRK20 privacy pool.

1. **Register** — broker registers its viewing key with the pool (proof-carrying `apply_actions`), enabling note discovery for its shielded balance.
2. **Shield** — funds are deposited into the pool (deposit screening is protocol-enforced); the viewing key reveals the broker's shielded notes.
3. **Policy** — the owner configures `OxaPolicyRegistry` from its own account: `set_category_policy` (`per_request_cap`, `period_cap`, `period_seconds`, `max_ttl_seconds`, mode lock), `set_endpoint_allowed`, `set_authorized_issuer(issuer)`.
4. **Mint** — `POST /request-credential`:
   - Broker pre-checks the policy with read-only registry calls (`broker/src/policyCheck.ts`): endpoint allowlisted, amount ≤ `per_request_cap`, TTL window configured, mode resolution.
   - `broker/src/mint.ts` builds a pool bundle: withdraw `amount` STRK to `OxaCredentialIssuer` + `InvokeExternal` → `privacy_invoke(Mint, …)`.
   - The SDK computes the STARK proof; the broker broadcasts the v3 transaction and waits for `SUCCEEDED`.
   - The issuer re-checks the policy on-chain (`ENDPOINT_NOT_ALLOWED`, `POLICY_CAP_EXCEEDED` via `record_spend`), then stores `CredentialEntry { token, amount, endpoint_id, expiry_timestamp, reclaim_commitment, used: false }`.
   - Commitments: credential = `poseidon_hash_span(['OXA_CREDENTIAL_TAG:V1', secret, endpoint_id])`; reclaim = `poseidon_hash_span(['OXA_RECLAIM_TAG:V1', reclaim_secret])`. `broker/src/commitmentHash.ts` is byte-identical to the Cairo implementation. `expiry = now + policy.max_ttl_seconds`.
   - Only after on-chain confirmation are the secrets written to `broker/.data/credentials.json` and the claim payload returned.
5. **Redeem** — the endpoint calls `OxaCredentialIssuer.redeem(credential_secret, endpoint_id, payout_address)`. On-chain: commitment recomputed; `CREDENTIAL_NOT_FOUND` / `ALREADY_USED` / `EXPIRED` / `ENDPOINT_MISMATCH` checks; entry marked used; ERC-20 transfer to payout; `CredentialRedeemed` event. Single-use and endpoint binding are enforced by the contract, not the broker.
6. **Reclaim** — after expiry, `POST /reclaim-expired` has the broker open an SDK "Open" note and call `privacy_invoke(Reclaim, …, reclaim_secret, note_id)`. The issuer verifies past expiry + reclaim secret (`NOT_YET_EXPIRED`, `INVALID_RECLAIM_SECRET`), marks used, approves the pool, and returns `OpenNoteDeposit { note_id, token, amount }`; the pool credits the broker's shielded balance with the locked amount.

## Repository Structure

| Path | Purpose |
|---|---|
| `contracts/oxa_policy_registry/` | Policy storage contract + snforge tests |
| `contracts/oxa_credential_issuer/` | Credential issuer contract (`privacy_invoke` Mint/Reclaim, standalone `redeem`) |
| `contracts/oxa_integration_tests/` | Cross-contract snforge tests (mock ERC-20, mocked pool caller) |
| `broker/src/` | Broker service: `server.ts` (routes), `mint.ts`, `reclaim.ts`, `policyCheck.ts`, `poolTx.ts` (proof + broadcast), `commitmentHash.ts`, `credentialStore.ts`, `config.ts` |
| `broker/scripts/` | Runners: `register-broker*.mjs`, `shield-strk*.mjs`, `run-mint.mjs`, `run-redeem.mjs`, `run-reclaim.mjs`, `mint-mainnet.mjs`, `check-notes*.mjs`, `mcp-server.mjs`, `inference-relay.mjs`, `preflight.mjs` |
| `sdk/src/` | `HttpOxaBroker`, `StarknetEndpointClient`, shared types, issuer ABI |
| `vendor/starknet-privacy/` | Vendored STRK20 SDK + protocol repo (gitignored; cloned at install) |
| `docs/` | `deployments.md`, decision records, landing page (`index.html`) |
| `strk20.json` | Verified on-chain transactions and deployed addresses |

## Requirements

- Node.js 24.x, npm (verified for all TS components)
- Scarb — Cairo edition `2024_07`, `starknet` 2.17.0, `snforge_std` 0.63.0 (contracts)
- Docker — only for building the prover image (`.github/workflows/build-prover.yml`)
- A funded Starknet account (STRK for v3 fees) and a reachable STRK20 prover for any pool operation

## Installation

```bash
git clone https://github.com/phllp-tanstic/oxa-protocol.git
cd oxa-protocol

# 1. Vendored STRK20 SDK (gitignored — clone and build first; broker depends on it via file:)
git clone https://github.com/starkware-libs/starknet-privacy vendor/starknet-privacy
git -C vendor/starknet-privacy checkout b59d8a141e49a9d940fb14dfe935cbecb8202814
cd vendor/starknet-privacy/sdk && npm install && npm run build && cd ../../..

# 2. OXA SDK
cd sdk && npm install && npm run build && cd ..

# 3. Broker (depends on ../sdk and ../vendor/starknet-privacy/sdk via file:)
cd broker && npm install && npm run build

# 4. Configuration
cp .env.example .env   # then fill in every variable — see below
```

## Configuration

`broker/.env` (gitignored; template in [`broker/.env.example`](broker/.env.example)). `broker/src/config.ts` fails fast, listing every missing required variable.

| Variable | Required | Purpose |
|---|---|---|
| `RPC_URL` | Yes | Starknet RPC endpoint for all reads and signing |
| `BROKER_ACCOUNT_ADDRESS` / `BROKER_PRIVATE_KEY` | Yes | Broker's signing account for pool transactions |
| `OWNER_ADDRESS` | Yes | Owner identity whose on-chain policies are checked (distinct from the broker) |
| `VIEWING_KEY` | Yes | Viewing key registered with the pool; reveals the broker's shielded notes. Generate: `node scripts/generate-canonical-viewing-key.mjs` (enforces the pool's canonical-key `HALF_ORDER` bound) |
| `PRIVACY_POOL_ADDRESS` | Yes | STRK20 privacy pool contract |
| `POLICY_REGISTRY_ADDRESS` | Yes | `OxaPolicyRegistry` |
| `CREDENTIAL_ISSUER_ADDRESS` | Yes | `OxaCredentialIssuer` |
| `PORT` | Yes | Broker HTTP port (3000) |
| `STARKNET_CHAIN_ID` | No | `SN_SEPOLIA` (default) or `SN_MAIN` — selects the proving-provider chain |
| `PROVING_SERVICE_URL` | For pool ops | Self-hosted STRK20 prover (register/shield/mint/redeem/reclaim) |
| `INDEXER_URL` | No | Note indexer; empty ⇒ `ContractDiscoveryProvider` (pool RPC reads) |
| `ENDPOINT_ACCOUNT_ADDRESS` / `ENDPOINT_PRIVATE_KEY` / `ENDPOINT_PAYOUT_ADDRESS` | For MCP `oxa_call_endpoint` | Endpoint signing account and default payout address |
| `BROKER_BASE_URL` | No | Broker URL for the MCP server (default `http://localhost:3000`) |
| `INFERENCE_RELAY_URL` | No | When set, MCP forwards verified redemptions to the relay |
| `RELAY_PORT` / `MCP_PORT` | No | Inference relay / MCP listen ports (3001 / 3002) |
| `ALLOWED_ORIGIN` | No | CORS origin for broker + MCP (default: the GitHub Pages origin) |
| `ALLOWED_ORIGINS` | No | Comma-separated Origin allowlist for the MCP server; unset ⇒ all origins accepted with a warning |
| `OWNER_PRIVATE_KEY` | No | Reserved; not read by current code |

## Running

All service commands run from `broker/`. Sepolia flows read `broker/.env`; mainnet runners take config as runtime env vars and never touch `broker/.env`.

```bash
# Contracts — build + offline tests
cd contracts && scarb build && snforge test

# Broker HTTP API (port 3000): POST /request-credential, POST /reclaim-expired
cd broker && npm start          # or: npm run dev (ts-node, no build)

# MCP server (port 3002, Streamable HTTP at POST /mcp)
npm run mcp
claude mcp add --transport http oxa http://localhost:3002/mcp

# Inference relay (port 3001) — requires `npm run build` first
node scripts/inference-relay.mjs
```

Pool-operation scripts (require `PROVING_SERVICE_URL` and a funded account; proofs take minutes):

```bash
cd broker
node scripts/preflight.mjs                        # read-only: env, nonce, STRK balance, prover reachability
node scripts/register-broker.mjs                  # Sepolia register
node scripts/approve-pool.mjs                     # ERC-20 approve prerequisite for shield
node scripts/shield-strk.mjs                      # Sepolia shield
node scripts/check-notes.mjs                      # discover the broker's shielded notes
node --loader ts-node/esm scripts/run-mint.mjs    # Sepolia mint via mintCredential()
node --loader ts-node/esm scripts/run-redeem.mjs  # redeem from .data/credentials.json
node --loader ts-node/esm scripts/run-reclaim.mjs # reclaim via HttpOxaBroker.reclaimExpired
```

Mainnet twins (same arguments; pass mainnet env vars inline, e.g. `STARKNET_CHAIN_ID=SN_MAIN`):

```bash
node scripts/register-broker-mainnet.mjs
node scripts/shield-strk-mainnet.mjs
node scripts/check-notes-mainnet.mjs
node --loader ts-node/esm scripts/mint-mainnet.mjs   # BLOCKED — see Known Limitations
```

## SDK / API Usage

```ts
import { HttpOxaBroker, StarknetEndpointClient } from "@oxa/sdk";

// Agent side: request a scoped credential from the broker.
const broker = new HttpOxaBroker({ baseUrl: "http://localhost:3000" });
const credential = await broker.requestCredential({
  category: "inference",          // spend category from the owner's policy
  endpointId: "weather_relay",    // credential is bound to this endpoint ID
  amount: 500000000000000000n,    // raw u128 token units
  // modeOverride: "private",     // optional; a mode-locked category may forbid it
});
// credential: { credentialSecret, endpointId, issuerContract, token, amount, expiryTimestamp, mode }

// Endpoint side: redeem on-chain, once, before expiry.
const endpoint = new StarknetEndpointClient({
  rpcUrl: process.env.RPC_URL,
  issuerContract: "0x…",          // OxaCredentialIssuer address
  accountAddress: "0x…",          // endpoint's Starknet account
  privateKey: "0x…",
});
const { txHash, amount } = await endpoint.redeemCredential({
  credentialSecret: credential.credentialSecret,
  endpointId: credential.endpointId,
  payoutAddress: "0x…",
});
```

Broker HTTP API (what `HttpOxaBroker` calls): `POST /request-credential` `{ category, endpointId, amount, modeOverride? }` → `Credential` JSON; `400` policy rejection; `501` public mode (not implemented); `502` mint failure. `POST /reclaim-expired` `{ commitmentHash }` → `{ txHash }`.

## Contracts

Build and test from `contracts/` (Scarb workspace): `scarb build` (artifacts in `target/dev/`), `snforge test`.

Deployments were performed with the Starknet CLI (`sncast`); constructor args and post-deploy configuration are recorded in [`docs/deployments.md`](docs/deployments.md). Post-deploy, the owner sets `set_authorized_issuer(issuer)`, `set_category_policy`, `set_endpoint_allowed` — the issuer cannot call `record_spend` before `set_authorized_issuer`.

**Sepolia** (current — matches `broker/.env` and [`strk20.json`](strk20.json)):

- `docs/deployments.md` predates the current Sepolia issuer deployment and all mainnet activity — [`strk20.json`](strk20.json) is the authoritative address/tx record.

## Roadmap

- **Resolve mainnet Mint `INVALID_SIGNATURE`** — root cause not yet identified; the signed `__execute__` step reverts even though the unsigned `compile_actions` view of the same action bundle succeeds. Next step: isolate whether this is broker-side (signing/serialization) or a pool/SDK-side issue, potentially in coordination with the STRK20 SDK maintainers.
- **Open a self-channel for the mainnet deployer** — unblocks partial-amount mints (currently full-note-only due to `SUBCHANNEL_NOT_FOUND` on any surplus).
- **Run mainnet Redeem and Reclaim** — once Mint is unblocked, complete and verify the full mainnet lifecycle to match Sepolia.
- **Public-mode settlement** — implement the direct-withdraw path currently stubbed as `501 Not Implemented`.
- **Indexer service** — replace `ContractDiscoveryProvider`'s pool RPC reads with the parked indexer build (Decision 0006) for faster note discovery.
- **`docs/deployments.md` refresh** — bring it in line with the current Sepolia issuer and all mainnet deployments; `strk20.json` remains authoritative in the meantime.

## References
| Contract | Address |
|---|---|
| `OxaPolicyRegistry` | `0x039cc9515534d60c65e955139a4c092e66e3fd9fe788714f3afa730352c9c4a0` |
| `OxaCredentialIssuer` | `0x000370dd3087f8a474c1dac40636a02bef1c330a3905977fcf42962741fc4650` |
| STRK20 privacy pool (external) | `0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91` |
| STRK token | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |

**Mainnet**:

| Contract | Address | Notes |
|---|---|---|
| STRK20 privacy pool (external) | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` | Not OXA-deployed; register/shield/private-send call it |
| `OxaCredentialIssuer` | `0x04cffa828f59b34c98a124b05ef7874b206249635eaf4512417efee6fcf44c22` | Referenced by `broker/scripts/mint-mainnet.mjs`; on-chain `get_authorized_issuer` points here |

Full transaction history with hashes and verification notes: [`strk20.json`](strk20.json).

## Testing

| Command | What it exercises | Needs |
|---|---|---|
| `cd contracts && snforge test` | Registry policy/caps/authorization; issuer Mint/Redeem/Reclaim, error paths, commitment domain separation (pool caller mocked via `start_cheat_caller_address`) | Nothing — offline |
| `node scripts/preflight.mjs` | Env presence, account class, STRK balance, prover connectivity | Live RPC |
| `node scripts/check-notes.mjs` | Note discovery for the broker's viewing key | Live RPC, registered viewing key |
| `npx ts-node --transpile-only scripts/smoke-mint.ts` | Policy check + mint wiring up to the pool-write boundary | Live RPC; prover for the mint step |
| `node --loader ts-node/esm scripts/run-mint.mjs` | Full mint: proof, broadcast, issuer state | Live RPC, funded account, shielded note, prover |
| `node --loader ts-node/esm scripts/run-redeem.mjs` | Signed `redeem()` against the deployed issuer | Live RPC, funded account, minted credential in `.data/` |
| `node --loader ts-node/esm scripts/run-reclaim.mjs` | Full reclaim via the broker HTTP API | Broker running, expired credential in `.data/`, prover |

No TypeScript unit-test runner is configured; `sdk` and `broker` expose `typecheck`/`build` scripts only. The vendored SDK carries its own vitest suite.

## Security / Trust Model

- **Three distinct accounts** (Decision 0001): the owner sets policy, the broker signs pool transactions, the endpoint redeems. The broker is a custodian only for credential issuance; the owner's wallet, main viewing key, and balance are never touched by it.
- **Policy enforcement is two-layered.** The broker pre-checks the registry off-chain (read-only); the issuer independently re-checks on-chain during `privacy_invoke` (endpoint allowlist, per-request cap, rolling period cap via `record_spend`). Per Decision 0002's addendum, the on-chain recheck catches broker bugs but not a malicious broker lying about `owner`/`category` — the pool's unlinkability hides the real owner from the issuer, so broker compromise (T3) is mitigated only operationally, by keeping the broker's funded balance conservative.
- **Fund control.** Pool movements require the broker's account signature and a valid STARK proof. The issuer moves credential funds only via pool-settled open notes (reclaim) or the single `redeem()` transfer.
- **Credential secrecy.** Only commitments live on-chain. `credentialSecret`/`reclaimSecret` are random 128-bit values persisted to gitignored `broker/.data/credentials.json` after on-chain confirmation. Whoever holds `(credentialSecret, endpointId)` can redeem before expiry — custody of that pair governs the payout address chosen at redeem time.
- **Replay protection.** Single-use is enforced on-chain (`ALREADY_USED` on both redeem and reclaim); expiry by `get_block_timestamp() > entry.expiry_timestamp`; endpoint binding by `ENDPOINT_MISMATCH`.
- **Reclaim safety.** Requires the reclaim secret (Poseidon-verified against the stored commitment) and is impossible before expiry (`NOT_YET_EXPIRED`). The secret never leaves broker custody.
- **Viewing key.** Grants read access to the broker's shielded notes only. The pool enforces canonical keys (`< HALF_ORDER`); the generator script enforces this.
- **Deposit screening.** Protocol-enforced inside the pool's `privacy_invoke` path; self-hosting the prover does not bypass it. Credential issuance is additionally gated on discovering a valid screened note.
- **MCP surface.** Origin-checked against `ALLOWED_ORIGINS` when set (DNS-rebinding defense); unset `ALLOWED_ORIGINS` warns and accepts all origins — not production-safe.

## Known Limitations

- **Mainnet Mint is blocked.** Two distinct, now-separated issues (full detail in the STATUS header of [`broker/scripts/mint-mainnet.mjs`](broker/scripts/mint-mainnet.mjs)): (1) the deployer had no self-channel on the mainnet pool, so any surplus > 0 emitted a `CreateEncNote` that reverted with `SUBCHANNEL_NOT_FOUND` — resolved by minting the full note value (zero surplus); (2) the subsequent signed `__execute__` still reverts with `INVALID_SIGNATURE`, root cause not fully resolved. Mainnet Mint, Redeem, and Reclaim are **not implemented**.
- **No self-channel on mainnet** ⇒ no partial-amount mints; the workaround is full-note-only minting until the deployer opens a self-channel and registers a STRK subchannel on it.
- **Public-mode settlement** (direct withdraw to the endpoint, bypassing the issuer) is not implemented — `POST /request-credential` returns `501` for categories resolving to public mode.
- **The prover is an operational dependency.** Self-hosted, pinned to sequencer tag `APOLLO-0.14.3-RC.17` (0.14.4+ virtual-OS hashes are rejected on-chain); proving takes minutes on commodity hardware, hence the 5-minute SDK request timeout.
- **Note discovery** uses `ContractDiscoveryProvider` (pool RPC reads); the indexer service build is parked (Decision 0006), so `INDEXER_URL` is normally empty.
- **Mainnet RPC caveat:** some public endpoints (e.g. Lava) omit `state_diff_commitment` on historical block queries, breaking proof computation; a complete endpoint (e.g. Alchemy) is required.
- `docs/deployments.md` predates the current Sepolia issuer deployment and all mainnet activity — [`strk20.json`](strk20.json) is the authoritative address/tx record.

## References

- [`strk20.json`](strk20.json) — every verified transaction and deployed address (Sepolia lifecycle + mainnet register/shield/private-send)
- [`docs/deployments.md`](docs/deployments.md) — Sepolia deployment txs, constructor args, post-deploy config
- Decision records: [0001 authority mechanism](docs/decisions/0001-authority-mechanism.md) · [0002 on-chain policy recheck](docs/decisions/0002-onchain-policy-recheck.md) · [0004 privacy package grounding](docs/decisions/0004-privacy-package-grounding.md) · [0005 MCP agent demo](docs/decisions/0005-mcp-agent-demo.md) · [0006 proving service](docs/decisions/0006-proving-service-blocked.md)
- [`broker/.env.example`](broker/.env.example) — full configuration template
- [`.github/workflows/build-prover.yml`](.github/workflows/build-prover.yml) — prover image build and sequencer pin rationale
- Landing page: [`docs/index.html`](docs/index.html) (served at https://phllp-tanstic.github.io/oxa-protocol/)

## License

MIT — see [LICENSE](LICENSE).