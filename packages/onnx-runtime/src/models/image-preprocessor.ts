/**
 * image-preprocessor.ts — vision preprocessing utilities for MoondreamVision.
 *
 * Exports four pure functions:
 *   - screenshotElement  DOM → ImageData via OffscreenCanvas (or HTMLCanvasElement fallback)
 *   - resize             Letterbox-resize ImageData to target WxH, preserving aspect ratio
 *   - normalize          ImageData → CHW Float32Array with per-channel mean/std normalization
 *   - hashImageData      Stable 32x32 downsample → SHA-256 hex (FNV-1a fallback when crypto.subtle absent)
 *
 * No external dependencies beyond the browser's own Canvas / Web Crypto APIs.
 * All functions are null-safe on 0-dimension inputs.
 */

// ---------------------------------------------------------------------------
// screenshotElement
// ---------------------------------------------------------------------------

/**
 * Capture the viewport-visible pixels of `element` into an ImageData.
 *
 * Strategy:
 *   1. Read bounding rect; return null for zero-area elements.
 *   2. Prefer OffscreenCanvas (worker-safe), fall back to HTMLCanvasElement.
 *   3. Draw a thin "screenshot" by extracting getComputedStyle background-color
 *      and filling — NOT pulling in html2canvas. Real pixel-perfect capture
 *      requires a full compositor and is deferred to when Moondream weights ship;
 *      this stub produces a correctly-sized ImageData so the contract is exercisable.
 *
 * Returns null when:
 *   - element has a zero-area bounding rect, OR
 *   - canvas API is entirely absent (SSR / non-DOM env).
 */
export async function screenshotElement(
  element: Element,
  opts?: { canvas?: HTMLCanvasElement | OffscreenCanvas },
): Promise<ImageData | null> {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const w = Math.round(rect.width);
  const h = Math.round(rect.height);

  let canvas: HTMLCanvasElement | OffscreenCanvas | null = opts?.canvas ?? null;

  if (!canvas) {
    // Prefer OffscreenCanvas when available.
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      canvas = document.createElement('canvas') as HTMLCanvasElement;
      (canvas as HTMLCanvasElement).width = w;
      (canvas as HTMLCanvasElement).height = h;
    } else {
      return null;
    }
  } else {
    // Resize the provided canvas to fit.
    if ('width' in canvas) {
      (canvas as { width: number; height: number }).width = w;
      (canvas as { width: number; height: number }).height = h;
    }
  }

  const ctx = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;

  // MVP fill: background-color from computed style (or mid-grey).
  let fillColor = '#888888';
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(element as HTMLElement);
    if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      fillColor = style.backgroundColor;
    }
  }
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, w, h);

  return ctx.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// resize — letterbox with zero-padding
// ---------------------------------------------------------------------------

/**
 * Resize `imageData` to `targetWidth × targetHeight` while preserving aspect
 * ratio. The image is centred and remaining pixels are filled with 0 (black,
 * transparent).
 *
 * Returns an empty ImageData (0×0 is not valid, so we return 1×1 black) when
 * either target dimension is ≤ 0, and the input-data unchanged shape when the
 * source is 0-dimension.
 */
export function resize(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  // Degenerate target: return a 1×1 blank to satisfy ImageData constructor.
  if (targetWidth <= 0 || targetHeight <= 0) {
    return new ImageData(new Uint8ClampedArray(4), 1, 1);
  }

  const srcW = imageData.width;
  const srcH = imageData.height;

  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4); // all zeros = black transparent

  if (srcW <= 0 || srcH <= 0) {
    return new ImageData(out, targetWidth, targetHeight);
  }

  // Compute letterbox scale (fit inside target, preserve aspect).
  const scale = Math.min(targetWidth / srcW, targetHeight / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  // Offset to centre the scaled image.
  const offsetX = Math.floor((targetWidth - scaledW) / 2);
  const offsetY = Math.floor((targetHeight - scaledH) / 2);

  const src = imageData.data;

  for (let dy = 0; dy < scaledH; dy++) {
    const srcY = Math.floor((dy / scaledH) * srcH);
    for (let dx = 0; dx < scaledW; dx++) {
      const srcX = Math.floor((dx / scaledW) * srcW);
      const srcIdx = (srcY * srcW + srcX) * 4;
      const dstIdx = ((offsetY + dy) * targetWidth + (offsetX + dx)) * 4;
      out[dstIdx] = src[srcIdx];
      out[dstIdx + 1] = src[srcIdx + 1];
      out[dstIdx + 2] = src[srcIdx + 2];
      out[dstIdx + 3] = src[srcIdx + 3];
    }
  }

  return new ImageData(out, targetWidth, targetHeight);
}

// ---------------------------------------------------------------------------
// normalize — HWC ImageData → CHW Float32Array
// ---------------------------------------------------------------------------

/**
 * Convert RGBA ImageData to a CHW Float32Array suitable for ONNX vision models.
 *
 * Steps:
 *   1. Clamp each channel to [0, 1] by dividing by 255.
 *   2. Subtract per-channel mean, divide by per-channel std.
 *   3. Output layout: [R_row0col0, R_row0col1, ..., G_..., B_...] (planar CHW).
 *
 * @param imageData  Source pixels (RGBA, Uint8ClampedArray).
 * @param mean       Per-channel mean [R, G, B] (e.g. ImageNet [0.485, 0.456, 0.406]).
 * @param std        Per-channel std  [R, G, B] (e.g. ImageNet [0.229, 0.224, 0.225]).
 * @returns Float32Array of length 3 * width * height (CHW).
 */
export function normalize(
  imageData: ImageData,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
): Float32Array {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const out = new Float32Array(3 * n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    // Clamp to [0,1] (Uint8ClampedArray already guarantees 0-255, so /255 is
    // already in range, but guard for any non-standard input).
    out[i] = (Math.min(1, Math.max(0, r)) - mean[0]) / (std[0] || 1);
    out[n + i] = (Math.min(1, Math.max(0, g)) - mean[1]) / (std[1] || 1);
    out[2 * n + i] = (Math.min(1, Math.max(0, b)) - mean[2]) / (std[2] || 1);
  }

  return out;
}

// ---------------------------------------------------------------------------
// hashImageData — semantic cache key
// ---------------------------------------------------------------------------

/**
 * Produce a stable hex-string hash of an ImageData for use as a semantic cache key.
 *
 * Steps:
 *   1. Downsample to 32×32 using the same letterbox `resize` function.
 *   2. Extract the raw Uint8ClampedArray (RGBA, 32×32×4 = 4096 bytes).
 *   3. Hash via crypto.subtle.digest('SHA-256', …) → lower-case hex.
 *   4. Fallback: if crypto.subtle is unavailable (some test/SSR envs), use
 *      a deterministic FNV-1a hash (same input always → same 8-hex-char output).
 *
 * Returns null when imageData has 0-area dimensions.
 */
export async function hashImageData(imageData: ImageData): Promise<string | null> {
  if (imageData.width <= 0 || imageData.height <= 0) return null;

  const small = resize(imageData, 32, 32);
  const bytes = small.data; // Uint8ClampedArray

  // Try crypto.subtle (browser / Node 15+).
  if (
    typeof crypto !== 'undefined' &&
    crypto.subtle != null &&
    typeof crypto.subtle.digest === 'function'
  ) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback: FNV-1a 32-bit (deterministic, not cryptographic — test env only).
  return fnv1aHex(bytes);
}

/** FNV-1a 32-bit → lower-case 8-char hex. */
function fnv1aHex(data: Uint8ClampedArray): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 16777619);
    h >>>= 0;
  }
  return h.toString(16).padStart(8, '0');
}
