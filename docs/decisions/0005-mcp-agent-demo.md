# Decision 0005: Claude Code (via MCP) as the Demo Agent (Blueprint §3.4, §4.1)

**Status:** Resolved
**Date:** 2026-08-20

## Decision

The Broker service is exposed as an MCP server with two tools:
`oxa_request_credential(category, endpoint_id, amount)`, wrapping the
Broker's `requestCredential()` (Blueprint §3.4), and `oxa_call_endpoint
(claim_payload, request)`, which calls the self-operated inference relay
(Decision 0003) and only returns a result once a real `redeem()`
transaction is verified on-chain. Claude Code is connected to this server
as the demo's autonomous agent.

## Why

Blueprint §3.4/§4.1 require demonstrating an agent autonomously requesting
and redeeming credentials mid-task, without specifying which agent
framework. Verified directly against current Claude Code documentation
(not assumed from training data, per the product-self-knowledge skill):
Claude Code supports connecting to arbitrary custom MCP servers via
`claude mcp add`, and calls a connected server's tools autonomously
whenever a request maps to that tool's described capability — this is not
limited to Anthropic-provided integrations.

Using Claude Code instead of a bespoke demo script directly strengthens the
"Working Mainnet Product" rubric line ("runs, on mainnet, for a real
user"): the user is a real person using a real, widely-used agentic coding
product for an ordinary task, and the agent's decision to request and
spend a credential is genuinely autonomous, not scripted to look that way.

## What this changes

- Phase 2 (Off-Chain Services) gains one deliverable: a thin MCP-server
  wrapper around the Broker's existing `requestCredential()` call and the
  endpoint-relay call, alongside the Broker's own HTTP API (Blueprint
  §3.5) — not a replacement for it.
- The demo narrative (Blueprint §4.1) is now concrete: the "agent acts"
  beat is Claude Code, connected via MCP, autonomously deciding to call
  `oxa_request_credential` then `oxa_call_endpoint` mid-task.
- No change to on-chain contracts or the core Broker/SDK interfaces
  already specified in Blueprint §3.4.

## Sources

- https://code.claude.com/docs/en/mcp (Claude Code MCP reference)
- Blueprint §3.4, §4.1
- Decision 0003 (this repo, `docs/decisions/0003-demo-endpoint.md`)
