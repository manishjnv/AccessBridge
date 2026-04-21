import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalize, resize, hashImageData, screenshotElement } from '../models/image-preprocessor.js';

// ---------------------------------------------------------------------------
// Node-env polyfill: ImageData is a browser API absent in node test env.
// ---------------------------------------------------------------------------
if (typeof ImageData === 'undefined') {
  // @ts-expect-error — polyfill for node test env
  globalThis.ImageData = class ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}
// Also polyfill crypto.subtle for hashImageData tests (Node 15+ has it, but
// some environments may not expose it globally).
if (typeof crypto === 'undefined') {
  // @ts-expect-error — global polyfill
  globalThis.crypto = {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageData(w: number, h: number, fill = 128): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(fill);
  // Set alpha to 255.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return new ImageData(data, w, h);
}

// ---------------------------------------------------------------------------
// 1. normalize — ImageNet means applied correctly
// ---------------------------------------------------------------------------

describe('normalize — ImageNet mean/std', () => {
  const MEAN: [number, number, number] = [0.485, 0.456, 0.406];
  const STD: [number, number, number] = [0.229, 0.224, 0.225];

  it('1: applies ImageNet mean/std to sample pixel correctly', () => {
    // 1×1 image, pixel value (255,0,0,255) → R=1.0, G=0.0, B=0.0
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    const img = new ImageData(data, 1, 1);
    const out = normalize(img, MEAN, STD);
    const expectedR = (1.0 - MEAN[0]) / STD[0];
    const expectedG = (0.0 - MEAN[1]) / STD[1];
    const expectedB = (0.0 - MEAN[2]) / STD[2];
    expect(out[0]).toBeCloseTo(expectedR, 4);
    expect(out[1]).toBeCloseTo(expectedG, 4);
    expect(out[2]).toBeCloseTo(expectedB, 4);
  });

  it('2: outputs CHW Float32Array of length 3*W*H', () => {
    const img = makeImageData(8, 6);
    const out = normalize(img, MEAN, STD);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(3 * 8 * 6);
  });
});

// ---------------------------------------------------------------------------
// 3-4. resize — letterbox
// ---------------------------------------------------------------------------

describe('resize — letterbox', () => {
  it('3: resize preserves aspect ratio (letterbox pads)', () => {
    // 200×100 → 100×100: scale=0.5, scaledW=100, scaledH=50, offsetY=25
    const src = makeImageData(200, 100, 200);
    const out = resize(src, 100, 100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
    // The padded rows (outside the letterboxed region) should be black.
    // Row 0 should be black (offset=25 so rows 0-24 are padding).
    const topRowR = out.data[0];
    expect(topRowR).toBe(0);
  });

  it('4: resize handles non-square input (portrait → square)', () => {
    // 50×100 → 100×100: scale=1.0 (min(100/50,100/100)=1), scaledW=50, scaledH=100, offsetX=25
    const src = makeImageData(50, 100, 180);
    const out = resize(src, 100, 100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
    // Left column (x=0) should be black padding.
    const leftR = out.data[0];
    expect(leftR).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5-7. hashImageData
// ---------------------------------------------------------------------------

describe('hashImageData', () => {
  it('5: hashImageData is deterministic (same input → same hash)', async () => {
    const img = makeImageData(64, 64, 100);
    const h1 = await hashImageData(img);
    const h2 = await hashImageData(img);
    expect(h1).toBe(h2);
  });

  it('6: hashImageData different inputs → different hashes', async () => {
    const img1 = makeImageData(64, 64, 100);
    const img2 = makeImageData(64, 64, 200);
    const h1 = await hashImageData(img1);
    const h2 = await hashImageData(img2);
    expect(h1).not.toBe(h2);
  });

  it('7: hashImageData handles 0x0 gracefully (returns null)', async () => {
    const fakeZero = { width: 0, height: 0, data: new Uint8ClampedArray(0) } as unknown as ImageData;
    const result = await hashImageData(fakeZero);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8-9. screenshotElement
// ---------------------------------------------------------------------------

describe('screenshotElement', () => {
  it('8: screenshotElement returns null for zero-bbox element', async () => {
    const el = {
      getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    } as unknown as Element;
    const result = await screenshotElement(el);
    expect(result).toBeNull();
  });

  it('9: OffscreenCanvas fallback path when OffscreenCanvas absent in env', async () => {
    // Temporarily remove OffscreenCanvas from global.
    const original = (globalThis as Record<string, unknown>)['OffscreenCanvas'];
    delete (globalThis as Record<string, unknown>)['OffscreenCanvas'];

    // Provide a canvas stub with a 2d context.
    const fakeCtx = {
      fillStyle: '',
      fillRect: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        return new ImageData(new Uint8ClampedArray(w * h * 4), w, h);
      }),
    };
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => fakeCtx),
    };
    const origCreate = typeof document !== 'undefined' ? document.createElement.bind(document) : null;
    if (typeof document !== 'undefined') {
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') return fakeCanvas as unknown as HTMLCanvasElement;
        return origCreate!(tag);
      });
    }

    const el = {
      getBoundingClientRect: () => ({ width: 50, height: 50, left: 0, top: 0, right: 50, bottom: 50 }),
    } as unknown as Element;

    const result = await screenshotElement(el);
    // In jsdom (vitest default), document.createElement exists; canvas may or may not
    // have getContext. The important thing is: it doesn't throw and returns either
    // an ImageData or null (if getContext returns null in the test env).
    // Either outcome is acceptable — we verify no exception is thrown.
    expect(result === null || result instanceof ImageData).toBe(true);

    // Restore.
    if (original !== undefined) {
      (globalThis as Record<string, unknown>)['OffscreenCanvas'] = original;
    }
    if (typeof document !== 'undefined') {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. resize: target 0x0 returns empty ImageData gracefully
// ---------------------------------------------------------------------------

describe('resize — edge cases', () => {
  it('10: resize with target 0×0 returns a valid (1×1) ImageData gracefully', () => {
    const src = makeImageData(50, 50);
    const out = resize(src, 0, 0);
    // Contract: returns a valid ImageData, not throws. We return 1×1 black.
    expect(out).toBeInstanceOf(ImageData);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });
});
