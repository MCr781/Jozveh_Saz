/**
 * Jozveh Saz - Master Automated Self-Test Runner (Sprint 7 / Milestone 7)
 *
 * Runs the native Node 24 ESM test suites:
 * 1. Reference tests (reference/reference.test.js)
 * 2. Sprint 7 Core unit & integration tests (server/test/sprint7_core.test.js)
 * 3. Sprint 7 Full acceptance tests (server/test/sprint7_full.test.js)
 * 4. P0 security & money exploit regression suite (reference/p0_regression.mjs)
 *
 * Exit code: 0 when every check passes, 1 otherwise.
 *
 * Usage:
 *   node server/self_test.js
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

console.log('🧪 [SELF-TEST] Running Jozveh Saz Sprint 7 Test Suites...\n');

// 1. Run Node.js native test runner on all test suites
const testResult = spawnSync(
  process.execPath,
  [
    '--test',
    path.join(PROJECT_ROOT, 'reference/reference.test.js'),
    path.join(PROJECT_ROOT, 'server/test/sprint7_core.test.js'),
    path.join(PROJECT_ROOT, 'server/test/sprint7_full.test.js')
  ],
  {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env
  }
);

if (testResult.status !== 0) {
  console.error('\n❌ [SELF-TEST FAILED] One or more unit/integration tests failed.');
  process.exit(testResult.status || 1);
}

// 2. Run P0 security regression suite
console.log('\n🔒 [SELF-TEST] Running P0 exploit regression suite...\n');
const p0Result = spawnSync(
  process.execPath,
  [path.join(PROJECT_ROOT, 'reference/p0_regression.mjs'), '.'],
  {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env
  }
);

if (p0Result.status !== 0) {
  console.error('\n❌ [SELF-TEST FAILED] P0 regression suite failed.');
  process.exit(p0Result.status || 1);
}

console.log('\n✅ [SELF-TEST SUCCESS] All 30 tests and 8/8 P0 security checks passed cleanly!\n');
process.exit(0);
