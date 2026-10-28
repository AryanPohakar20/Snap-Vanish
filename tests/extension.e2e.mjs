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

async function sampleVideoElement(page, selector) {
  return page.evaluate((targetSelector) => {
    const video = document.querySelector(targetSelector);
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const width = 32;
    const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, width, height);
    return {
      width,
      height,
      pixels: Array.from(context.getImageData(0, 0, width, height).data)
    };
  }, selector);
}

async function waitForVideoSample(page, selector, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const sample = await sampleVideoElement(page, selector);
    if (sample) return sample;
    await delay(100);
  }
  throw new Error(`Timed out waiting for a video frame from ${selector}`);
}

async function sampleCanvasElement(page, selector) {
  return page.evaluate((targetSelector) => {
    const canvas = document.querySelector(targetSelector);
    if (!canvas || !canvas.width || !canvas.height) return null;
    const width = 32;
    const height = Math.max(1, Math.round((width * canvas.height) / canvas.width));
    const probe = document.createElement('canvas');
    probe.width = width;
    probe.height = height;
    const context = probe.getContext('2d', { alpha: false });
    context.drawImage(canvas, 0, 0, width, height);
    return {
      width,
      height,
      pixels: Array.from(context.getImageData(0, 0, width, height).data)
    };
  }, selector);
}

async function sampleImageAt(page, url, width, height, mirrored = false) {
  const pixels = await page.evaluate(
    async ({ imageUrl, targetWidth, targetHeight, mirror }) => {
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#000';
      context.fillRect(0, 0, targetWidth, targetHeight);
      const scale = Math.min(
        targetWidth / image.naturalWidth,
        targetHeight / image.naturalHeight
      );
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      context.save();
      if (mirror) {
        context.translate(targetWidth, 0);
        context.scale(-1, 1);
      }
      context.drawImage(
        image,
        (targetWidth - drawWidth) / 2,
        (targetHeight - drawHeight) / 2,
        drawWidth,
        drawHeight
      );
      context.restore();
      return Array.from(context.getImageData(0, 0, targetWidth, targetHeight).data);
    },
    { imageUrl: url, targetWidth: width, targetHeight: height, mirror: mirrored }
  );
  return pixels;
}

function meanPixelDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const length = Math.min(a.length, b.length);
  let total = 0;
  let count = 0;
  for (let index = 0; index < length; index += 4) {
    total += Math.abs(a[index] - b[index]);
    total += Math.abs(a[index + 1] - b[index + 1]);
    total += Math.abs(a[index + 2] - b[index + 2]);
    count += 3;
  }
  return count ? total / count : Number.POSITIVE_INFINITY;
}

async function sendCinema(popup, targetPage) {
  await targetPage.bringToFront();
  return popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'background', type: 'ABSOLUTE_CINEMA_SHOW' })
  );
}

async function waitForAdapterReady(popup, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let status = null;
  while (Date.now() < deadline) {
    status = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATUS' })
    );
    if (status && status.ok && status.active?.content?.adapterReady) return status;
    await delay(250);
  }
  return status;
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

    await delay(1000);
    const previewMemeUrl = `chrome-extension://${extensionId}/assets/images/CINEMA.jpeg`;
    await preview.bringToFront();
    const previewCinema = await sendCinema(popup, preview);
    assert.equal(previewCinema?.ok, true);
    await waitFor(preview.locator('#stageLabel'), (text) => /Absolute Cinema/i.test(text), 5000, 'preview cinema stage');

    await delay(300);
    const previewDuring = await sampleCanvasElement(preview, '#displayCanvas');
    const previewMeme = await sampleImageAt(
      preview,
      previewMemeUrl,
      previewDuring.width,
      previewDuring.height
    );
    const previewMemeDistance = meanPixelDistance(previewDuring.pixels, previewMeme);
    assert.ok(
      previewMemeDistance < 16,
      `preview canvas should show the meme (distance ${previewMemeDistance.toFixed(1)})`
    );

    await preview.locator('#snapBtn').click();
    await waitFor(preview.locator('#diagPipeline'), (text) => /DISINTEGRATING|VANISHED/.test(text), 5000, 'cinema vanish start');
    await waitFor(preview.locator('#diagPipeline'), (text) => /VANISHED/.test(text), 10000, 'cinema vanished state');

    const previewDuringVanish = await sampleCanvasElement(preview, '#displayCanvas');
    const previewVanishDistance = meanPixelDistance(previewDuringVanish.pixels, previewMeme);
    assert.ok(
      previewVanishDistance < 16,
      `meme must have visual priority over Snap Vanish (distance ${previewVanishDistance.toFixed(1)})`
    );

    await waitFor(preview.locator('#stageLabel'), (text) => /Vanished/i.test(text), 7000, 'cinema expiry');

    let previewRestoredDistance = 0;
    const previewRestoredDeadline = Date.now() + 5000;
    while (Date.now() < previewRestoredDeadline) {
      const previewRestored = await sampleCanvasElement(preview, '#displayCanvas');
      previewRestoredDistance = meanPixelDistance(previewRestored.pixels, previewMeme);
      if (previewRestoredDistance > 20) break;
      await delay(150);
    }
    assert.ok(
      previewRestoredDistance > 20,
      `preview should leave cinema and keep the current Snap Vanish frame (distance ${previewRestoredDistance.toFixed(1)})`
    );
    assert.match(await preview.locator('#diagPipeline').textContent(), /VANISHED/);

    await preview.locator('#snapBtn').click();
    await waitFor(preview.locator('#diagPipeline'), (text) => /REASSEMBLING|VISIBLE/.test(text), 5000, 'return after cinema');
    await waitFor(preview.locator('#diagPipeline'), (text) => /VISIBLE \(ready\)/.test(text), 10000, 'visible after cinema');

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

test('absolute cinema renders on the outgoing meeting canvas and restores it', { timeout: 120000 }, async () => {
  const app = await launchExtension();
  const { context, extensionId, errors, watchPage } = app;

  try {
    const html = `<!doctype html>
      <html><head><meta charset="utf-8"><title>Fake Google Meet</title></head>
      <body>
        <h1>Fake meeting</h1>
        <video id="out" autoplay playsinline muted></video>
        <script>
          window.__sv = {
            stream: null,
            videoTrack: null,
            audioTrack: null,
            ready: false
          };
          window.__startCamera = async () => {
            if (window.__sv.stream) return window.__sv.stream.id;
            const stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 640 }, height: { ideal: 480 } },
              audio: true
            });
            const video = document.getElementById('out');
            video.muted = true;
            video.srcObject = stream;
            await video.play();
            window.__sv.stream = stream;
            window.__sv.videoTrack = stream.getVideoTracks()[0];
            window.__sv.audioTrack = stream.getAudioTracks()[0];
            window.__sv.ready = true;
            return stream.id;
          };
        </script>
      </body></html>`;

    await context.route('https://meet.google.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    );

    const meeting = await context.newPage();
    watchPage(meeting, 'meeting');
    await meeting.goto('https://meet.google.com/absolute-cinema-test');
    await meeting.waitForSelector('#snap-vanish-root', { state: 'attached', timeout: 20000 });

    const popup = await context.newPage();
    watchPage(popup, 'popup');
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#cinemaBtn');
    assert.match(await popup.locator('#cinemaBtn').textContent(), /Absolute Cinema/);

    await meeting.bringToFront();
    const readyStatus = await waitForAdapterReady(popup);
    assert.equal(readyStatus?.ok, true);
    assert.equal(readyStatus?.active?.content?.adapterReady, true);

    const noCamera = await sendCinema(popup, meeting);
    assert.equal(noCamera?.ok, false);
    assert.equal(noCamera?.reason, 'no-camera');

    await meeting.evaluate(() => window.__startCamera());
    await meeting.waitForFunction(
      () =>
        window.__sv.ready === true &&
        document.getElementById('out').readyState >= 2 &&
        document.documentElement.dataset.snapVanishStream === 'replaced',
      undefined,
      { timeout: 20000 }
    );
    await delay(400);

    const before = await meeting.evaluate(() => ({
      videoId: window.__sv.videoTrack.id,
      videoEnabled: window.__sv.videoTrack.enabled,
      videoState: window.__sv.videoTrack.readyState,
      audioId: window.__sv.audioTrack.id,
      audioEnabled: window.__sv.audioTrack.enabled,
      mic: document.documentElement.dataset.snapVanishMic
    }));
    assert.equal(before.videoState, 'live');
    assert.equal(before.videoEnabled, true);
    assert.equal(before.audioEnabled, true);
    assert.equal(before.mic, 'unmuted');

    const baseline = await waitForVideoSample(meeting, '#out');
    const memeUrl = `chrome-extension://${extensionId}/assets/images/CINEMA.jpeg`;

    const first = await sendCinema(popup, meeting);
    assert.equal(first?.ok, true);
    assert.equal(first?.restarted, false);
    await meeting.waitForFunction(
      () => document.documentElement.dataset.snapVanishAbsoluteCinema === 'on',
      undefined,
      { timeout: 5000 }
    );
    await delay(350);

    const during = await waitForVideoSample(meeting, '#out');
    const memePixels = await sampleImageAt(popup, memeUrl, during.width, during.height, true);
    const memeDistance = meanPixelDistance(during.pixels, memePixels);
    const baselineDistance = meanPixelDistance(baseline.pixels, memePixels);
    assert.ok(
      memeDistance < 18,
      `outgoing canvas should show the meme (distance ${memeDistance.toFixed(1)}, baseline ${baselineDistance.toFixed(1)})`
    );
    assert.ok(
      baselineDistance > memeDistance + 6,
      `the camera frame must differ from the meme (distance ${baselineDistance.toFixed(1)})`
    );

    await delay(1200);
    const second = await sendCinema(popup, meeting);
    assert.equal(second?.ok, true);
    assert.equal(second?.restarted, true);
    await delay(2200);

    const restarted = await waitForVideoSample(meeting, '#out');
    const restartedDistance = meanPixelDistance(restarted.pixels, memePixels);
    assert.ok(
      restartedDistance < 18,
      `restarted activation must keep the meme visible (distance ${restartedDistance.toFixed(1)})`
    );

    await meeting.waitForFunction(
      () => document.documentElement.dataset.snapVanishAbsoluteCinema === 'off',
      undefined,
      { timeout: 7000 }
    );
    let restoredDistance = 0;
    const restoredDeadline = Date.now() + 5000;
    while (Date.now() < restoredDeadline) {
      const restored = await waitForVideoSample(meeting, '#out');
      restoredDistance = meanPixelDistance(restored.pixels, memePixels);
      if (restoredDistance > memeDistance + 6) break;
      await delay(150);
    }
    assert.ok(
      restoredDistance > memeDistance + 6,
      `outgoing canvas should return to the camera (distance ${restoredDistance.toFixed(1)})`
    );

    const after = await meeting.evaluate(() => ({
      videoId: window.__sv.videoTrack.id,
      videoEnabled: window.__sv.videoTrack.enabled,
      videoState: window.__sv.videoTrack.readyState,
      audioId: window.__sv.audioTrack.id,
      audioEnabled: window.__sv.audioTrack.enabled,
      mic: document.documentElement.dataset.snapVanishMic
    }));
    assert.deepEqual(after, before);

    await context.route('https://example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><h1>Unsupported</h1></body></html>'
      })
    );
    const other = await context.newPage();
    watchPage(other, 'other');
    await other.goto('https://example.com/');
    await other.bringToFront();

    const unsupported = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'background', type: 'ABSOLUTE_CINEMA_SHOW' })
    );
    assert.equal(unsupported?.ok, false);
    assert.equal(unsupported?.reason, 'unsupported-tab');

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
