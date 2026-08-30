/**
 * OXA Broker — MCP server for Claude Code (Decision 0005).
 *
 * Exposes two tools:
 *   1. oxa_request_credential(category, endpointId, amount, modeOverride?)
 *        → POST the Broker's /request-credential; returns the claim payload
 *          (or the Broker's structured error, never a mock).
 *   2. oxa_call_endpoint(claimPayload, request)
 *        → performs the REAL on-chain redeem() via the SDK's
 *          StarknetEndpointClient (verified as a prerequisite), then forwards
 *          to the self-operated inference relay (Decision 0003) when
 *          INFERENCE_RELAY_URL is configured. Returns the relay response only
 *          after the redeem transaction is verified on-chain.
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (the transport Claude Code
 * uses for local MCP servers), per code.claude.com/docs/en/mcp. Nothing but
 * protocol messages is ever written to stdout; diagnostics go to stderr.
 *
 * Register with Claude Code:
 *   claude mcp add --transport stdio oxa -- node \
 *     /abs/path/oxa-protocol/broker/scripts/mcp-server.mjs
 */
import { createInterface } from 'node:readline';

import 'dotenv/config';
import { StarknetEndpointClient } from '@oxa/sdk';

const SERVER_INFO = { name: 'oxa-broker', version: '0.1.0' };
const BROKER_BASE_URL = (process.env.BROKER_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

function log(...args) {
  console.error('[oxa-mcp]', ...args);
}

/** JSON-RPC error helper (protocol error, not tool error). */
function rpcError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  );
}

async function handleToolsCall(name, args) {
  switch (name) {
    case 'oxa_request_credential': {
      const params = {
        category: args.category,
        endpointId: args.endpointId,
        amount: args.amount,
      };
      if (args.modeOverride !== undefined) params.modeOverride = args.modeOverride;
      const res = await fetch(`${BROKER_BASE_URL}/request-credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await res.text();
      return { text: body, isError: !res.ok };
    }
    case 'oxa_call_endpoint': {
      const claim = args.claimPayload;
      if (
        claim === null ||
        typeof claim !== 'object' ||
        typeof claim.credentialSecret !== 'string' ||
        typeof claim.endpointId !== 'string'
      ) {
        return { text: 'claimPayload must contain credentialSecret and endpointId', isError: true };
      }
      if (!process.env.RPC_URL || !process.env.CREDENTIAL_ISSUER_ADDRESS) {
        return {
          text: 'RPC_URL and CREDENTIAL_ISSUER_ADDRESS must be set for oxa_call_endpoint',
          isError: true,
        };
      }
      if (!process.env.ENDPOINT_ACCOUNT_ADDRESS || !process.env.ENDPOINT_PRIVATE_KEY) {
        return {
          text: 'ENDPOINT_ACCOUNT_ADDRESS and ENDPOINT_PRIVATE_KEY must be set for oxa_call_endpoint (a real signing account is required — no mocking)',
          isError: true,
        };
      }
      const payoutAddress =
        (claim.payoutAddress) ?? process.env.ENDPOINT_PAYOUT_ADDRESS;
      if (!payoutAddress) {
        return {
          text: 'payoutAddress missing from claimPayload and ENDPOINT_PAYOUT_ADDRESS unset',
          isError: true,
        };
      }

      // Real on-chain redeem (verified transaction, not simulated).
      const client = new StarknetEndpointClient({
        rpcUrl: process.env.RPC_URL,
        issuerContract: process.env.CREDENTIAL_ISSUER_ADDRESS,
        accountAddress: process.env.ENDPOINT_ACCOUNT_ADDRESS,
        privateKey: process.env.ENDPOINT_PRIVATE_KEY,
      });
      const redeem = await client.redeemCredential({
        credentialSecret: claim.credentialSecret,
        endpointId: claim.endpointId,
        payoutAddress,
      });
      log(`redeem confirmed: tx ${redeem.txHash} amount ${redeem.amount}`);

      const relayUrl = process.env.INFERENCE_RELAY_URL;
      if (!relayUrl) {
        return {
          text: JSON.stringify({
            redeemed: true,
            txHash: redeem.txHash,
            amount: redeem.amount.toString(),
            note: 'on-chain redeem verified; inference relay (Decision 0003) not configured — set INFERENCE_RELAY_URL to forward the request',
          }),
          isError: false,
        };
      }
      const relayRes = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_payload: claim, request: args.request ?? {} }),
      });
      return { text: await relayRes.text(), isError: !relayRes.ok };
    }
    case 'oxa_reclaim_expired': {
      const res = await fetch(`${BROKER_BASE_URL}/reclaim-expired`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitmentHash: args.commitmentHash }),
      });
      const body = await res.text();
      return { text: body, isError: !res.ok };
    }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('bad JSON-RPC line:', line);
      continue;
    }
    const { id, method, params } = msg ?? {};

    if (method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        }) + '\n',
      );
    } else if (method === 'notifications/initialized' || method === 'ping') {
      if (id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
      }
    } else if (method === 'tools/list') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'oxa_request_credential',
                description:
                  'Request a scoped, single-use OXA payment credential from the OXA Broker. POLICY-GATED: rejected unless the owner+category+endpoint policy allows it. Private-mode issuance mints via the STRK20 privacy pool.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', description: 'Spend category (e.g. inference)' },
                    endpointId: { type: 'string', description: 'Endpoint the credential is bound to' },
                    amount: { type: 'string', description: 'Amount in raw token units (decimal string)' },
                    modeOverride: { type: 'string', enum: ['private', 'public'] },
                  },
                  required: ['category', 'endpointId', 'amount'],
                },
              },
              {
                name: 'oxa_call_endpoint',
                description:
                  'Redeem an OXA credential ON-CHAIN (real transaction, verified before returning) and, when INFERENCE_RELAY_URL is set, forward the request to the self-operated inference relay. Returns the endpoint result only after the redeem is verified on-chain.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    claimPayload: {
                      type: 'object',
                      description: 'The OXA claim payload from oxa_request_credential',
                      properties: {
                        credentialSecret: { type: 'string' },
                        endpointId: { type: 'string' },
                        payoutAddress: { type: 'string' },
                      },
                      required: ['credentialSecret', 'endpointId'],
                    },
                    request: {
                      type: 'object',
                      description: 'Arbitrary request payload forwarded to the inference relay',
                    },
                  },
                  required: ['claimPayload'],
                },
              },
              {
                name: 'oxa_reclaim_expired',
                description:
                  'Reclaim an expired, unused OXA credential: returns the credential\'s locked amount to the Broker\'s shielded balance via the Broker\'s /reclaim-expired route. Only succeeds for credentials whose TTL has genuinely expired on-chain - an early attempt reverts NOT_YET_EXPIRED.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    commitmentHash: {
                      type: 'string',
                      description: 'Commitment hash of the expired, unused credential to reclaim',
                    },
                  },
                  required: ['commitmentHash'],
                },
              },
            ],
          },
        }) + '\n',
      );
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const out = await handleToolsCall(name, args);
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: out.text }], isError: out.isError },
          }) + '\n',
        );
      } catch (err) {
        log('tool call failed:', err);
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            },
          }) + '\n',
        );
      }
    } else {
      rpcError(id ?? null, -32601, `method not found: ${method}`);
    }
  }
}

main().catch((err) => {
  log('MCP server crashed:', err);
  process.exit(1);
});