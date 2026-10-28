import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { name: 'build + validate', args: ['scripts/build.mjs'] },
  { name: 'unit tests', args: ['--test', 'tests/unit.test.mjs'] },
  { name: 'browser end-to-end test', args: ['tests/extension.e2e.mjs'] }
];

let failed = false;
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(process.execPath, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    console.error(result.error);
    failed = true;
    break;
  }
  if (result.status !== 0) {
    failed = true;
    break;
  }
}

if (failed) {
  console.error('\nTest run failed.');
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
