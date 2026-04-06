/**
 * EyeTracker – webcam-based gaze cursor for AccessBridge.
 *
 * Approach (prototype):
 *   1. Opens the webcam via getUserMedia.
 *   2. Every animation frame, draws the video to an off-screen canvas and
 *      runs a fast skin-colour centroid tracker to find the face region.
 *   3. Maps the face centroid's X/Y displacement from its resting position
 *      to a gaze cursor position on the screen.
 *   4. Applies exponential-moving-average smoothing so the cursor doesn't
 *      jitter.
 *   5. Renders a semi-transparent gaze cursor <div> on top of the page.
 *   6. Supports a 5-point calibration mode (4 corners + centre).
 *   7. Optionally shows a small live webcam preview in the top-right corner.
 *
 * Accuracy is intentionally approximate – this is a functional prototype.
 */

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

/** How many calibration targets are shown (corners + centre). */
const CALIBRATION_TARGETS: ReadonlyArray<Point> = [
  { x: 0.05, y: 0.05 },   // top-left
  { x: 0.95, y: 0.05 },   // top-right
  { x: 0.5,  y: 0.5  },   // centre
  { x: 0.05, y: 0.95 },   // bottom-left
  { x: 0.95, y: 0.95 },   // bottom-right
];

/** Dwell duration on each calibration target before advancing (ms). */
const CALIBRATION_DWELL_MS = 2_000;

/** Radius of the gaze cursor (px). */
const GAZE_CURSOR_RADIUS = 30;

/** Processing canvas dimensions – smaller = faster. */
const PROC_WIDTH  = 160;
const PROC_HEIGHT = 120;

/** Skin-colour thresholds in RGB space (permissive, works across skin tones). */
const SKIN_R_MIN = 60;
const SKIN_R_MAX = 255;
const SKIN_G_MIN = 30;
const SKIN_G_MAX = 220;
const SKIN_B_MIN = 20;
const SKIN_B_MAX = 200;

/** The R channel must be meaningfully larger than G and B. */
const SKIN_RG_DIFF = 10;
const SKIN_RB_DIFF = 20;

// ---------------------------------------------------------------------------
// EyeTracker
// ---------------------------------------------------------------------------

export class EyeTracker {
  // --- Core state ---
  private running   = false;
  private calibrating = false;
  private rafId: number | null = null;

  // --- Media ---
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private procCanvas: HTMLCanvasElement | null = null;
  private procCtx: CanvasRenderingContext2D | null = null;

  // --- Tracking ---
  private restFace: Point = { x: PROC_WIDTH / 2, y: PROC_HEIGHT / 2 };
  private smoothGaze: Point = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private calibPoints: CalibrationPoint[] = [];

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

  /**
   * Start the eye tracker: requests webcam access, builds DOM elements, and
   * begins the tracking loop.
   */
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

    this.buildDOM();
    this.running = true;
    this.startLoop();
  }

  /** Stop tracking, release the webcam, and remove all DOM elements. */
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
  }

  /** Whether the tracker is currently active. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run the 5-point calibration sequence.  Returns a Promise that resolves
   * when calibration is complete (or rejects if the tracker is not running).
   */
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
  // DOM construction
  // -------------------------------------------------------------------------

  private buildDOM(): void {
    // Hidden video element – streams webcam feed
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

    // Off-screen processing canvas
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

    // Gaze cursor overlay
    const cursor = document.createElement('div');
    cursor.className = 'ab-gaze-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.setAttribute('role', 'presentation');
    document.body.appendChild(cursor);
    this.gazeCursorEl = cursor;

    // Webcam preview (toggle-able)
    if (this.opts.showPreview) {
      this.buildPreview();
    }
  }

  private buildPreview(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'ab-webcam-preview';
    wrapper.title     = 'Eye tracker preview – click to hide';

    // Mirror the video into this small preview using a separate <video>
    // pointing at the same stream so we don't show the hidden one.
    const previewVideo = document.createElement('video');
    previewVideo.srcObject  = this.stream;
    previewVideo.autoplay   = true;
    previewVideo.playsInline = true;
    previewVideo.muted      = true;
    previewVideo.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;transform:scaleX(-1);';

    const label = document.createElement('span');
    label.textContent = 'Eye Tracker';
    label.style.cssText =
      'position:absolute;bottom:4px;left:0;right:0;text-align:center;' +
      'font:10px/1 system-ui,sans-serif;color:#fff;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none;';

    wrapper.appendChild(previewVideo);
    wrapper.appendChild(label);

    // Click to toggle visibility of the video (keeps the wrapper as handle)
    wrapper.addEventListener('click', () => {
      const hidden = previewVideo.style.visibility === 'hidden';
      previewVideo.style.visibility = hidden ? 'visible' : 'hidden';
      label.textContent = hidden ? 'Eye Tracker' : 'Eye Tracker (paused)';
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

    // Draw downscaled frame (mirrored so left/right feel natural)
    ctx.save();
    ctx.translate(PROC_WIDTH, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, PROC_WIDTH, PROC_HEIGHT);
    ctx.restore();

    const imageData = ctx.getImageData(0, 0, PROC_WIDTH, PROC_HEIGHT);
    const faceCentroid = this.findFaceCentroid(imageData);

    if (!faceCentroid) return;  // no face found this frame – hold last position

    // During calibration, record the face position for each target
    if (this.calibrating) {
      this.handleCalibrationFrame(faceCentroid);
      return;
    }

    // Map face position to screen gaze coordinates
    const gazeRaw = this.faceToGaze(faceCentroid);

    // Exponential moving average smoothing
    const alpha = 1 - this.opts.smoothing;
    this.smoothGaze = {
      x: this.smoothGaze.x * this.opts.smoothing + gazeRaw.x * alpha,
      y: this.smoothGaze.y * this.opts.smoothing + gazeRaw.y * alpha,
    };

    this.updateGazeCursor(this.smoothGaze.x, this.smoothGaze.y);
    this.opts.onGaze(this.smoothGaze.x, this.smoothGaze.y);
  }

  // -------------------------------------------------------------------------
  // Skin-colour face centroid detection
  // -------------------------------------------------------------------------

  /**
   * Fast skin-pixel centroid.  Returns the weighted centroid of all pixels
   * that pass the skin-colour test, normalised to [0,1] in both axes.
   * Returns null if too few skin pixels are found (face not in frame).
   */
  private findFaceCentroid(imageData: ImageData): Point | null {
    const { data, width, height } = imageData;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    // Step over pixels in a 4×4 grid for performance (every 4th pixel)
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

    const minPixels = (PROC_WIDTH * PROC_HEIGHT) / (step * step) * 0.01; // 1% of sampled area
    if (count < minPixels) return null;

    return {
      x: sumX / count / PROC_WIDTH,   // normalise to 0-1
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
  // Coordinate mapping
  // -------------------------------------------------------------------------

  /**
   * Convert a normalised face centroid position to a screen pixel coordinate.
   *
   * If we have calibration data, use bilinear interpolation from the 5 known
   * face→screen mappings.  Otherwise fall back to a linear stretch that maps
   * face movement around `restFace` to screen extent.
   */
  private faceToGaze(face: Point): Point {
    if (this.calibPoints.length >= 2) {
      return this.interpolateFromCalib(face);
    }
    return this.linearFaceToGaze(face);
  }

  private linearFaceToGaze(face: Point): Point {
    // Movement sensitivity: a shift of 0.15 in face space → full screen span
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

  /**
   * Inverse-distance-weighted interpolation from calibration points.
   * Each calibration point says "when my face is at face[i], gaze is at screen[i]".
   */
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

    // The moving target dot is added per-step
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

    // Position the dot
    const screenX = target.x * window.innerWidth;
    const screenY = target.y * window.innerHeight;
    dot.style.left = `${screenX}px`;
    dot.style.top  = `${screenY}px`;

    // Reset dwell timer
    this.calibDwellStart = Date.now();

    // Animate a fill ring on the dot to give visual dwell feedback
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

    // Record this calibration point
    const target = CALIBRATION_TARGETS[this.calibIndex];
    this.calibPoints.push({ screen: target, face: { ...face } });

    // On the first calibration point, set the rest position
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
