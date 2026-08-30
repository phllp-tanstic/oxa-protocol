import express from 'express';
import type { RequestCredentialParams } from '@oxa/sdk';

import { loadConfig } from './config.js';
import { checkPolicy } from './policyCheck.js';
import { mintCredential } from './mint.js';
import { reclaimExpiredCredential } from './reclaim.js';

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
      modeOverride: params.modeOverride,
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

  const policy = policyResult.policy;
  const mode = policyResult.resolvedMode;
  if (policy === undefined || mode === undefined) {
    res.status(502).json({ error: 'policy check passed without full policy/mode — broker bug' });
    return;
  }

  // Public-mode issuance (direct withdraw to the endpoint, Blueprint §2.9) is
  // not wired yet — only the private/anonymizer route mints through the issuer.
  if (mode !== 'private') {
    res.status(501).json({
      error: `public-mode issuance not implemented yet (category resolves to '${mode}')`,
      policyCheckPassed: true,
    });
    return;
  }

  // 3+4. Real Mint via the STRK20 privacy pool: the SDK computes the STARK
  // proof, this service broadcasts the proof-carrying transaction, and only an
  // on-chain SUCCEEDED receipt produces a credential claim payload. No mock
  // (or partial) paths exist.
  try {
    const credential = await mintCredential({
      category: params.category,
      endpointId: params.endpointId,
      amount: params.amount,
      maxTtlSeconds: policy.maxTtlSeconds,
      ownerAddress: owner,
    });
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(
      JSON.stringify(credential, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  } catch (err) {
    console.error('mint failed:', err);
    res.status(502).json({
      error: `mint failed: ${err instanceof Error ? err.message : String(err)}`,
      policyCheckPassed: true,
    });
  }
});

app.post('/reclaim-expired', (req, res) => {
  const commitmentHash = req.body?.commitmentHash;
  if (typeof commitmentHash !== 'string' || commitmentHash.length === 0) {
    res.status(400).json({ error: 'commitmentHash (string) is required' });
    return;
  }

  try {
    reclaimExpiredCredential(commitmentHash)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch((err: unknown) => {
        console.error('reclaim failed:', err);
        res.status(502).json({
          error: `reclaim failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  } catch (err) {
    console.error('reclaim failed:', err);
    res.status(502).json({
      error: `reclaim failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

app.listen(config.port, () => {
  console.log(`OXA Broker listening on http://localhost:${config.port} (port ${config.port})`);
});
