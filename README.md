# OXA — Scoped Payment Credentials for Autonomous Agents

**Status:** Both contracts (OxaPolicyRegistry, OxaCredentialIssuer) are deployed and live on Starknet Sepolia. The full credential lifecycle — broker registration, shield, mint, redeem, and reclaim of expired credentials — has been demonstrated end-to-end on testnet against the real STRK20 privacy pool. The MCP server for agent integration exists and is tested locally over Streamable HTTP; public hosting is in progress (Phase 3). No demo video yet.

This repository is being built in public per the hackathon rules. See `strk20.json` at the repo root for the exact transaction hashes and contract addresses (all verified on-chain via the RPC provider before inclusion) — that file is the source of truth for what has landed.

OXA is a scoped, single-use payment credential protocol for autonomous agents, funded from a shielded STRK20 balance and settled directly against crypto-native endpoints. Built for the STRK20 Private Sprint hackathon.

## What OXA Does

An OXA credential is a one-time claim right: a fixed amount of a specific ERC-20, locked behind a cryptographic commitment, redeemable exactly once, by exactly one endpoint, within a fixed time window. Owners shield funds once into the STRK20 pool, then issue scoped, single-use payment credentials on demand — one per purchase — with the choice, made per action, of whether that purchase settles privately or publicly.

Full architecture: see `docs/`.

## License

MIT (see `LICENSE`).