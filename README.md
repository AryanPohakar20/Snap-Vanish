# Snap Vanish

Snap your fingers to vanish into a local dust effect and mute your outgoing microphone. Snap again to reassemble and restore the microphone. The popup also includes **Absolute Cinema**, which puts a bundled meme on your outgoing camera for five seconds so meeting participants see it. All camera, microphone, hand-tracking and segmentation work happens on your device. There is no backend, account, upload or telemetry.

## What is in this repository

- Manifest V3 Chrome extension (`manifest.json`)
- Local hand landmark and selfie segmentation models under `vision/models/`
- Bundled MediaPipe Tasks Vision WASM/runtime under `lib/mediapipe/`
- Isolated content script plus MAIN-world meeting adapter
- Local test preview at `preview/preview.html`
- Toolbar popup at `popup/popup.html`, including Absolute Cinema
- Bundled Absolute Cinema meme at `assets/images/CINEMA.jpeg`
- Offscreen microphone transient analyzer and snap sound
- Asset generator, build, validation, test and packaging scripts

## Build and install

Requirements: Node.js 18 or newer, npm, and Chrome/Edge 116 or newer.

```powershell
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder. Reload the extension after rebuilding. Reload any open meeting tab so the content scripts are injected.

`npm run build` generates icons and the snap sound, bundles `content/content-src.js` into the classic content script `content/content.js`, then validates the manifest and all referenced files. Use `npm run watch` while editing the content script.

## Usage

1. Open the popup and enable Snap Vanish.
2. For a meeting, open Google Meet, Microsoft Teams Web or Zoom Web and reload the tab.
3. Capture a clean room plate while nobody is in frame. This is the background revealed when you vanish.
4. Snap your fingers near the microphone, press the overlay **Snap** button, use the popup, or press `Alt+Shift+V`.
5. Snap again to return.
6. Click **Absolute Cinema** in the popup or on the in-meeting overlay to draw the bundled meme on your outgoing camera for five seconds. Click it again during the cycle to restart the five seconds.

Absolute Cinema reuses the existing outgoing canvas and capture stream. It does not create another camera stream, replace the video track or change microphone state. While it is active, the meme has visual priority over the live camera and the Snap Vanish output, but the snap state machine, mute handling and pipeline continue. The normal camera or current Snap Vanish frame resumes when the five seconds end. The meme is pre-mirrored inside an isolated draw so meeting clients that mirror the outgoing camera image show the text in the correct orientation; the camera path is unchanged.

The popup has a **Local preview** button. The preview uses the same pipeline with your camera and microphone, shows local model/asset diagnostics, and is the best place to verify the effect without joining a call. The preview shows Absolute Cinema on its local display canvas too.

Settings include sensitivity, effect duration, dust direction, audio confirmation, automatic room-plate capture, saved-background persistence, snap sound and a debug overlay. Settings are stored in `chrome.storage.local`.

## Privacy and permissions

- `storage` saves settings and an optional room plate.
- `offscreen` runs microphone transient analysis and sound playback without a visible page.
- `tabs` finds the active meeting or preview tab and routes commands.
- Host permissions are limited to the supported meeting sites.
- Camera frames, microphone samples, models and the room plate never leave the device. MediaPipe files are loaded from the extension package, not a CDN.

## Platform status

The adapter patches meeting `MediaStream` video tracks and disables the outgoing audio track while vanished. It is designed around the web clients of Google Meet, Microsoft Teams and Zoom Web.

Automated tests verify that the content script and meeting adapter initialize on a supported host, that the local pipeline completes a full vanish/return cycle, and that Absolute Cinema reaches the outgoing capture stream on a fake meeting page. **Live outgoing-media behavior in a real Google Meet, Teams or Zoom call has not been validated in this repository** because that requires interactive meeting accounts and a second participant. Treat the meeting integration, including remote visibility of Absolute Cinema, as requiring manual verification on your account and browser before relying on it. If a meeting client changes its DOM or media handling, the camera patch may not be detected; the preview remains usable and the overlay reports when the adapter is missing.

## Architecture

- `background.js` routes messages, tracks tab state, manages the offscreen document and stores settings.
- `content/meeting-adapter.js` runs in the page's MAIN world, wraps `getUserMedia`, replaces outgoing video tracks with a canvas track and controls outgoing audio track enablement.
- `content/content-src.js` runs in the isolated world, creates the Snap Vanish UI and a hidden vision iframe, and coordinates the adapter and the Absolute Cinema timer.
- `content/absolute-cinema/controller.js` provides the shared five-second timer with restart and stale-callback guards.
- `content/meeting-adapter.js` also owns the final outgoing-canvas render switch used by Absolute Cinema.
- `content/pipeline.js` owns the state machine, MediaPipe hand/segmentation inference, face-free background reconstruction and dust rendering.
- `effects/` contains the particle system, WebGL renderer, shaders and state machine.
- `audio/` contains the microphone transient analyzer, worklet and mute controller.
- `preview/` and `popup/` are native ES-module extension pages.
- `scripts/` contains asset generation, bundling, validation, tests and ZIP packaging.

## Tests

```powershell
npm test
```

This builds and validates the extension, runs Node unit tests, then launches the bundled Playwright Chromium with the extension loaded. The browser tests use fake media devices to exercise the local preview and a routed fake Google Meet page. They cover a full vanish/return cycle, popup routing, live audio sensitivity, content-script initialization, Absolute Cinema rendering in the outgoing canvas, five-second expiry, repeated-activation restart, unchanged video/audio tracks, the no-camera error, and meme visual priority during a preview vanish.

Useful individual commands:

```powershell
npm run test:unit
npm run test:e2e
npm run validate
```

Set `SNAP_E2E_HEADLESS=1` to try the browser test in headless mode. The default uses a visible browser window because extension loading with fake media is the most reliable there.

## Package

```powershell
npm run zip
```

This builds, validates, stages the runtime files and writes `dist/snap-vanish-v<version>.zip`. The ZIP excludes tests, scripts, dependencies and build staging.

## Troubleshooting

- **Snap Vanish UI does not appear on a meeting tab:** reload the tab after installing or rebuilding the extension. Confirm the URL is one of the supported hosts.
- **Absolute Cinema says "Start your camera":** the meeting has not obtained a live camera stream yet, so there is no outgoing canvas to render into. Start your camera and try again.
- **The camera patch is unavailable:** the meeting client's media path was not detected. Use the local preview for diagnostics; platform-specific changes may need an adapter update.
- **Absolute Cinema works in the preview but not in a real call:** verify the meeting is using the patched camera stream and confirm with another participant. Real meeting clients are not exercised by the automated tests.
- **Microphone analyzer does not start:** allow microphone access from the preview, then reopen the meeting. Chrome requires a user gesture/permission for capture.
- **Hand tracking does not start:** check the preview diagnostics. The effect still works from the Snap button, popup and keyboard shortcut.
- **Effect looks like a placeholder room:** capture a room plate while out of frame and keep `persistBackground` enabled.
