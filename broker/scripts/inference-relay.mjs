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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Real ABI — loaded from sdk/src/abi/OxaCredentialIssuer.json (full Sierra
 * class; its `abi` array is extracted). The relay used to declare a
 * hand-written get_credential output struct instead, but starknet.js decodes
 * a hand-written output struct into only its FIRST member (observed:
 * {"<struct name>": "<token>"}), so `used` was always undefined → false and
 * every genuinely-redeemed credential was answered 402. Loading the real ABI
 * fixes the decode (verified: get_credential then returns used as a boolean).
 */
function loadIssuerAbi() {
  const candidates = [
    join(scriptsDir, '..', '..', 'sdk', 'src', 'abi', 'OxaCredentialIssuer.json'),
    join(scriptsDir, '..', '..', 'sdk', 'dist', 'abi', 'OxaCredentialIssuer.json'),
  ];
  let lastError;
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? parsed : parsed.abi;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not load OxaCredentialIssuer ABI (looked in ${candidates.join(', ')}): ${String(lastError)}`,
  );
}

const ISSUER_ABI = loadIssuerAbi();

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

/** Read the issuer's CredentialRedeemed events for this commitment (recent window, key-filtered). */
async function getRedeemedEvent(commitmentHash) {
  // NOTE: commitment_hash is NOT a #[key] field on this event — it lives in
  // data[0]. So we do NOT append it to the keys filter (a filter like
  // [[sel],[cmt]] matches keys[1], which never exists → 0 events); we match
  // data[0] client-side. keys[0] = the event-name selector,
  // 0x1215f4a9813f52ca5d747a3e0f68b2a3d96d9b84f623c7643964508ccd2ffa7
  // (verified on-chain: it is keys[0] of both observed CredentialRedeemed
  // receipts).
  //
  // The Alchemy RPC pages issuer event history from the earliest block in
  // ~81920-block slices (observed from block 0: each page returned empty
  // events with a token "N-0", N incrementing by 81920). A from-0 scan
  // therefore needs ~175 pages (~14.3M blocks) to reach today's events — far
  // too slow and easy to cap off early (the relay's original single-page read
  // always missed everything → always 402). Redemptions here always happen
  // seconds before this call (the MCP redeems on-chain then forwards), so
  // scan a recent window (latest - 5000 blocks ≈ hours of Sepolia) filtered
  // by the event selector: that returns the events in ONE small call
  // (observed), no pagination.
  const latest = await provider.getBlockNumber();
  const fromBlockNum = Math.max(0, latest - 5000);
  const keyFilter = [['0x1215f4a9813f52ca5d747a3e0f68b2a3d96d9b84f623c7643964508ccd2ffa7']];
  const events = [];
  let continuation;
  // Belt and braces: follow continuation tokens if the window overflows a page.
  for (let page = 0; page < 10; page++) {
    const opts = {
      from_block: { block_number: fromBlockNum },
      to_block: 'latest',
      address: config.credentialIssuerAddress,
      keys: keyFilter,
      chunk_size: 1000,
    };
    if (continuation !== undefined) opts.continuation_token = continuation;
    const res = await provider.getEvents(opts);
    events.push(...(res.events ?? []));
    continuation = res.continuation_token;
    if (!continuation) break;
  }
  return events;
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