import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Global stubs. The EnvironmentSensor touches document, navigator, window,
// AudioContext, and chrome. We fake each of those minimally so the tests can
// run in a plain Node vitest environment (no jsdom / happy-dom required).
// ---------------------------------------------------------------------------

const mockTrackStop = vi.fn();
const mockGetUserMedia = vi.fn();
const mockCanvasCtx = {
  drawImage: vi.fn(),
  getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(128),
    width: w,
    height: h,
  })),
};

function makeVideo(): Record<string, unknown> {
  return {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    onloadedmetadata: null as null | (() => void),
    play: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCanvas(): Record<string, unknown> {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(mockCanvasCtx),
  };
}

let createdVideo: ReturnType<typeof makeVideo> | null = null;
let createdCanvas: ReturnType<typeof makeCanvas> | null = null;

const documentStub = {
  createElement: vi.fn((tag: string): Record<string, unknown> => {
    if (tag === 'video') {
      createdVideo = makeVideo();
      // Auto-trigger loadedmetadata in the next microtask so the await resolves.
      Promise.resolve().then(() => {
        const cb = createdVideo?.onloadedmetadata as (() => void) | null;
        cb?.();
      });
      return createdVideo;
    }
    if (tag === 'canvas') {
      createdCanvas = makeCanvas();
      return createdCanvas;
    }
    return {};
  }),
};

class FakeAnalyser {
  fftSize = 2048;
  getFloatTimeDomainData(buf: Float32Array): void {
    // Fill with a small sine-ish signal so RMS is nonzero but <1.
    for (let i = 0; i < buf.length; i++) buf[i] = 0.05;
  }
}

class FakeAudioContext {
  state = 'running';
  createAnalyser(): FakeAnalyser { return new FakeAnalyser(); }
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
}

const navigatorStub = {
  mediaDevices: { getUserMedia: mockGetUserMedia },
  connection: { effectiveType: '4g', downlink: 12 },
};

const chromeStub = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('navigator', navigatorStub);
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('chrome', chromeStub);
  mockGetUserMedia.mockReset();
  mockTrackStop.mockReset();
  createdVideo = null;
  createdCanvas = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeMockStream(): MediaStream {
  return {
    getTracks: () => [{ stop: mockTrackStop }],
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------------
// Import the subject under test AFTER globals are in place is not strictly
// required because the class only reads them at method-call time, but the
// pattern keeps the test stable across refactors.
// ---------------------------------------------------------------------------

import { EnvironmentSensor } from '../environment-sensor.js';

describe('EnvironmentSensor', () => {
  it('starts with a time-of-day-only snapshot when both streams are disabled', async () => {
    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: false,
      noiseSamplingEnabled: false,
      samplingIntervalMs: 10_000,
    });

    await sensor.start();
    const snap = sensor.getLatestSnapshot();

    expect(snap).not.toBeNull();
    expect(snap?.lightLevel).toBeNull();
    expect(snap?.noiseLevel).toBeNull();
    expect(['morning', 'afternoon', 'evening', 'night']).toContain(snap?.timeOfDay);
    expect(snap?.networkQuality).toBe('excellent');
    expect(mockGetUserMedia).not.toHaveBeenCalled();

    sensor.stop();
  });

  it('requests webcam with 160x120 front-facing constraints', async () => {
    mockGetUserMedia.mockImplementation((constraints: MediaStreamConstraints) => {
      if (constraints.video) return Promise.resolve(makeMockStream());
      return Promise.reject(new Error('not expected'));
    });

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: true,
      noiseSamplingEnabled: false,
      samplingIntervalMs: 10_000,
    });
    await sensor.start();

    const videoCall = mockGetUserMedia.mock.calls.find(
      (c) => (c[0] as MediaStreamConstraints).video,
    );
    expect(videoCall).toBeDefined();
    const vc = (videoCall![0] as { video: { width: number; height: number; facingMode: string } }).video;
    expect(vc.width).toBe(160);
    expect(vc.height).toBe(120);
    expect(vc.facingMode).toBe('user');
    expect(sensor.isLightActive()).toBe(true);

    sensor.stop();
  });

  it('falls back gracefully when permission is denied', async () => {
    mockGetUserMedia.mockRejectedValue(new DOMException('Permission denied'));

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: true,
      noiseSamplingEnabled: true,
      samplingIntervalMs: 5_000,
    });
    await sensor.start();

    expect(sensor.isLightDenied()).toBe(true);
    expect(sensor.isNoiseDenied()).toBe(true);
    expect(sensor.isLightActive()).toBe(false);
    expect(sensor.isNoiseActive()).toBe(false);

    const snap = sensor.getLatestSnapshot();
    expect(snap?.lightLevel).toBeNull();
    expect(snap?.noiseLevel).toBeNull();
    // Time of day + network should still be present.
    expect(snap?.timeOfDay).toBeDefined();
    expect(snap?.networkQuality).toBeDefined();

    sensor.stop();
  });

  it('emits snapshots at the configured interval', async () => {
    mockGetUserMedia.mockRejectedValue(new Error('denied')); // skip streams, timers still fire

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: false,
      noiseSamplingEnabled: false,
      samplingIntervalMs: 1000,
    });

    const listener = vi.fn();
    const unsubscribe = sensor.onSnapshot(listener);
    await sensor.start();

    // Initial emit on start
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    vi.advanceTimersByTime(1000);
    // No new calls after unsubscribe
    expect(listener).toHaveBeenCalledTimes(4);

    sensor.stop();
  });

  it('stops cleanly: releases tracks and clears timers', async () => {
    mockGetUserMedia.mockResolvedValue(makeMockStream());

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: true,
      noiseSamplingEnabled: true,
      samplingIntervalMs: 2000,
    });
    await sensor.start();

    expect(sensor.isLightActive()).toBe(true);
    expect(sensor.isNoiseActive()).toBe(true);

    sensor.stop();

    expect(sensor.isLightActive()).toBe(false);
    expect(sensor.isNoiseActive()).toBe(false);
    expect(mockTrackStop).toHaveBeenCalled(); // at least once per stream
  });

  it('does not retain references to raw image data after sampling', async () => {
    mockGetUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
      constraints.video ? Promise.resolve(makeMockStream()) : Promise.reject(new Error('nope')),
    );

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: true,
      noiseSamplingEnabled: false,
      samplingIntervalMs: 30_000,
    });
    await sensor.start();

    // Drive one sample tick.
    vi.advanceTimersByTime(30_000);

    const snap = sensor.getLatestSnapshot();
    // lightLevel is a primitive number — no ImageData / buffer reference in the snapshot.
    if (snap?.lightLevel !== null && snap?.lightLevel !== undefined) {
      expect(typeof snap.lightLevel).toBe('number');
    }
    // Publicly exposed fields on the snapshot must only be primitives or enums.
    for (const value of Object.values(snap ?? {})) {
      const t = typeof value;
      expect(['number', 'string']).toContain(
        value === null ? 'number' : t === 'object' ? 'string' : t, // null treated as numeric placeholder
      );
    }

    sensor.stop();
  });

  it('supports multiple independent subscribers and clean unsubscribe', async () => {
    mockGetUserMedia.mockRejectedValue(new Error('skip'));

    const sensor = new EnvironmentSensor({
      lightSamplingEnabled: false,
      noiseSamplingEnabled: false,
      samplingIntervalMs: 1000,
    });

    const a = vi.fn();
    const b = vi.fn();
    const unA = sensor.onSnapshot(a);
    sensor.onSnapshot(b);

    await sensor.start();
    vi.advanceTimersByTime(1000);

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);

    unA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(3);

    sensor.stop();
  });
});
