(() => {
  if (window.__snapVanishAdapterInstalled) return;
  window.__snapVanishAdapterInstalled = true;

  const host = location.hostname.toLowerCase();
  let site = null;
  if (host === 'meet.google.com') site = { id: 'meet', name: 'Google Meet' };
  else if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    site = { id: 'teams', name: 'Microsoft Teams' };
  } else if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    site = { id: 'zoom', name: 'Zoom Web' };
  }
  if (!site) return;

  document.documentElement.dataset.snapVanishAdapter = site.id;

  const state = {
    session: null,
    enabled: false,
    initialized: false,
    settings: null,
    pipelineReady: false,
    framesInFlight: false,
    frameCounter: 0,
    activeAdapter: null,
    adapters: new Set(),
    audioTracks: new Set(),
    lastAudioReport: '',
    lastAudioReportAt: 0,
    lastError: null,
    unsupportedReason: null,
    readyAnnounced: false
  };

  function post(message, transfer) {
    const payload = { __snapVanish: true, session: state.session, ...message };
    try {
      window.postMessage(payload, '*', transfer || []);
    } catch (error) {
      state.lastError = error;
    }
  }

  function detectMutedState() {
    const live = [...state.audioTracks].filter((track) => track && track.readyState === 'live');
    return {
      hasTracks: live.length > 0,
      muted: live.length > 0 ? live.every((track) => !track.enabled) : false,
      trackCount: live.length,
      at: Date.now()
    };
  }

  function reportAudioState(force) {
    const current = detectMutedState();
    const signature = `${current.hasTracks}:${current.muted}:${current.trackCount}`;
    const now = Date.now();
    if (!force && signature === state.lastAudioReport) {
      return;
    }
    state.lastAudioReport = signature;
    state.lastAudioReportAt = now;
    post({ type: 'SV_AUDIO_STATE', audio: current });
    document.documentElement.dataset.snapVanishMic = current.muted ? 'muted' : 'unmuted';
  }

  function setMuted(muted) {
    for (const track of state.audioTracks) {
      try {
        track.enabled = !muted;
      } catch {
        // Ignore ended tracks.
      }
    }
    reportAudioState(true);
    return detectMutedState();
  }

  function registerAudioTracks(stream) {
    let changed = false;
    for (const track of stream.getAudioTracks()) {
      if (!state.audioTracks.has(track)) {
        state.audioTracks.add(track);
        changed = true;
        track.addEventListener('ended', () => {
          state.audioTracks.delete(track);
          reportAudioState(true);
        });
      }
    }
    if (changed) reportAudioState(true);
  }

  function wrapVideoTrack(canvasTrack, adapter) {
    try {
      const nativeApplyConstraints = canvasTrack.applyConstraints
        ? canvasTrack.applyConstraints.bind(canvasTrack)
        : null;
      const nativeStop = canvasTrack.stop ? canvasTrack.stop.bind(canvasTrack) : null;
      canvasTrack.applyConstraints = async (constraints) => {
        if (adapter.originalVideoTrack && adapter.originalVideoTrack.applyConstraints) {
          return adapter.originalVideoTrack.applyConstraints(constraints);
        }
        if (nativeApplyConstraints) return nativeApplyConstraints(constraints);
      };
      canvasTrack.stop = () => {
        try {
          if (nativeStop) nativeStop();
        } finally {
          adapter.cleanup();
        }
      };
    } catch {
      // Some Chrome builds do not allow shadowing native track methods.
    }
    return canvasTrack;
  }

  class StreamAdapter {
    constructor(originalStream) {
      this.id = `adapter-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      this.originalStream = originalStream;
      this.originalVideoTrack = originalStream.getVideoTracks()[0] || null;
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      this.video.setAttribute('aria-hidden', 'true');
      this.video.style.position = 'fixed';
      this.video.style.left = '-10000px';
      this.video.style.top = '0';
      this.video.style.width = '2px';
      this.video.style.height = '2px';
      this.video.style.opacity = '0';
      this.video.style.pointerEvents = 'none';
      this.video.srcObject = originalStream;
      document.documentElement.appendChild(this.video);

      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { alpha: false });
      this.canvas.width = 640;
      this.canvas.height = 360;
      this.outputStream = null;
      this.outputVideoTrack = null;
      this.processedFrame = null;
      this.processedAt = 0;
      this.lastFrameSentAt = 0;
      this.lastDrawWasProcessed = false;
      this.timer = null;
      this.reportedAudio = false;
      this.active = false;
      this.cleaned = false;

      this.configureCanvas();
      this.video.addEventListener('loadedmetadata', () => this.configureCanvas());
      this.video.addEventListener('resize', () => this.configureCanvas());
      this.video.addEventListener('emptied', () => this.cleanup());
      if (this.originalVideoTrack) {
        this.originalVideoTrack.addEventListener('ended', () => this.cleanup());
      }

      this.video.play().catch((error) => {
        state.lastError = error;
      });

      this.timer = setInterval(() => this.tick(), 33);
      state.adapters.add(this);
      state.activeAdapter = this;
      this.updateActivation();
    }

    configureCanvas() {
      const width = this.video.videoWidth || 640;
      const height = this.video.videoHeight || 360;
      if (width <= 1 || height <= 1) return;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      if (!this.outputStream && typeof this.canvas.captureStream === 'function') {
        this.outputStream = this.canvas.captureStream(30);
        const track = this.outputStream.getVideoTracks()[0];
        if (track) {
          track.contentHint = this.originalVideoTrack ? this.originalVideoTrack.contentHint : 'motion';
          this.outputVideoTrack = wrapVideoTrack(track, this);
        }
      }
    }

    getReplacementVideoTrack() {
      this.configureCanvas();
      if (!this.outputStream) {
        this.outputStream = this.canvas.captureStream
          ? this.canvas.captureStream(30)
          : null;
        if (this.outputStream) {
          const track = this.outputStream.getVideoTracks()[0];
          if (track) {
            track.contentHint = 'motion';
            this.outputVideoTrack = wrapVideoTrack(track, this);
          }
        }
      }
      return this.outputVideoTrack;
    }

    updateActivation() {
      const shouldBeActive =
        state.activeAdapter === this &&
        state.initialized &&
        state.enabled &&
        state.pipelineReady &&
        Boolean(this.originalVideoTrack) &&
        this.originalVideoTrack.readyState === 'live';
      this.active = shouldBeActive;
      document.documentElement.dataset.snapVanishEffect = shouldBeActive ? 'on' : 'off';
    }

    tick() {
      if (this.cleaned) return;
      try {
        this.configureCanvas();
        const now = Date.now();
        const processedFresh = this.processedFrame && now - this.processedAt < 1500;

        if (state.framesInFlight && now - this.lastFrameSentAt > 1600) {
          state.framesInFlight = false;
        }

        if (state.enabled && state.pipelineReady && state.activeAdapter === this && !state.framesInFlight) {
          if (this.video.readyState >= 2 && this.video.videoWidth > 1 && now - this.lastFrameSentAt > 38) {
            this.lastFrameSentAt = now;
            this.sendFrame(now);
          }
        }

        if (this.video.readyState >= 2) {
          this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
          this.lastDrawWasProcessed = false;
          if (processedFresh) {
            this.context.drawImage(
              this.processedFrame,
              0,
              0,
              this.canvas.width,
              this.canvas.height
            );
            this.lastDrawWasProcessed = true;
          }
        } else {
          this.context.fillStyle = '#101216';
          this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        if (this.processedFrame && !processedFresh) {
          try {
            this.processedFrame.close();
          } catch {
            // Ignore.
          }
          this.processedFrame = null;
        }
      } catch (error) {
        state.lastError = error;
      }
    }

    async sendFrame(timestamp) {
      state.framesInFlight = true;
      this.lastFrameSentAt = timestamp;
      const frameId = ++state.frameCounter;
      try {
        const bitmap = await createImageBitmap(this.video);
        post(
          {
            type: 'SV_FRAME',
            adapterId: this.id,
            frameId,
            timestamp,
            width: bitmap.width,
            height: bitmap.height,
            bitmap
          },
          [bitmap]
        );
      } catch (error) {
        state.lastError = error;
        state.framesInFlight = false;
      }
    }

    acceptProcessed(message) {
      if (this.cleaned) {
        if (message.bitmap && message.bitmap.close) message.bitmap.close();
        return;
      }
      if (this.processedFrame && this.processedFrame !== message.bitmap) {
        try {
          this.processedFrame.close();
        } catch {
          // Ignore.
        }
      }
      this.processedFrame = message.bitmap || null;
      this.processedAt = Date.now();
      state.framesInFlight = false;
    }

    cleanup() {
      if (this.cleaned) return;
      this.cleaned = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.processedFrame && this.processedFrame.close) {
        try {
          this.processedFrame.close();
        } catch {
          // Ignore.
        }
      }
      this.processedFrame = null;
      try {
        if (this.outputVideoTrack) this.outputVideoTrack.stop();
      } catch {
        // Ignore.
      }
      try {
        this.video.pause();
        this.video.srcObject = null;
        this.video.remove();
      } catch {
        // Ignore.
      }
      state.adapters.delete(this);
      if (state.activeAdapter === this) {
        state.activeAdapter = null;
        for (const adapter of state.adapters) {
          if (!adapter.cleaned) {
            state.activeAdapter = adapter;
            adapter.updateActivation();
            break;
          }
        }
      }
    }
  }

  const originalGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null;

  if (!originalGetUserMedia) {
    state.unsupportedReason = 'getUserMedia is unavailable in this browser';
    return;
  }

  async function patchedGetUserMedia(constraints) {
    const stream = await originalGetUserMedia(constraints);
    registerAudioTracks(stream);

    const wantsVideo = Boolean(constraints && constraints.video);
    const videoTrack = stream.getVideoTracks()[0];
    if (!wantsVideo || !videoTrack || typeof document.createElement('canvas').captureStream !== 'function') {
      return stream;
    }

    try {
      const adapter = new StreamAdapter(stream);
      const replacementTrack = adapter.getReplacementVideoTrack();
      if (!replacementTrack) return stream;
      adapter.updateActivation();
      const combined = new MediaStream();
      combined.addTrack(replacementTrack);
      for (const track of stream.getAudioTracks()) combined.addTrack(track);
      document.documentElement.dataset.snapVanishStream = 'replaced';
      return combined;
    } catch (error) {
      state.lastError = error;
      state.unsupportedReason = `Could not wrap camera stream: ${error.message}`;
      return stream;
    }
  }

  try {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: patchedGetUserMedia,
      configurable: true,
      writable: true
    });
  } catch (defineError) {
    try {
      navigator.mediaDevices.getUserMedia = patchedGetUserMedia;
    } catch (assignError) {
      state.unsupportedReason = `Could not patch getUserMedia: ${assignError.message || defineError.message}`;
      post({ type: 'SV_ADAPTER_ERROR', reason: state.unsupportedReason });
      return;
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__snapVanish !== true || event.source !== window) return;
    if (data.session && state.session && data.session !== state.session) return;

    if (data.type === 'SV_INIT') {
      state.session = data.session || state.session;
      state.initialized = true;
      state.enabled = Boolean(data.enabled);
      state.settings = data.settings || state.settings;
      state.pipelineReady = true;
      state.readyAnnounced = true;
      document.documentElement.dataset.snapVanishInit = 'yes';
      for (const adapter of state.adapters) adapter.updateActivation();
      reportAudioState(true);
    } else if (data.type === 'SV_CONFIG') {
      state.enabled = Boolean(data.enabled);
      state.settings = data.settings || state.settings;
      for (const adapter of state.adapters) adapter.updateActivation();
    } else if (data.type === 'SV_PROCESSED') {
      state.framesInFlight = false;
      const adapter = [...state.adapters].find((item) => item.id === data.adapterId);
      if (adapter) adapter.acceptProcessed(data);
      else if (data.bitmap && data.bitmap.close) data.bitmap.close();
    } else if (data.type === 'SV_SET_MUTED') {
      setMuted(Boolean(data.muted));
    } else if (data.type === 'SV_REQUEST_AUDIO_STATE') {
      reportAudioState(true);
    } else if (data.type === 'SV_CLIENT_HELLO') {
      post({
        type: 'SV_ADAPTER_READY',
        site,
        initialized: state.initialized,
        enabled: state.enabled,
        audio: detectMutedState(),
        adapterCount: state.adapters.size,
        unsupportedReason: state.unsupportedReason
      });
    } else if (data.type === 'SV_REQUEST_STATUS') {
      post({
        type: 'SV_STATUS',
        site,
        initialized: state.initialized,
        enabled: state.enabled,
        pipelineReady: state.pipelineReady,
        adapterCount: state.adapters.size,
        activeAdapter: state.activeAdapter ? state.activeAdapter.id : null,
        audio: detectMutedState(),
        streamReplaced: document.documentElement.dataset.snapVanishStream === 'replaced',
        error: state.lastError ? state.lastError.message : null,
        unsupportedReason: state.unsupportedReason
      });
    }
  });

  function announceReady() {
    post({
      type: 'SV_ADAPTER_READY',
      site,
      initialized: state.initialized,
      enabled: state.enabled,
      audio: detectMutedState(),
      adapterCount: state.adapters.size,
      unsupportedReason: state.unsupportedReason
    });
  }

  announceReady();
  const handshakeTimer = setInterval(() => {
    if (!state.initialized) announceReady();
    else if (Date.now() - state.lastAudioReportAt > 1500) reportAudioState(false);
  }, 700);

  window.addEventListener('beforeunload', () => {
    clearInterval(handshakeTimer);
    for (const adapter of [...state.adapters]) adapter.cleanup();
  });

  document.dispatchEvent(
    new CustomEvent('snap-vanish-adapter-ready', {
      detail: { site: site.id }
    })
  );
})();
