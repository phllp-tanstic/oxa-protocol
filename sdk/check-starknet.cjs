// Runtime verification that the installed starknet package exposes the
// exports OXA depends on.
const path = require('path');
let sn;
try {
  sn = require('starknet');
} catch (e) {
  console.error('FAIL: could not require("starknet"):', e.message);
  process.exit(1);
}

let version = 'unknown';
try {
  version = require(path.join('starknet', 'package.json')).version;
} catch (_e) {
  try {
    version = JSON.parse(
      require('fs').readFileSync(
        path.join(__dirname, 'node_modules', 'starknet', 'package.json'),
        'utf8',
      ),
    ).version;
  } catch (_e2) {
    /* keep 'unknown' */
  }
}

console.log('installed starknet version:', version);

let failures = 0;
for (const name of ['WalletAccountV6', 'strk20InvokeTransaction']) {
  const value = sn[name];
  const ok = value !== undefined;
  console.log(
    `${ok ? 'OK      ' : 'MISSING '} ${name} -> ${value === undefined ? 'undefined' : typeof value}`,
  );
  if (!ok) failures++;
}

// STRK20_ACTION is a TypeScript type-only export: it cannot exist at runtime.
// Verify it at the type level instead by checking the .d.ts declaration text.
const fs = require('fs');
const dts = fs.readFileSync(
  path.join(__dirname, 'node_modules', 'starknet', 'dist', 'index.d.ts'),
  'utf8',
);
const typeOk =
  /export \{[^}]*\btype STRK20_ACTION\b/.test(dts.replace(/\n/g, ' ')) ||
  /declare type STRK20_ACTION\b/.test(dts) ||
  /type STRK20_ACTION = /.test(dts);
console.log(
  `${typeOk ? 'OK      ' : 'MISSING '} STRK20_ACTION -> ${
    typeOk ? 'declared as a type export in index.d.ts (type-only by design)' : 'not found'
  }`,
);
if (!typeOk) failures++;

console.log(failures === 0 ? 'ALL_EXPORT_CHECKS_PASSED' : `EXPORT_CHECKS_FAILED=${failures}`);
process.exit(failures === 0 ? 0 : 1);
