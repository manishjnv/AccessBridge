/**
 * EyeTracker – webcam-based gaze cursor for AccessBridge.
 *
 * Detection strategy (prioritised):
 *   1. Chrome FaceDetector API (Shape Detection) – returns face bounding box
 *      and eye/mouth landmarks natively.  No external dependencies.
 *   2. Skin-colour centroid fallback – used when FaceDetector is unavailable
 *      (e.g. older Chrome or non-Chrome browsers).
 *
 * Common pipeline:
 *   - Opens webcam via getUserMedia.
 *   - Each frame, detects face and extracts a normalised gaze point.
 *   - Applies EMA smoothing and renders a gaze cursor overlay.
 *   - Supports 5-point calibration (4 corners + centre).
 *   - Optionally shows a small live webcam preview.
 */

// ---------------------------------------------------------------------------
// FaceDetector type declarations (Shape Detection API – not in lib.dom)
// ---------------------------------------------------------------------------

interface DetectedFace {
  boundingBox: DOMRectReadOnly;
  landmarks: ReadonlyArray<{
    type: 'eye' | 'mouth' | 'nose';
    locations: ReadonlyArray<{ x: number; y: number }>;
  }>;
}

interface FaceDetectorOptions {
  maxDetectedFaces?: number;
  fastMode?: boolean;
}

declare class FaceDetector {
  constructor(options?: FaceDetectorOptions);
  detect(image: ImageBitmapSource): Promise<DetectedFace[]>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

interface CalibrationPoint {
  screen: Point;  // target position on screen (normalised 0-1)
  face: Point;    // face centroid recorded during calibration
}

interface EyeTrackerOptions {
  /** Called whenever gaze position updates (pixels). */
  onGaze?: (x: number, y: number) => void;
  /** Called on unrecoverable error. */
  onError?: (message: string) => void;
  /** Show webcam preview thumbnail. Default true. */
  showPreview?: boolean;
  /** Smoothing factor 0-1; higher = smoother but more lag. Default 0.85. */
  smoothing?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALIBRATION_TARGETS: ReadonlyArray<Point> = [
  { x: 0.05, y: 0.05 },   // top-left
  { x: 0.95, y: 0.05 },   // top-right
  { x: 0.5,  y: 0.5  },   // centre
  { x: 0.05, y: 0.95 },   // bottom-left
  { x: 0.95, y: 0.95 },   // bottom-right
];

const CALIBRATION_DWELL_MS = 2_000;
const GAZE_CURSOR_RADIUS = 30;

/** Processing canvas dimensions – smaller = faster. */
const PROC_WIDTH  = 160;
const PROC_HEIGHT = 120;

/** Skin-colour thresholds in RGB space (fallback detection). */
const SKIN_R_MIN = 60;
const SKIN_R_MAX = 255;
const SKIN_G_MIN = 30;
const SKIN_G_MAX = 220;
const SKIN_B_MIN = 20;
const SKIN_B_MAX = 200;
const SKIN_RG_DIFF = 10;
const SKIN_RB_DIFF = 20;

/** Throttle FaceDetector to every N-th frame (heavier than skin centroid). */
const FACE_DETECT_INTERVAL_MS = 60; // ~16 fps max

// ---------------------------------------------------------------------------
// EyeTracker
// ---------------------------------------------------------------------------

export class EyeTracker {
  // --- Core state ---
  private running   = false;
  private calibrating = false;
  private rafId: number | null = null;

  // --- Detection backend ---
  private useFaceDetector = false;
  private faceDetector: FaceDetector | null = null;
  private lastDetectTime = 0;
  private pendingDetect = false;

  // --- Media ---
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private procCanvas: HTMLCanvasElement | null = null;
  private procCtx: CanvasRenderingContext2D | null = null;

  // --- Tracking ---
  private restFace: Point = { x: PROC_WIDTH / 2, y: PROC_HEIGHT / 2 };
  private smoothGaze: Point = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private calibPoints: CalibrationPoint[] = [];
  private lastFacePoint: Point | null = null;

  // --- Calibration state ---
  private calibIndex = 0;
  private calibDwellStart = 0;
  private calibOverlay: HTMLElement | null = null;
  private calibDot: HTMLElement | null = null;
  private calibResolve: (() => void) | null = null;
  private calibProgressInterval: ReturnType<typeof setInterval> | null = null;

  // --- UI elements ---
  private gazeCursorEl: HTMLElement | null = null;
  private previewEl:    HTMLElement | null = null;

  // --- Options ---
  private readonly opts: Required<EyeTrackerOptions>;

  constructor(options: EyeTrackerOptions = {}) {
    this.opts = {
      onGaze:       options.onGaze       ?? (() => {}),
      onError:      options.onError      ?? (() => {}),
      showPreview:  options.showPreview  ?? true,
      smoothing:    options.smoothing    ?? 0.85,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width:  { ideal: 320 },
          height: { ideal: 240 },
          facingMode: 'user',
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      const msg = `EyeTracker: webcam access denied – ${err instanceof Error ? err.message : String(err)}`;
      this.opts.onError(msg);
      throw new Error(msg);
    }

    // Probe for FaceDetector API
    this.initDetectionBackend();

    this.buildDOM();
    this.running = true;
    this.startLoop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.stopCalibrationUI();

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    this.videoEl?.remove();
    this.videoEl = null;

    this.procCanvas?.remove();
    this.procCanvas = null;
    this.procCtx = null;

    this.gazeCursorEl?.remove();
    this.gazeCursorEl = null;

    this.previewEl?.remove();
    this.previewEl = null;

    this.faceDetector = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  calibrate(): Promise<void> {
    if (!this.running) {
      return Promise.reject(new Error('EyeTracker: call start() before calibrate()'));
    }

    return new Promise<void>((resolve) => {
      this.calibPoints  = [];
      this.calibIndex   = 0;
      this.calibResolve = resolve;
      this.calibrating  = true;
      this.showCalibrationOverlay();
      this.advanceCalibrationTarget();
    });
  }

  // -------------------------------------------------------------------------
  // Detection backend selection
  // -------------------------------------------------------------------------

  private initDetectionBackend(): void {
    try {
      if (typeof (globalThis as unknown as Record<string, unknown>).FaceDetector === 'function') {
        this.faceDetector = new FaceDetector({ maxDetectedFaces: 1, fastMode: true });
        this.useFaceDetector = true;
        console.log('[AccessBridge] Eye tracker: using FaceDetector API');
      } else {
        this.useFaceDetector = false;
        console.log('[AccessBridge] Eye tracker: FaceDetector unavailable, using skin-colour fallback');
      }
    } catch {
      this.useFaceDetector = false;
      console.log('[AccessBridge] Eye tracker: FaceDetector init failed, using skin-colour fallback');
    }
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  private buildDOM(): void {
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.autoplay  = true;
    video.playsInline = true;
    video.muted     = true;
    Object.assign(video.style, {
      position:   'fixed',
      top:        '-9999px',
      left:       '-9999px',
      width:      '1px',
      height:     '1px',
      opacity:    '0',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(video);
    this.videoEl = video;

    const canvas = document.createElement('canvas');
    canvas.width  = PROC_WIDTH;
    canvas.height = PROC_HEIGHT;
    Object.assign(canvas.style, {
      position:   'fixed',
      top:        '-9999px',
      left:       '-9999px',
      width:      '1px',
      height:     '1px',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(canvas);
    this.procCanvas = canvas;
    this.procCtx    = canvas.getContext('2d', { willReadFrequently: true })!;

    const cursor = document.createElement('div');
    cursor.className = 'ab-gaze-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.setAttribute('role', 'presentation');
    document.body.appendChild(cursor);
    this.gazeCursorEl = cursor;

    if (this.opts.showPreview) {
      this.buildPreview();
    }
  }

  private buildPreview(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'ab-webcam-preview';
    wrapper.title     = 'Eye tracker preview – click to hide';

    const previewVideo = document.createElement('video');
    previewVideo.srcObject  = this.stream;
    previewVideo.autoplay   = true;
    previewVideo.playsInline = true;
    previewVideo.muted      = true;
    previewVideo.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;transform:scaleX(-1);';

    const label = document.createElement('span');
    label.textContent = this.useFaceDetector ? 'Eye Tracker (FaceDetector)' : 'Eye Tracker (fallback)';
    label.style.cssText =
      'position:absolute;bottom:4px;left:0;right:0;text-align:center;' +
      'font:10px/1 system-ui,sans-serif;color:#fff;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none;';

    wrapper.appendChild(previewVideo);
    wrapper.appendChild(label);

    wrapper.addEventListener('click', () => {
      const hidden = previewVideo.style.visibility === 'hidden';
      previewVideo.style.visibility = hidden ? 'visible' : 'hidden';
      label.textContent = hidden
        ? (this.useFaceDetector ? 'Eye Tracker (FaceDetector)' : 'Eye Tracker (fallback)')
        : 'Eye Tracker (paused)';
    });

    document.body.appendChild(wrapper);
    this.previewEl = wrapper;
  }

  // -------------------------------------------------------------------------
  // Tracking loop
  // -------------------------------------------------------------------------

  private startLoop(): void {
    const tick = (): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this.processFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private processFrame(): void {
    const ctx   = this.procCtx;
    const video = this.videoEl;
    if (!ctx || !video || video.readyState < 2) return;

    // Draw downscaled mirrored frame to processing canvas
    ctx.save();
    ctx.translate(PROC_WIDTH, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, PROC_WIDTH, PROC_HEIGHT);
    ctx.restore();

    if (this.useFaceDetector && this.faceDetector) {
      this.processWithFaceDetector();
    } else {
      this.processWithSkinCentroid(ctx);
    }
  }

  // -------------------------------------------------------------------------
  // FaceDetector API path
  // -------------------------------------------------------------------------

  private processWithFaceDetector(): void {
    const now = Date.now();
    if (this.pendingDetect || now - this.lastDetectTime < FACE_DETECT_INTERVAL_MS) {
      // Use last known face point while waiting
      if (this.lastFacePoint) {
        this.applyFacePoint(this.lastFacePoint);
      }
      return;
    }

    this.pendingDetect = true;
    this.lastDetectTime = now;

    // FaceDetector.detect() works on ImageBitmapSource (canvas, video, etc.)
    this.faceDetector!.detect(this.procCanvas!)
      .then((faces) => {
        this.pendingDetect = false;
        if (!this.running) return;

        if (faces.length === 0) return; // no face – hold last position

        const face = faces[0];
        const gazePoint = this.extractGazeFromFace(face);
        this.lastFacePoint = gazePoint;
        this.applyFacePoint(gazePoint);
      })
      .catch(() => {
        this.pendingDetect = false;
        // FaceDetector failed this frame — fall through silently
      });
  }

  /**
   * Extract a normalised gaze-direction point from a detected face.
   *
   * If eye landmarks are available, compute gaze from eye positions relative
   * to the face bounding box.  If only the bounding box is available, fall
   * back to face-centre tracking (similar to skin centroid but more precise).
   */
  private extractGazeFromFace(face: DetectedFace): Point {
    const bb = face.boundingBox;
    const landmarks = face.landmarks;

    // Try to find eye landmarks
    const eyeLandmarks = landmarks.filter(l => l.type === 'eye');

    if (eyeLandmarks.length >= 2) {
      // We have both eyes — compute gaze from eye midpoint position
      // relative to face bounding box
      const allEyePoints = eyeLandmarks.flatMap(e => e.locations);
      const eyeMidX = allEyePoints.reduce((s, p) => s + p.x, 0) / allEyePoints.length;
      const eyeMidY = allEyePoints.reduce((s, p) => s + p.y, 0) / allEyePoints.length;

      // Normalise eye position within the face bounding box
      // When eyes shift left within the face → looking right (mirrored)
      const relX = (eyeMidX - bb.x) / bb.width;
      const relY = (eyeMidY - bb.y) / bb.height;

      // Also factor in face position within the video frame
      const faceCenterX = (bb.x + bb.width / 2) / PROC_WIDTH;
      const faceCenterY = (bb.y + bb.height / 2) / PROC_HEIGHT;

      // Blend face position (head pose) with eye-in-face position (eye gaze)
      // Weight: 60% head pose, 40% eye offset for a more stable signal
      return {
        x: faceCenterX * 0.6 + relX * 0.4,
        y: faceCenterY * 0.6 + relY * 0.4,
      };
    }

    // Fallback: use face bounding box centre
    return {
      x: (bb.x + bb.width / 2) / PROC_WIDTH,
      y: (bb.y + bb.height / 2) / PROC_HEIGHT,
    };
  }

  // -------------------------------------------------------------------------
  // Skin-colour centroid fallback path
  // -------------------------------------------------------------------------

  private processWithSkinCentroid(ctx: CanvasRenderingContext2D): void {
    const imageData = ctx.getImageData(0, 0, PROC_WIDTH, PROC_HEIGHT);
    const faceCentroid = this.findFaceCentroid(imageData);
    if (!faceCentroid) return;
    this.lastFacePoint = faceCentroid;
    this.applyFacePoint(faceCentroid);
  }

  private findFaceCentroid(imageData: ImageData): Point | null {
    const { data, width, height } = imageData;

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    const step = 4;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (this.isSkinPixel(r, g, b)) {
          sumX  += x;
          sumY  += y;
          count += 1;
        }
      }
    }

    const minPixels = (PROC_WIDTH * PROC_HEIGHT) / (step * step) * 0.01;
    if (count < minPixels) return null;

    return {
      x: sumX / count / PROC_WIDTH,
      y: sumY / count / PROC_HEIGHT,
    };
  }

  private isSkinPixel(r: number, g: number, b: number): boolean {
    return (
      r >= SKIN_R_MIN && r <= SKIN_R_MAX &&
      g >= SKIN_G_MIN && g <= SKIN_G_MAX &&
      b >= SKIN_B_MIN && b <= SKIN_B_MAX &&
      r - g >= SKIN_RG_DIFF &&
      r - b >= SKIN_RB_DIFF
    );
  }

  // -------------------------------------------------------------------------
  // Common gaze application
  // -------------------------------------------------------------------------

  private applyFacePoint(facePoint: Point): void {
    if (this.calibrating) {
      this.handleCalibrationFrame(facePoint);
      return;
    }

    const gazeRaw = this.faceToGaze(facePoint);

    const alpha = 1 - this.opts.smoothing;
    this.smoothGaze = {
      x: this.smoothGaze.x * this.opts.smoothing + gazeRaw.x * alpha,
      y: this.smoothGaze.y * this.opts.smoothing + gazeRaw.y * alpha,
    };

    this.updateGazeCursor(this.smoothGaze.x, this.smoothGaze.y);
    this.opts.onGaze(this.smoothGaze.x, this.smoothGaze.y);
  }

  // -------------------------------------------------------------------------
  // Coordinate mapping
  // -------------------------------------------------------------------------

  private faceToGaze(face: Point): Point {
    if (this.calibPoints.length >= 2) {
      return this.interpolateFromCalib(face);
    }
    return this.linearFaceToGaze(face);
  }

  private linearFaceToGaze(face: Point): Point {
    const sensitivity = 5;
    const restX = this.restFace.x / PROC_WIDTH;
    const restY = this.restFace.y / PROC_HEIGHT;

    const dx = (face.x - restX) * sensitivity;
    const dy = (face.y - restY) * sensitivity;

    return {
      x: clamp(window.innerWidth  / 2 + dx * window.innerWidth  / 2, 0, window.innerWidth),
      y: clamp(window.innerHeight / 2 + dy * window.innerHeight / 2, 0, window.innerHeight),
    };
  }

  private interpolateFromCalib(face: Point): Point {
    const weights: number[] = this.calibPoints.map((cp) => {
      const d = dist(face, cp.face);
      return d < 1e-6 ? 1e6 : 1 / (d * d);
    });

    const totalW = weights.reduce((a, b) => a + b, 0);

    let screenX = 0;
    let screenY = 0;
    for (let i = 0; i < this.calibPoints.length; i++) {
      const w = weights[i] / totalW;
      screenX += this.calibPoints[i].screen.x * window.innerWidth  * w;
      screenY += this.calibPoints[i].screen.y * window.innerHeight * w;
    }

    return {
      x: clamp(screenX, 0, window.innerWidth),
      y: clamp(screenY, 0, window.innerHeight),
    };
  }

  // -------------------------------------------------------------------------
  // Gaze cursor rendering
  // -------------------------------------------------------------------------

  private updateGazeCursor(x: number, y: number): void {
    const el = this.gazeCursorEl;
    if (!el) return;
    el.style.left = `${x - GAZE_CURSOR_RADIUS}px`;
    el.style.top  = `${y - GAZE_CURSOR_RADIUS}px`;
  }

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------

  private showCalibrationOverlay(): void {
    const overlay = document.createElement('div');
    overlay.className = 'ab-calibration-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Eye tracker calibration');
    overlay.setAttribute('aria-live', 'polite');

    const instructions = document.createElement('p');
    instructions.className = 'ab-calibration-instructions';
    instructions.textContent =
      'Eye Tracker Calibration – look at each dot until it fills, then it will advance automatically.';
    overlay.appendChild(instructions);

    const dot = document.createElement('div');
    dot.className = 'ab-calibration-dot';
    overlay.appendChild(dot);
    this.calibDot = dot;

    document.body.appendChild(overlay);
    this.calibOverlay = overlay;
  }

  private advanceCalibrationTarget(): void {
    if (this.calibIndex >= CALIBRATION_TARGETS.length) {
      this.finishCalibration();
      return;
    }

    const target = CALIBRATION_TARGETS[this.calibIndex];
    const dot    = this.calibDot;
    if (!dot) return;

    const screenX = target.x * window.innerWidth;
    const screenY = target.y * window.innerHeight;
    dot.style.left = `${screenX}px`;
    dot.style.top  = `${screenY}px`;

    this.calibDwellStart = Date.now();
    dot.style.setProperty('--dwell-progress', '0%');

    if (this.calibProgressInterval !== null) {
      clearInterval(this.calibProgressInterval);
    }
    this.calibProgressInterval = setInterval(() => {
      const elapsed  = Date.now() - this.calibDwellStart;
      const progress = Math.min(elapsed / CALIBRATION_DWELL_MS * 100, 100);
      dot?.style.setProperty('--dwell-progress', `${progress}%`);
    }, 50);
  }

  private handleCalibrationFrame(face: Point): void {
    if (this.calibIndex >= CALIBRATION_TARGETS.length) return;

    const elapsed = Date.now() - this.calibDwellStart;
    if (elapsed < CALIBRATION_DWELL_MS) return;

    const target = CALIBRATION_TARGETS[this.calibIndex];
    this.calibPoints.push({ screen: target, face: { ...face } });

    if (this.calibIndex === 0) {
      this.restFace = {
        x: face.x * PROC_WIDTH,
        y: face.y * PROC_HEIGHT,
      };
    }

    if (this.calibProgressInterval !== null) {
      clearInterval(this.calibProgressInterval);
      this.calibProgressInterval = null;
    }

    this.calibIndex++;
    this.advanceCalibrationTarget();
  }

  private finishCalibration(): void {
    this.calibrating = false;
    this.stopCalibrationUI();
    this.calibResolve?.();
    this.calibResolve = null;
  }

  private stopCalibrationUI(): void {
    if (this.calibProgressInterval !== null) {
      clearInterval(this.calibProgressInterval);
      this.calibProgressInterval = null;
    }
    this.calibOverlay?.remove();
    this.calibOverlay = null;
    this.calibDot     = null;
    this.calibrating  = false;
    this.calibResolve = null;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
