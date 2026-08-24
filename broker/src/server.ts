import { randomBytes } from 'node:crypto';

import express from 'express';
import type { RequestCredentialParams } from '@oxa/sdk';

import { loadConfig } from './config';
import { checkPolicy } from './policyCheck';
import { computeCredentialCommitment } from './commitmentHash';

const config = loadConfig();

const app = express();
app.use(express.json());

type Validation =
  | { ok: true; params: RequestCredentialParams }
  | { ok: false; error: string };

/**
 * Validate the request body against sdk RequestCredentialParams:
 *   { category: string, endpointId: string, amount: bigint, modeOverride?: 'private' | 'public' }
 * Over JSON, bigint arrives as a decimal or hex string (or a JSON number).
 */
function validateRequestCredentialBody(body: unknown): Validation {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const { category, endpointId, amount, modeOverride } = body as Record<string, unknown>;

  if (typeof category !== 'string' || category.length === 0 || category.length > 31) {
    return { ok: false, error: "'category' must be a non-empty short string (max 31 chars)" };
  }
  if (typeof endpointId !== 'string' || endpointId.length === 0) {
    return { ok: false, error: "'endpointId' must be a non-empty string" };
  }

  let amountBigInt: bigint;
  if (typeof amount === 'bigint') {
    amountBigInt = amount;
  } else if (typeof amount === 'number') {
    if (!Number.isInteger(amount) || amount < 0) {
      return { ok: false, error: "'amount' must be a non-negative integer" };
    }
    amountBigInt = BigInt(amount);
  } else if (typeof amount === 'string' && /^0x[0-9a-fA-F]+$/.test(amount)) {
    amountBigInt = BigInt(amount);
  } else if (typeof amount === 'string' && /^\d+$/.test(amount)) {
    amountBigInt = BigInt(amount);
  } else {
    return {
      ok: false,
      error: "'amount' must be a non-negative integer (JSON number, decimal or hex string)",
    };
  }

  if (modeOverride !== undefined && modeOverride !== 'private' && modeOverride !== 'public') {
    return { ok: false, error: "'modeOverride' must be 'private' or 'public' when present" };
  }

  const params: RequestCredentialParams = { category, endpointId, amount: amountBigInt };
  if (modeOverride !== undefined) params.modeOverride = modeOverride;
  return { ok: true, params };
}

app.post('/request-credential', async (req, res) => {
  // 1. Parse + validate against RequestCredentialParams.
  const validated = validateRequestCredentialBody(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const params = validated.params;

  // Policies are stored per (owner, category) in OxaPolicyRegistry and were
  // set on-chain under the separate Owner account (Decision 0001: Broker and
  // Owner are distinct identities). Policy lookups therefore use OWNER_ADDRESS
  // from .env — never the Broker's signing account.
  const owner = config.ownerAddress;

  // 2. Real off-chain policy pre-check — plain read-only RPC calls to the
  //    deployed OxaPolicyRegistry on Sepolia. No signing, no gas, no proving.
  let policyResult;
  try {
    policyResult = await checkPolicy({
      owner,
      category: params.category,
      endpointId: params.endpointId,
      amount: params.amount,
    });
  } catch (err) {
    res.status(502).json({
      error: `policy check failed against OxaPolicyRegistry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  if (!policyResult.allowed) {
    res.status(400).json({ error: policyResult.reason });
    return;
  }

  // 3. Fresh random secret for the credential commitment (crypto.randomBytes,
  //    NOT Math.random). The secret is returned to no one but the requester
  //    once minting exists; only the hash is echoed here.
  const secret = `0x${randomBytes(16).toString('hex')}`;
  const commitmentHash = computeCredentialCommitment(secret, params.endpointId);

  // 4. Mint is deliberately NOT implemented: the real STRK20 proving service
  //    URL has not been confirmed by the hackathon organizers yet, so there is
  //    nothing real to call. We do NOT fake a proving URL or a fake successful
  //    Mint response. Policy check + commitment are fully real and functional.
  res.status(501).json({
    error: 'policy check passed; mint blocked pending PROVING_SERVICE_URL from hackathon organizers',
    commitmentHash,
    policyCheckPassed: true,
  });
});

app.post('/reclaim-expired', (_req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

app.listen(config.port, () => {
  console.log(`OXA Broker listening on http://localhost:${config.port} (port ${config.port})`);
});
