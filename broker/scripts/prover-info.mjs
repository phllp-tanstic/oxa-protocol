// Interrogate the self-hosted prover: self-reported JSON-RPC specVersion.
// Read-only diagnostics; prints no secrets.
import "dotenv/config";

const base = process.env.PROVING_SERVICE_URL;

async function rpc(method, params = []) {
  const r = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: (await r.text()).slice(0, 600) };
}

for (const m of ["starknet_specVersion", "rpc_discover", "starknet_chainId"]) {
  try {
    const { status, body } = await rpc(m);
    console.log(`${m} -> HTTP ${status}: ${body}`);
  } catch (e) {
    console.log(`${m} -> FAILED: ${e?.cause?.code ?? String(e)}`);
  }
}
