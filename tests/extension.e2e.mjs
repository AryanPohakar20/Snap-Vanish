import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(locator, matcher, timeout = 20000, label = 'text') {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = (await locator.textContent()) || '';
      if (matcher(last)) return last;
    } catch {
      // The page may still be navigating.
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.SNAP_E2E_HEADLESS === '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    ]
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId, 'extension service worker did not expose an id');

  const errors = [];
  const watchPage = (page, name) => {
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`${name} console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`${name} pageerror: ${error.message}`));
  };

  return {
    context,
    worker,
    extensionId,
    errors,
    watchPage,
    async close() {
      await context.close();
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome may still hold a profile lock briefly.
      }
    }
  };
}

test('extension loads and the preview survives a full vanish cycle', { timeout: 180000 }, async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'content', 'content.js')), 'run npm run build first');
  assert.ok(
    fs.existsSync(path.join(ROOT, 'vision', 'models', 'hand_landmarker.task')),
    'model assets are missing'
  );

  const app = await launchExtension();
  const { context, extensionId, errors, watchPage } = app;

  try {
    const popup = await context.newPage();
    watchPage(popup, 'popup');
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#enabled');
    assert.equal(await popup.locator('#enabled').isChecked(), true);
    assert.match(await popup.locator('#version').textContent(), /^v\d+\.\d+\.\d+/);

    const preview = await context.newPage();
    watchPage(preview, 'preview');
    await preview.goto(`chrome-extension://${extensionId}/preview/preview.html`);

    await waitFor(preview.locator('#diagPipeline'), (text) => /VISIBLE \(ready\)/.test(text), 30000, 'pipeline ready');
    assert.match(await preview.locator('#diagWasm').textContent(), /local/i);
    assert.match(await preview.locator('#diagHand').textContent(), /Ready \(local\)/);
    assert.match(await preview.locator('#diagSegmentation').textContent(), /Ready \(local\)/);

    await preview.locator('#mediaBtn').click();
    await waitFor(preview.locator('#stageLabel'), (text) => /Live/i.test(text), 20000, 'live preview');
    assert.match(await preview.locator('#sessionBadge').textContent(), /Running/);
    assert.match(await preview.locator('#cameraPermission').textContent(), /Granted/);
    assert.match(await preview.locator('#microphonePermission').textContent(), /Granted/);

    await preview.locator('#captureBtn').click();
    await waitFor(preview.locator('#diagPlate'), (text) => /Captured/i.test(text), 20000, 'room plate');

    await preview.locator('#snapBtn').click();
    await waitFor(preview.locator('#diagPipeline'), (text) => /DISINTEGRATING|VANISHED/.test(text), 5000, 'vanish start');
    await waitFor(preview.locator('#diagPipeline'), (text) => /VANISHED/.test(text), 10000, 'vanished state');

    await preview.locator('#snapBtn').click();
    await waitFor(preview.locator('#diagPipeline'), (text) => /REASSEMBLING|VISIBLE/.test(text), 5000, 'return start');
    await waitFor(preview.locator('#diagPipeline'), (text) => /VISIBLE \(ready\)/.test(text), 10000, 'visible again');

    await delay(1200);
    await preview.bringToFront();
    await popup.evaluate(() => document.getElementById('refreshBtn').click());
    await waitFor(popup.locator('#siteValue'), (text) => /Local preview/i.test(text), 10000, 'preview status in popup');

    await popup.evaluate(() => document.getElementById('snapBtn').click());
    await waitFor(popup.locator('#stateLabel'), (text) => /Vanish/i.test(text), 10000, 'popup trigger routed to preview');
    await waitFor(preview.locator('#diagPipeline'), (text) => /DISINTEGRATING|VANISHED/.test(text), 10000, 'popup-triggered vanish');
    await waitFor(preview.locator('#diagPipeline'), (text) => /VANISHED/.test(text), 10000, 'popup-triggered vanished state');
    await preview.locator('#snapBtn').click();
    await waitFor(preview.locator('#diagPipeline'), (text) => /VISIBLE \(ready\)/.test(text), 10000, 'visible after popup trigger');

    const audio = await preview.evaluate(async () => {
      const query = async () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'AUDIO_QUERY' });
      let current = await query();
      for (let attempt = 0; attempt < 30 && !(current && current.status && current.status.running); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        current = await query();
      }
      const updated = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'AUDIO_START',
        sensitivity: 82
      });
      const after = await query();
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'AUDIO_START', sensitivity: 55 });
      return { current, updated, after };
    });
    assert.equal(audio.current?.status?.running, true, 'offscreen microphone analyzer should be running');
    assert.equal(audio.updated?.status?.sensitivity, 82, 'sensitivity updates while running');
    assert.equal(audio.after?.status?.sensitivity, 82, 'offscreen analyzer reports updated sensitivity');

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join('\n')}`);
  } finally {
    await app.close();
  }
});

test('content script and meeting adapter initialize on a supported host', { timeout: 120000 }, async () => {
  const app = await launchExtension();
  const { context, extensionId, errors, watchPage } = app;

  try {
    const html = `<!doctype html>
      <html><head><meta charset="utf-8"><title>Fake Google Meet</title></head>
      <body>
        <h1>Fake meeting</h1>
        <button id="mic" aria-label="Mute microphone" type="button">Mute</button>
      </body></html>`;

    await context.route('https://meet.google.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    );

    const meeting = await context.newPage();
    watchPage(meeting, 'meeting');
    await meeting.goto('https://meet.google.com/fake-meeting');

    await meeting.waitForFunction(
      () => document.documentElement.dataset.snapVanishAdapter === 'meet',
      undefined,
      { timeout: 20000 }
    );
    await meeting.waitForSelector('#snap-vanish-root', { state: 'attached', timeout: 20000 });
    await meeting.waitForFunction(
      () => document.documentElement.dataset.snapVanishInit === 'yes',
      undefined,
      { timeout: 45000 }
    );

    const popup = await context.newPage();
    watchPage(popup, 'popup');
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await meeting.bringToFront();

    let status = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATUS' })
      );
      if (status && status.ok && status.active?.content?.adapterReady) break;
      await delay(250);
    }

    assert.equal(status?.ok, true);
    assert.equal(status.active.kind, 'meeting');
    assert.equal(status.active.site.id, 'meet');
    assert.equal(status.active.content.adapterReady, true);
    assert.equal(status.active.content.adapterTimedOut, false);
    assert.equal(status.active.content.visionReady, true);

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join('\n')}`);
  } finally {
    await app.close();
  }
});
