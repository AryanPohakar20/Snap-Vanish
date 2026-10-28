import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALID_PERMISSIONS = new Set([
  'activeTab',
  'alarms',
  'background',
  'bookmarks',
  'browsingData',
  'certificateProvider',
  'clipboardRead',
  'clipboardWrite',
  'contentSettings',
  'contextMenus',
  'cookies',
  'debugger',
  'declarativeContent',
  'declarativeNetRequest',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
  'desktopCapture',
  'displayCapture',
  'dns',
  'documentScan',
  'downloads',
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys',
  'favicon',
  'fileBrowserHandler',
  'fileSystemProvider',
  'fontSettings',
  'gcm',
  'geolocation',
  'history',
  'identity',
  'identity.email',
  'idle',
  'loginState',
  'management',
  'nativeMessaging',
  'notifications',
  'offscreen',
  'pageCapture',
  'platformKeys',
  'power',
  'printerProvider',
  'printing',
  'privacy',
  'processes',
  'proxy',
  'readingList',
  'scripting',
  'search',
  'sessions',
  'sidePanel',
  'storage',
  'system.cpu',
  'system.display',
  'system.memory',
  'system.storage',
  'tabCapture',
  'tabGroups',
  'tabs',
  'topSites',
  'tts',
  'ttsEngine',
  'unlimitedStorage',
  'usb',
  'userScripts',
  'vpnProvider',
  'wallpaper',
  'webAuthenticationProxy',
  'webNavigation',
  'webRequest',
  'webRequestAuthProvider',
  'webRequestBlocking'
]);

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'preview/preview.html',
  'preview/preview.css',
  'preview/preview.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'content/content.js',
  'content/content-src.js',
  'content/pipeline.js',
  'content/absolute-cinema/controller.js',
  'content/vision-frame.html',
  'content/vision-frame.js',
  'lib/messages.js',
  'lib/settings.js',
  'lib/storage-keys.js',
  'lib/mediapipe-loader.js',
  'lib/mediapipe/tasks-vision/vision_bundle.mjs',
  'lib/mediapipe/wasm/vision_wasm_internal.js',
  'lib/mediapipe/wasm/vision_wasm_internal.wasm',
  'lib/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  'lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'vision/models/hand_landmarker.task',
  'vision/models/selfie_segmenter.tflite',
  'audio/audio-analyzer.js',
  'audio/mute-controller.js',
  'audio/snap-worklet.js',
  'effects/particle-system.js',
  'effects/renderer.js',
  'effects/shaders.js',
  'effects/state-machine.js',
  'assets/sounds/snap.wav',
  'assets/images/CINEMA.jpeg',
  'assets/icons/icon16.png',
  'assets/icons/icon32.png',
  'assets/icons/icon48.png',
  'assets/icons/icon128.png'
];

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function globToRegExp(pattern) {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function checkPng(file) {
  const data = readFileSync(file);
  return data.length > 8 && data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG';
}

function checkWav(file) {
  const data = readFileSync(file);
  return data.length > 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
}

function checkJpeg(file) {
  const data = readFileSync(file);
  return data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

export function validate({ root = ROOT, quiet = false } = {}) {
  const errors = [];
  const warnings = [];
  const log = quiet ? () => {} : (message) => console.log(message);

  const manifestPath = path.join(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('Missing manifest.json');
    return false;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Invalid manifest.json: ${error.message}`);
    return false;
  }

  const files = walk(root);
  const fileSet = new Set(files);

  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (!manifest.name) errors.push('manifest.name is required');
  if (!manifest.version) errors.push('manifest.version is required');
  if (!manifest.background || !manifest.background.service_worker) {
    errors.push('manifest.background.service_worker is required');
  }

  const permissions = manifest.permissions || [];
  for (const permission of permissions) {
    if (!VALID_PERMISSIONS.has(permission)) {
      errors.push(`Invalid or unsupported extension permission: ${permission}`);
    }
  }

  const manifestPaths = [];
  if (manifest.background?.service_worker) manifestPaths.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) manifestPaths.push(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons || {})) manifestPaths.push(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) manifestPaths.push(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) manifestPaths.push(file);
    for (const file of script.css || []) manifestPaths.push(file);
  }

  for (const file of manifestPaths) {
    if (!fileSet.has(file)) errors.push(`Manifest references missing file: ${file}`);
  }

  for (const resource of manifest.web_accessible_resources || []) {
    for (const pattern of resource.resources || []) {
      if (!pattern.includes('*')) {
        if (!fileSet.has(pattern)) errors.push(`Web accessible resource is missing: ${pattern}`);
        continue;
      }
      const matcher = globToRegExp(pattern);
      if (!files.some((file) => matcher.test(file))) {
        errors.push(`Web accessible resource pattern matches no files: ${pattern}`);
      }
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!fileSet.has(file)) errors.push(`Required project file is missing: ${file}`);
  }

  for (const file of [
    'assets/icons/icon16.png',
    'assets/icons/icon32.png',
    'assets/icons/icon48.png',
    'assets/icons/icon128.png'
  ]) {
    if (existsSync(path.join(root, file)) && !checkPng(path.join(root, file))) {
      errors.push(`Not a valid PNG: ${file}`);
    }
  }

  if (existsSync(path.join(root, 'assets/sounds/snap.wav')) && !checkWav(path.join(root, 'assets/sounds/snap.wav'))) {
    errors.push('Not a valid WAV: assets/sounds/snap.wav');
  }

  if (
    existsSync(path.join(root, 'assets/images/CINEMA.jpeg')) &&
    !checkJpeg(path.join(root, 'assets/images/CINEMA.jpeg'))
  ) {
    errors.push('Not a valid JPEG: assets/images/CINEMA.jpeg');
  }

  const contentBundle = path.join(root, 'content/content.js');
  if (existsSync(contentBundle)) {
    const source = readFileSync(contentBundle, 'utf8');
    if (/^\s*import\s/m.test(source)) {
      errors.push('content/content.js contains ES module import statements and will not run as a classic content script');
    }
    if (/^\s*export\s/m.test(source)) {
      errors.push('content/content.js contains ES module exports and will not run as a classic content script');
    }
  }

  const wasmPath = path.join(root, 'lib/mediapipe/wasm');
  if (existsSync(wasmPath)) {
    const wasmFiles = readdirSync(wasmPath);
    if (!wasmFiles.some((file) => file.endsWith('.wasm'))) {
      errors.push('No MediaPipe WASM binary found in lib/mediapipe/wasm');
    }
  }

  const popupHtml = path.join(root, 'popup/popup.html');
  if (existsSync(popupHtml)) {
    const html = readFileSync(popupHtml, 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      errors.push('popup/popup.html contains an inline script, which violates the extension CSP');
    }
  }

  const previewHtml = path.join(root, 'preview/preview.html');
  if (existsSync(previewHtml)) {
    const html = readFileSync(previewHtml, 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
      errors.push('preview/preview.html contains an inline script, which violates the extension CSP');
    }
  }

  if (!manifest.host_permissions || !manifest.host_permissions.length) {
    warnings.push('manifest.host_permissions is empty');
  }

  log(`Manifest: ${manifest.name} ${manifest.version}`);
  log(`Permissions: ${permissions.join(', ') || '(none)'}`);
  log(`Checked ${files.length} project files`);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);

  if (errors.length === 0) {
    log(`Validation passed (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
    return true;
  }
  console.error(`Validation failed with ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  return false;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (!validate()) process.exitCode = 1;
}
