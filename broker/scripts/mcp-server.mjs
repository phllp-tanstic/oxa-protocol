/**
 * OXA Broker — MCP server for Claude Code (Decision 0005).
 *
 * Exposes three tools:
 *   1. oxa_request_credential(category, endpointId, amount, modeOverride?)
 *        → POST the Broker's /request-credential; returns the claim payload
 *          (or the Broker's structured error, never a mock).
 *   2. oxa_call_endpoint(claimPayload, request)
 *        → performs the REAL on-chain redeem() via the SDK's
 *          StarknetEndpointClient (verified as a prerequisite), then forwards
 *          to the self-operated inference relay (Decision 0003) when
 *          INFERENCE_RELAY_URL is configured. Returns the relay response only
 *          after the redeem transaction is verified on-chain.
 *   3. oxa_reclaim_expired(commitmentHash)
 *        → POST the Broker's /reclaim-expired; returns the tx hash once the
 *          Broker's reclaim flow confirms on-chain.
 *
 * Transport: Streamable HTTP (MCP spec 2025-11-25). Single POST endpoint at
 * /mcp accepting JSON-RPC 2.0 messages. Stateless — no session ID handling.
 * The Origin header is validated against ALLOWED_ORIGINS (comma-separated)
 * to defend against DNS rebinding; if unset, a warning is logged and any
 * origin is accepted (suitable for hackathon evaluation only).
 *
 * Register with Claude Code:
 *   claude mcp add --transport http oxa http://localhost:3002/mcp
 *
 * Listen port: MCP_PORT env var (default 3002, must not collide with broker
 * port 3000 or inference relay port 3001).
 */
import express from 'express';

import 'dotenv/config';
import { StarknetEndpointClient } from '@oxa/sdk';

const SERVER_INFO = { name: 'oxa-broker', version: '0.1.0' };
const BROKER_BASE_URL = (process.env.BROKER_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

function log(...args) {
  console.error('[oxa-mcp]', ...args);
}

/** JSON-RPC error helper (protocol error, not tool error). Returns a response object. */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Tools list — shared by tools/list and the static declaration. */
function toolsList() {
  return [
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
        `Reclaim an expired, unused OXA credential: returns the credential's locked amount to the Broker's shielded balance via the Broker's /reclaim-expired route. Only succeeds for credentials whose TTL has genuinely expired on-chain - an early attempt reverts NOT_YET_EXPIRED.`,
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
  ];
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
async function dispatchMessage(msg) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'ping') {
    if (id !== undefined) {
      return { jsonrpc: '2.0', id, result: {} };
    }
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: toolsList() },
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const out = await handleToolsCall(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: out.text }], isError: out.isError },
      };
    } catch (err) {
      log('tool call failed:', err);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        },
      };
    }
  }

  return rpcError(id ?? null, -32601, `method not found: ${method}`);
}

/** Validate the Origin header against ALLOWED_ORIGINS. */
function checkOrigin(req, res, next) {
  const origin = req.get('Origin');
  const allowed = process.env.ALLOWED_ORIGINS;

  if (!allowed) {
    log('WARNING: ALLOWED_ORIGINS is not set — accepting all origins (unsafe for production)');
    next();
    return;
  }

  const allowedList = allowed.split(',').map((s) => s.trim());
  if (!origin || !allowedList.includes(origin)) {
    log(`Rejected request from origin: ${origin ?? '<none>'}`);
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next();
}

function startServer() {
  const app = express();
  const PORT = Number.parseInt(process.env.MCP_PORT ?? '3002', 10);

  if (Number.isNaN(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`Invalid MCP_PORT: "${process.env.MCP_PORT}"`);
  }

  app.use(express.json());

  // body-parser returns a raw HTML 500 on malformed JSON. Catch it and return
  // a proper JSON-RPC 400 so the client gets a protocol-level parse error.
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } });
      return;
    }
    next(err);
  });

  app.use(checkOrigin);

  app.post('/mcp', async (req, res) => {
    const body = req.body;

    // Handle JSON-RPC request(s): single object or batch array.
    let messages;
    if (Array.isArray(body)) {
      messages = body;
    } else if (body && typeof body === 'object' && body.jsonrpc === '2.0') {
      messages = [body];
    } else {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC: expected a JSON-RPC object or array' } });
      return;
    }

    try {
      const results = await Promise.all(messages.map((msg) => dispatchMessage(msg)));

      if (messages.length === 1) {
        // Single request — respond with a single JSON-RPC object.
        const result = results[0];
        if (result === null) {
          // Notification with no response needed.
          res.status(200).end();
        } else {
          res.status(200).json(result);
        }
      } else {
        // Batch — respond with an array (filter out null notification results).
        const nonNull = results.filter((r) => r !== null);
        res.status(200).json(nonNull);
      }
    } catch (err) {
      log('Unexpected dispatch error:', err);
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  });

  app.listen(PORT, () => {
    log(`OXA MCP server (Streamable HTTP) listening on http://localhost:${PORT}/mcp`);
  });
}

startServer();