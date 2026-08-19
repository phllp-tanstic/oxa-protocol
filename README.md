# OXA — Scoped Payment Credentials for Autonomous Agents

**Status:** Pre-build. Architecture validation (Phase 0) in progress. No contracts deployed yet.

OXA is a scoped, single-use payment credential protocol for autonomous agents, funded from a shielded STRK20 balance and settled directly against crypto-native endpoints. Built for the STRK20 Private Sprint hackathon.

## What OXA Does

An OXA credential is a one-time claim right: a fixed amount of a specific ERC-20, locked behind a cryptographic commitment, redeemable exactly once, by exactly one endpoint, within a fixed time window. Owners shield funds once into the STRK20 pool, then issue scoped, single-use payment credentials on demand — one per purchase — with the choice, made per action, of whether that purchase settles privately or publicly.

Full architecture: see `docs/`.

## Status

This repository is being built in public per the hackathon rules. See `strk20.json` at the repo root for live transaction hashes, contract addresses, and demo links as they land — nothing in that file is populated yet.

## License

MIT (see `LICENSE`).