import { ec } from "starknet";

const CURVE_ORDER = ec.starkCurve.CURVE.n;
const HALF_ORDER = CURVE_ORDER / 2n;

let key;
do {
  const raw = ec.starkCurve.utils.randomPrivateKey();
  key = BigInt("0x" + Buffer.from(raw).toString("hex")) % CURVE_ORDER;
} while (key >= HALF_ORDER);

console.log("VIEWING_KEY=" + key.toString());
