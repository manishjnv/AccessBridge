/**
 * EnvironmentSensor — ambient-light (webcam) + ambient-noise (microphone) sampler.
 *
 * Privacy-first: raw images and audio are passed to a pure function and discarded
 * in the same tick. Only the derived single-number snapshot leaves this module.
 * The sensor auto-degrades: if permissions are denied, time-of-day and (if
 * available) navigator.connection continue to emit snapshots.
 */

import type { EnvironmentSnapshot, NetworkQuality } from '@accessbridge/core/types';
import {
  calculateBrightness,
  calculateNoiseLevel,
  inferNetworkQualityFromEffectiveType,
} from '@accessbridge/core/signals';

export interface EnvironmentSensorOptions {
  lightSamplingEnabled: boolean;
  noiseSamplingEnabled: boolean;
  /** Interval between snapshots in ms (light uses 2x this, noise uses 1x by default). */
  samplingIntervalMs: number;
}

type SnapshotCallback = (snapshot: EnvironmentSnapshot) => void;

const DEFAULT_LIGHT_INTERVAL_MS = 30_000;
const DEFAULT_NOISE_INTERVAL_MS = 15_000;
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user', width: 160, height: 120 },
  audio: false,
};
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  video: false,
  audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
};

function currentTimeOfDay(): EnvironmentSnapshot['timeOfDay'] {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function currentNetworkQuality(): NetworkQuality {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number };
  };
  const conn = nav.connection;
  return inferNetworkQualityFromEffectiveType(conn?.effectiveType, conn?.downlink);
}

export class EnvironmentSensor {
  private readonly options: EnvironmentSensorOptions;
  private readonly listeners = new Set<SnapshotCallback>();
  private latest: EnvironmentSnapshot | null = null;
  private latestLight: number | null = null;
  private latestNoise: number | null = null;

  private running = false;
  private lightStream: MediaStream | null = null;
  private noiseStream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private sampleBuffer: Float32Array | null = null;

  private lightTimer: ReturnType<typeof setInterval> | null = null;
  private noiseTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  private lightDenied = false;
  private noiseDenied = false;

  constructor(options: Partial<EnvironmentSensorOptions> = {}) {
    this.options = {
      lightSamplingEnabled: options.lightSamplingEnabled ?? true,
      noiseSamplingEnabled: options.noiseSamplingEnabled ?? true,
      samplingIntervalMs: options.samplingIntervalMs ?? DEFAULT_NOISE_INTERVAL_MS,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Time-of-day + network always work without permissions — emit an initial snapshot immediately.
    this.emit();

    // Re-emit snapshot at 2x noise interval so the main struggle detector sees fresh values.
    this.snapshotTimer = setInterval(() => this.emit(), this.options.samplingIntervalMs);

    if (this.options.lightSamplingEnabled) {
      await this.startLightSampling();
    }
    if (this.options.noiseSamplingEnabled) {
      await this.startNoiseSampling();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.lightTimer) clearInterval(this.lightTimer);
    if (this.noiseTimer) clearInterval(this.noiseTimer);
    this.snapshotTimer = this.lightTimer = this.noiseTimer = null;

    this.releaseLight();
    this.releaseNoise();

    this.latestLight = null;
    this.latestNoise = null;
    this.lightDenied = false;
    this.noiseDenied = false;
  }

  getLatestSnapshot(): EnvironmentSnapshot | null {
    return this.latest;
  }

  onSnapshot(callback: SnapshotCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private async startLightSampling(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      this.lightStream = stream;

      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // Keep the video element off-DOM for privacy; readyState still fires.
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });
      await video.play().catch(() => {});
      this.video = video;

      this.canvas = document.createElement('canvas');
      this.canvas.width = 160;
      this.canvas.height = 120;
      this.canvasCtx = this.canvas.getContext('2d', { willReadFrequently: true });

      const sampleOnce = (): void => {
        if (!this.video || !this.canvasCtx || !this.canvas) return;
        try {
          this.canvasCtx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
          const frame = this.canvasCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
          // Pure function — frame data reference is not retained past this call.
          this.latestLight = calculateBrightness(frame);
        } catch {
          // Tabs backgrounded or video not ready — skip this sample.
        }
      };

      sampleOnce();
      this.lightTimer = setInterval(sampleOnce, DEFAULT_LIGHT_INTERVAL_MS);
    } catch {
      this.lightDenied = true;
      this.latestLight = null;
    }
  }

  private async startNoiseSampling(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      this.noiseStream = stream;

      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) throw new Error('AudioContext unavailable');

      this.audioContext = new AudioCtor();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.audioSource = this.audioContext.createMediaStreamSource(stream);
      this.audioSource.connect(this.analyser);
      this.sampleBuffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

      const sampleOnce = (): void => {
        if (!this.analyser || !this.sampleBuffer) return;
        this.analyser.getFloatTimeDomainData(this.sampleBuffer as Float32Array<ArrayBuffer>);
        // Pure function — raw samples copied into number only.
        this.latestNoise = calculateNoiseLevel(this.sampleBuffer);
      };

      sampleOnce();
      this.noiseTimer = setInterval(sampleOnce, DEFAULT_NOISE_INTERVAL_MS);
    } catch {
      this.noiseDenied = true;
      this.latestNoise = null;
    }
  }

  private releaseLight(): void {
    if (this.lightStream) {
      for (const track of this.lightStream.getTracks()) track.stop();
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this.lightStream = null;
    this.video = null;
    this.canvas = null;
    this.canvasCtx = null;
  }

  private releaseNoise(): void {
    if (this.audioSource) {
      try { this.audioSource.disconnect(); } catch { /* already disconnected */ }
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    if (this.noiseStream) {
      for (const track of this.noiseStream.getTracks()) track.stop();
    }
    this.audioSource = null;
    this.analyser = null;
    this.audioContext = null;
    this.noiseStream = null;
    this.sampleBuffer = null;
  }

  private emit(): void {
    const snapshot: EnvironmentSnapshot = {
      lightLevel: this.latestLight,
      noiseLevel: this.latestNoise,
      networkQuality: currentNetworkQuality(),
      timeOfDay: currentTimeOfDay(),
      sampledAt: Date.now(),
    };
    this.latest = snapshot;
    for (const cb of this.listeners) {
      try { cb(snapshot); } catch { /* isolate listener errors */ }
    }
  }

  /** Exposed for tests / indicator. */
  isLightDenied(): boolean { return this.lightDenied; }
  isNoiseDenied(): boolean { return this.noiseDenied; }
  isLightActive(): boolean { return this.lightStream !== null; }
  isNoiseActive(): boolean { return this.noiseStream !== null; }
}
