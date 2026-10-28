# Snap Vanish

Snap your fingers to vanish into a local dust effect and mute your outgoing microphone. Snap again to reassemble and restore the microphone. All camera, microphone, hand-tracking and segmentation work happens on your device. There is no backend, account, upload or telemetry.

## What is in this repository

- Manifest V3 Chrome extension (`manifest.json`)
- Local hand landmark and selfie segmentation models under `vision/models/`
- Bundled MediaPipe Tasks Vision WASM/runtime under `lib/mediapipe/`
- Isolated content script plus MAIN-world meeting adapter
- Local test preview at `preview/preview.html`
- Toolbar popup at `popup/popup.html`
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

The popup has a **Local preview** button. The preview uses the same pipeline with your camera and microphone, shows local model/asset diagnostics, and is the best place to verify the effect without joining a call.

Settings include sensitivity, effect duration, dust direction, audio confirmation, automatic room-plate capture, saved-background persistence, snap sound and a debug overlay. Settings are stored in `chrome.storage.local`.

## Privacy and permissions

- `storage` saves settings and an optional room plate.
- `offscreen` runs microphone transient analysis and sound playback without a visible page.
- `tabs` finds the active meeting or preview tab and routes commands.
- Host permissions are limited to the supported meeting sites.
- Camera frames, microphone samples, models and the room plate never leave the device. MediaPipe files are loaded from the extension package, not a CDN.

## Platform status

The adapter patches meeting `MediaStream` video tracks and disables the outgoing audio track while vanished. It is designed around the web clients of Google Meet, Microsoft Teams and Zoom Web.

Automated tests verify that the content script and meeting adapter initialize on a supported host and that the local pipeline completes a full vanish/return cycle. **Live outgoing-media behavior in a real Google Meet, Teams or Zoom call has not been validated in this repository** because that requires interactive meeting accounts and a second participant. Treat the meeting integration as requiring manual verification on your account and browser before relying on it. If a meeting client changes its DOM or media handling, the camera patch may not be detected; the preview remains usable and the overlay reports when the adapter is missing.

## Architecture

- `background.js` routes messages, tracks tab state, manages the offscreen document and stores settings.
- `content/meeting-adapter.js` runs in the page's MAIN world, wraps `getUserMedia`, replaces outgoing video tracks with a canvas track and controls outgoing audio track enablement.
- `content/content-src.js` runs in the isolated world, creates the overlay and a hidden vision iframe, and coordinates the adapter.
- `content/pipeline.js` owns the state machine, MediaPipe hand/segmentation inference, face-free background reconstruction and dust rendering.
- `effects/` contains the particle system, WebGL renderer, shaders and state machine.
- `audio/` contains the microphone transient analyzer, worklet and mute controller.
- `preview/` and `popup/` are native ES-module extension pages.
- `scripts/` contains asset generation, bundling, validation, tests and ZIP packaging.

## Tests

```powershell
npm test
```

This builds and validates the extension, runs Node unit tests, then launches the bundled Playwright Chromium with the extension loaded. The browser test uses fake media devices, loads the local preview, enables camera/microphone, captures a room plate, performs a full vanish/return cycle, routes a snap from the popup, updates live audio sensitivity, and checks content-script initialization against a routed fake Google Meet page.

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

- **No overlay on a meeting tab:** reload the tab after installing or rebuilding the extension. Confirm the URL is one of the supported hosts.
- **Overlay says the camera patch is unavailable:** the meeting client's media path was not detected. Use the local preview for diagnostics; platform-specific changes may need an adapter update.
- **Microphone analyzer does not start:** allow microphone access from the preview, then reopen the meeting. Chrome requires a user gesture/permission for capture.
- **Hand tracking does not start:** check the preview diagnostics. The effect still works from the Snap button, popup and keyboard shortcut.
- **Effect looks like a placeholder room:** capture a room plate while out of frame and keep `persistBackground` enabled.
