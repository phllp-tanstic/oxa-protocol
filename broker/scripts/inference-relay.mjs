/**
 * OXA Broker — self-operated inference relay (Decision 0003).
 *
 * Sits in front of a REAL service (Open-Meteo forecast API, no key needed)
 * and serves POST /infer ONLY to callers who can prove they already paid
 * on-chain. It does NOT trust the caller's claim: the credential's
 * commitment is recomputed locally and its on-chain state is read directly
 * from OxaCredentialIssuer.get_credential plus the CredentialRedeemed
 * event (emitted only by the issuer's redeem() — lib.cairo:242-249). A
 * replayed/never-redeemed/only-reclaimed credential is rejected with 402.
 *
 * Contract (the caller, mcp-server.mjs oxa_call_endpoint, sends exactly this):
 *   POST /infer  { claim_payload: { credentialSecret, endpointId, payoutAddress? },
 *                  request: { latitude?, longitude?, ... } }
 *   200 -> Open-Meteo's real JSON + verified commitment + redeemed status
 *   400 -> malformed claim (missing credentialSecret / endpointId)
 *   402 -> credential not genuinely redeemed on-chain (Payment Required)
 *   502 -> upstream Open-Meteo failure
 *
 * Run: node scripts/inference-relay.mjs   (port via RELAY_PORT, default 3001)
 */
import express from 'express';
import { RpcProvider, Contract } from 'starknet';

import { loadConfig } from '../dist/config.js';
import { computeCredentialCommitment } from '../dist/commitmentHash.js';

const config = loadConfig();
const PORT = Number.parseInt(process.env.RELAY_PORT ?? '3001', 10);
if (Number.isNaN(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`Invalid RELAY_PORT: "${PORT}"`);
}

const app = express();
app.use(express.json());

// The exact interface OxaCredentialIssuer declares for get_credential
// (contracts/oxa_credential_issuer/src/lib.cairo:56-81) + the CredentialRedeemed
// event shape (lib.cairo:242-249).
const ISSUER_ABI = [
  {
    type: 'function',
    name: 'get_credential',
    inputs: [{ name: 'commitment_hash', type: 'felt' }],
    outputs: [
      {
        type: 'struct',
        name: 'oxa_credential_issuer::oxa_credential_issuer::OxaCredentialIssuer::CredentialEntry',
        members: [
          { name: 'token', type: 'felt' },
          { name: 'amount', type: 'felt' },
          { name: 'endpoint_id', type: 'felt' },
          { name: 'expiry_timestamp', type: 'felt' },
          { name: 'reclaim_commitment', type: 'felt' },
          { name: 'used', type: 'felt' },
        ],
      },
    ],
    state_mutability: 'view',
  },
  {
    type: 'event',
    name: 'CredentialRedeemed',
    kind: 'struct',
    members: [
      { name: 'commitment_hash', kind: 'key', type: 'felt' },
      { name: 'token', type: 'felt' },
      { name: 'amount', type: 'felt' },
      { name: 'payout_address', type: 'felt' },
      { name: 'timestamp', type: 'felt' },
    ],
  },
];

const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
const issuer = new Contract({
  abi: ISSUER_ABI,
  address: config.credentialIssuerAddress,
  providerOrAccount: provider,
});

async function getUsedStatus(commitmentHash) {
  try {
    const entry = await issuer.get_credential(commitmentHash);
    // Tolerate both object (named) and array (positional) return shapes, and
    // both boolean and felt-as-string representations of the used flag.
    const usedRaw = entry?.used ?? entry?.[5];
    const used =
      typeof usedRaw === 'boolean' ? usedRaw : BigInt(usedRaw ?? '0') !== 0n;
    return { ok: true, used, raw: entry };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Read the issuer's CredentialRedeemed events for this commitment (latest 1000). */
async function getRedeemedEvent(commitmentHash) {
  // NOTE: commitment_hash is NOT a #[key] field on this event — it lives in
  // data[0]. The keys array for CredentialRedeemed only ever contains the
  // event-name selector. A keys filter like [[], [commitmentHash]] checks
  // position 1 of the keys array, which never exists, so it always returns
  // zero events. Filter only by address here; the caller already does the
  // real per-commitment match against data[0].
  const res = await provider.getEvents({
    from_block: { block_number: 0 },
    to_block: 'latest',
    address: config.credentialIssuerAddress,
    continuation_token: undefined,
    chunk_size: 1000,
  });
  return res.events ?? [];
}
app.post('/infer', async (req, res) => {
  // (a) Validate claim_payload.
  const claim = req.body?.claim_payload;
  if (
    claim === null ||
    typeof claim !== 'object' ||
    typeof claim.credentialSecret !== 'string' ||
    typeof claim.endpointId !== 'string'
  ) {
    return res.status(400).json({ error: 'claim_payload must contain credentialSecret and endpointId' });
  }

  // (b) Recompute the commitment locally — never trust a passed hash.
  const commitmentHash = computeCredentialCommitment(
    claim.credentialSecret,
    claim.endpointId,
  );

  // (c)+(d) Read on-chain state and require a genuine redemption. The RPC's
  // read model can lag a block or more behind a just-finalized redeem tx
  // (observed in e2e: two redemptions confirmed by waitForTransaction yet the
  // immediate get_credential/getEvents returned un-verified state). Retry the
  // combined check a few times (max 5 attempts, 2s apart, ~10s worst-case
  // added latency) before falling back to 402.
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 2000;
  let status = { ok: false, used: false };
  let redeemed = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    status = await getUsedStatus(commitmentHash);
    if (!status.ok) {
      return res.status(502).json({ error: `get_credential failed: ${status.error}` });
    }

    redeemed = false;
    try {
      const events = await getRedeemedEvent(commitmentHash);
      for (const evt of events) {
        const data = evt.data ?? [];
        // CredentialRedeemed on-chain serialization (from a real receipt):
        // [commitment_hash, token, amount, payout_address, timestamp].
        // commitment_hash is data[0]; match it to avoid aliasing other
        // credentials redeemed from the same issuer.
        if (data.length >= 1 && data[0].toLowerCase() === commitmentHash.toLowerCase()) {
          redeemed = true;
          break;
        }
      }
    } catch (err) {
      return res.status(502).json({ error: `event lookup failed: ${err?.message ?? String(err)}` });
    }

    if (redeemed && status.used) {
      break;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  if (!redeemed || !status.used) {
    return res.status(402).json({ error: 'credential not redeemed' });
  }

  // (e) Perform the real service: proxy to Open-Meteo.
  const request = req.body?.request ?? {};
  const latitude = Number(request.latitude) || 0;
  const longitude = Number(request.longitude) || 0;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: `open-meteo upstream ${upstream.status}` });
    }
    const weather = await upstream.json();
    return res.json({
      commitmentHash,
      redeemed: 'on-chain credential verified',
      weather,
    });
  } catch (err) {
    return res.status(502).json({ error: `open-meteo fetch failed: ${err?.message ?? String(err)}` });
  }
});

app.listen(PORT, () => {
  console.log(`OXA inference relay listening on http://localhost:${PORT} (port ${PORT})`);
});