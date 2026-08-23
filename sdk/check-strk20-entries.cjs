// Dual-entry check: does strk20InvokeTransaction resolve via CJS require()
// and/or via ESM import from the installed starknet package?
const path = require('path');

// --- CJS entry ---
let cjsResult = 'not attempted';
try {
  const sn = require('starknet');
  const keys = Object.keys(sn).filter((k) => /strk20/i.test(k));
  cjsResult = `typeof sn.strk20InvokeTransaction = ${typeof sn.strk20InvokeTransaction}; strk20* keys on CJS exports: [${keys.join(', ')}]`;
} catch (e) {
  cjsResult = `require failed: ${e.message}`;
}
console.log('CJS  require("starknet")          ->', cjsResult);

// --- ESM entry (dynamic import of the .mjs build) ---
(async () => {
  let esmResult = 'not attempted';
  try {
    const { pathToFileURL } = require('url');
    const mjsPath = require('path').join(__dirname, 'node_modules', 'starknet', 'dist', 'index.mjs');
    const mod = await import(pathToFileURL(mjsPath).href);
    const keys = Object.keys(mod).filter((k) => /strk20/i.test(k));
    esmResult = `typeof mod.strk20InvokeTransaction = ${typeof mod.strk20InvokeTransaction}; strk20* keys on ESM exports: [${keys.join(', ')}]`;
  } catch (e) {
    esmResult = `import failed: ${e.message}`;
  }
  console.log('ESM  import("starknet/dist/index.mjs") ->', esmResult);
})();
