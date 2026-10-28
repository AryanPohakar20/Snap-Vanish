import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIRS = ['assets', 'audio', 'content', 'effects', 'lib', 'popup', 'preview', 'styles', 'vision'];
const PACKAGE_FILES = [
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'popup/popup.html',
  'README.md'
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function copyRecursive(source, target) {
  fs.cpSync(source, target, { recursive: true });
}

function main() {
  run(process.execPath, [path.join('scripts', 'build.mjs')]);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const distDir = path.join(ROOT, 'dist');
  const stageDir = path.join(distDir, 'snap-vanish');
  const zipName = `snap-vanish-v${manifest.version}.zip`;
  const zipPath = path.join(distDir, zipName);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const file of PACKAGE_FILES) {
    const source = path.join(ROOT, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(stageDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  for (const dir of PACKAGE_DIRS) {
    const source = path.join(ROOT, dir);
    if (fs.existsSync(source)) copyRecursive(source, path.join(stageDir, dir));
  }

  const scriptPath = path.join(ROOT, 'scripts', 'zip-staging.ps1');
  if (process.platform === 'win32') {
    fs.writeFileSync(
      scriptPath,
      [
        'param([string]$Source, [string]$Destination)',
        'if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }',
        'Compress-Archive -Path (Join-Path $Source "*") -DestinationPath $Destination -CompressionLevel Optimal'
      ].join('\n'),
      'utf8'
    );
    try {
      run('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Source',
        stageDir,
        '-Destination',
        zipPath
      ]);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  } else {
    run('zip', ['-qr', zipPath, '.'], { cwd: stageDir });
  }

  const stats = fs.statSync(zipPath);
  fs.rmSync(stageDir, { recursive: true, force: true });
  console.log(`\nCreated ${path.relative(ROOT, zipPath)} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
