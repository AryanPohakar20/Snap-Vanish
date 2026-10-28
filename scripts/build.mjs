import { build, context } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAssets } from './generate-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(ROOT, 'content', 'content-src.js')],
  outfile: path.join(ROOT, 'content', 'content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info'
};

async function run() {
  generateAssets(ROOT, (message) => console.log(message));
  mkdirSync(path.join(ROOT, 'content'), { recursive: true });

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('Watching content-src.js for changes. Press Ctrl+C to stop.');
    return;
  }

  await build(options);
  const output = path.join(ROOT, 'content', 'content.js');
  if (!existsSync(output)) throw new Error('Build finished without producing content/content.js');
  console.log(`Built ${path.relative(ROOT, output)}`);

  const { validate } = await import('./validate.mjs');
  const ok = validate({ root: ROOT, quiet: false });
  if (!ok) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
