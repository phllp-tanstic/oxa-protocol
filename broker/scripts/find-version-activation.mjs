// Binary-search Sepolia block headers for Starknet protocol-version transitions.
// Read-only RPC; prints block ranges where starknet_version changes.
import { RpcProvider } from "starknet";
import "dotenv/config";

const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL });

async function versionAt(n) {
  const b = await provider.getBlock(n);
  return { v: String(b.starknet_version), ts: b.timestamp };
}

async function main() {
  const head = await provider.getBlockNumber();
  console.log("head:", head);

  // Collect versions at sampled points, then binary-search each boundary.
  // First: find where "0.14.3" starts (searching backwards from head in jumps).
  const target = "0.14.3";
  let lo = 0; // assume oldest < target
  let hi = head;
  const vHead = await versionAt(head);
  console.log("head version:", vHead.v);
  if (vHead.v !== target) {
    console.log(`head is ${vHead.v}, not ${target}; nothing to search for target activation`);
    return;
  }
  // Exponential backoff to find a block older than the target's activation.
  let step = 10000;
  let probe = head - step;
  let oldest = await versionAt(probe);
  while (oldest.v === target && probe > 0) {
    hi = probe;
    step *= 2;
    probe = head - step;
    if (probe < 0) { probe = 0; }
    oldest = await versionAt(probe);
    console.log(`probe ${probe}: ${oldest.v}`);
  }
  console.log(`bracket found: [${probe}, ${hi}] — ${oldest.v} .. ${target}`);

  // Binary search for first block with version === target.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await versionAt(mid);
    if (r.v === target) { hi = mid; } else { lo = mid; }
  }
  const first = await versionAt(hi);
  const prev = await versionAt(lo);
  console.log(`ACTIVATION: ${target} first appears at block ${hi}`);
  console.log(`  block ${lo}: ${prev.v} (ts ${prev.ts}, ${new Date(prev.ts * 1000).toISOString()})`);
  console.log(`  block ${hi}: ${first.v} (ts ${first.ts}, ${new Date(first.ts * 1000).toISOString()})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", String(e).slice(0, 400));
    process.exit(1);
  });
