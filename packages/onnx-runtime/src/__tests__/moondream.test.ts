import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoondreamVision } from '../models/moondream.js';
import type { InferenceSessionLike, TensorLike } from '../types.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4).fill(128);
  return new ImageData(data, w, h);
}

function makeLogitsTensor(vocabSize = 10): TensorLike {
  const data = new Float32Array(vocabSize).fill(0);
  data[5] = 3.0; // argmax at 5
  return { type: 'float32', data, dims: [1, vocabSize] };
}

function makeSession(
  outputs: Record<string, TensorLike> = {},
  shouldThrow = false,
): InferenceSessionLike {
  return {
    inputNames: [],
    outputNames: [],
    run: vi.fn(async (_feeds: Record<string, TensorLike>) => {
      if (shouldThrow) throw new Error('mock inference error');
      return outputs;
    }),
    release: vi.fn(),
  };
}

function makeDeps(
  visionSession: InferenceSessionLike | null,
  textSession: InferenceSessionLike | null,
) {
  let t = 0;
  return {
    loadVisionSession: vi.fn(async () => visionSession),
    loadTextSession: vi.fn(async () => textSession),
    now: () => (t += 10),
    logger: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. load() success both sessions
// ---------------------------------------------------------------------------

describe('MoondreamVision — load()', () => {
  it('1: load() success when both sessions return non-null', async () => {
    const vSess = makeSession({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } });
    const tSess = makeSession({ logits: makeLogitsTensor() });
    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    const result = await mv.load();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('2: load() reports progress monotonically (both sessions aggregated)', async () => {
    const vSess = makeSession({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } });
    const tSess = makeSession({ logits: makeLogitsTensor() });
    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    const percents: number[] = [];
    await mv.load({ onProgress: (p) => percents.push(p.percent) });
    // Must include 0 (start), 50 (after vision), 100 (after text).
    expect(percents).toContain(0);
    expect(percents).toContain(50);
    expect(percents).toContain(100);
    // Monotonically non-decreasing.
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
  });

  it('3: load() returns {ok:false, error:"ort-unavailable"} when vision loader returns null', async () => {
    const deps = makeDeps(null, makeSession({ logits: makeLogitsTensor() }));
    const mv = new MoondreamVision(deps);
    const result = await mv.load();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ort-unavailable');
  });

  it('4: load() returns {ok:false, error:"ort-unavailable"} when text loader returns null', async () => {
    const vSess = makeSession({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } });
    const deps = makeDeps(vSess, null);
    const mv = new MoondreamVision(deps);
    const result = await mv.load();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ort-unavailable');
  });
});

// ---------------------------------------------------------------------------
// 5. isLoaded()
// ---------------------------------------------------------------------------

describe('MoondreamVision — isLoaded()', () => {
  it('5a: isLoaded() is false before load()', () => {
    const deps = makeDeps(makeSession(), makeSession());
    const mv = new MoondreamVision(deps);
    expect(mv.isLoaded()).toBe(false);
  });

  it('5b: isLoaded() is true after successful load()', async () => {
    const vSess = makeSession({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } });
    const tSess = makeSession({ logits: makeLogitsTensor() });
    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    await mv.load();
    expect(mv.isLoaded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6-10. describeElement()
// ---------------------------------------------------------------------------

describe('MoondreamVision — describeElement()', () => {
  let mv: MoondreamVision;
  let vRelease: ReturnType<typeof vi.fn>;
  let tRelease: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const embedTensor: TensorLike = { type: 'float32', data: new Float32Array(16), dims: [1, 16] };
    // text decoder: return EOS token (token 1) immediately so we get a real loop exit
    const logitsEos = new Float32Array(10).fill(0);
    logitsEos[1] = 5.0; // argmax = token 1 = EOS
    const logitsTensor: TensorLike = { type: 'float32', data: logitsEos, dims: [1, 10] };

    vRelease = vi.fn();
    tRelease = vi.fn();

    const vSess: InferenceSessionLike = {
      inputNames: [],
      outputNames: [],
      run: vi.fn(async () => ({ image_embeds: embedTensor })),
      release: vRelease,
    };
    const tSess: InferenceSessionLike = {
      inputNames: [],
      outputNames: [],
      run: vi.fn(async () => ({ logits: logitsTensor })),
      release: tRelease,
    };
    const deps = makeDeps(vSess, tSess);
    mv = new MoondreamVision(deps);
    await mv.load();
  });

  it('6: describeElement happy path returns VisionDescription with latencyMs >= 0', async () => {
    const result = await mv.describeElement(makeImageData(100, 100), 'describe this element');
    expect(result).not.toBeNull();
    expect(typeof result!.caption).toBe('string');
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result!.role).toBe('string');
    expect(typeof result!.inferredLabel).toBe('string');
    expect(typeof result!.confidence).toBe('number');
  });

  it('7: describeElement returns null on 0x0 ImageData', async () => {
    // 0x0 is not a valid ImageData dimension — use 1x1 with zero width override via manual
    // construct. Actually ImageData(1,1) is fine; we need to test the guard: pass w=0 h=0.
    // We can't construct ImageData(0,0) directly so we cast.
    const fake = { width: 0, height: 0, data: new Uint8ClampedArray(0) } as unknown as ImageData;
    const result = await mv.describeElement(fake, 'test');
    expect(result).toBeNull();
  });

  it('8: describeElement returns null on > 4096x4096 ImageData', async () => {
    const fake = { width: 4097, height: 4097, data: new Uint8ClampedArray(4097 * 4097 * 4) } as unknown as ImageData;
    const result = await mv.describeElement(fake, 'test');
    expect(result).toBeNull();
  });

  it('9: describeElement returns null when session.run throws', async () => {
    const vSessThrow = makeSession({}, true);
    const tSessOk = makeSession({ logits: makeLogitsTensor() });
    const deps = makeDeps(vSessThrow, tSessOk);
    const mv2 = new MoondreamVision(deps);
    await mv2.load();
    const result = await mv2.describeElement(makeImageData(100, 100), 'test');
    expect(result).toBeNull();
  });

  it('10: describeElement returns null when called before load()', async () => {
    const deps = makeDeps(makeSession(), makeSession());
    const mv2 = new MoondreamVision(deps);
    const result = await mv2.describeElement(makeImageData(100, 100), 'test');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11-12. describeBatch()
// ---------------------------------------------------------------------------

describe('MoondreamVision — describeBatch()', () => {
  it('11: describeBatch handles empty array → returns []', async () => {
    const deps = makeDeps(makeSession(), makeSession());
    const mv = new MoondreamVision(deps);
    const result = await mv.describeBatch([], 'test');
    expect(result).toEqual([]);
  });

  it('12: describeBatch batches by 4 (assert ≤ 4 concurrent)', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const embedTensor: TensorLike = { type: 'float32', data: new Float32Array(16), dims: [1, 16] };
    const logitsEos = new Float32Array(10).fill(0);
    logitsEos[1] = 5.0;
    const logitsTensor: TensorLike = { type: 'float32', data: logitsEos, dims: [1, 10] };

    const vSess: InferenceSessionLike = {
      inputNames: [],
      outputNames: [],
      run: vi.fn(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await Promise.resolve(); // yield
        concurrentCount--;
        return { image_embeds: embedTensor };
      }),
      release: vi.fn(),
    };
    const tSess: InferenceSessionLike = {
      inputNames: [],
      outputNames: [],
      run: vi.fn(async () => ({ logits: logitsTensor })),
      release: vi.fn(),
    };

    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    await mv.load();

    const images = Array.from({ length: 9 }, () => makeImageData(50, 50));
    await mv.describeBatch(images, 'test');
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 13-14. unload()
// ---------------------------------------------------------------------------

describe('MoondreamVision — unload()', () => {
  it('13: unload() releases both sessions', async () => {
    const vRelease = vi.fn();
    const tRelease = vi.fn();
    const vSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } })),
      release: vRelease,
    };
    const tSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ logits: makeLogitsTensor() })),
      release: tRelease,
    };
    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    await mv.load();
    mv.unload();
    expect(vRelease).toHaveBeenCalledTimes(1);
    expect(tRelease).toHaveBeenCalledTimes(1);
  });

  it('14: unload() then isLoaded() = false', async () => {
    const vSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ image_embeds: { type: 'float32', data: new Float32Array(16), dims: [1, 16] } })),
      release: vi.fn(),
    };
    const tSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ logits: makeLogitsTensor() })),
      release: vi.fn(),
    };
    const deps = makeDeps(vSess, tSess);
    const mv = new MoondreamVision(deps);
    await mv.load();
    expect(mv.isLoaded()).toBe(true);
    mv.unload();
    expect(mv.isLoaded()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. role mapping
// ---------------------------------------------------------------------------

describe('MoondreamVision — role mapping', () => {
  async function buildLoaded(caption: string): Promise<MoondreamVision> {
    // Build a text decoder that returns the caption-encoding tokens then EOS
    const embedTensor: TensorLike = { type: 'float32', data: new Float32Array(16), dims: [1, 16] };
    const vSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ image_embeds: embedTensor })),
      release: vi.fn(),
    };

    // We need describeElement to return a known caption. The simplest approach:
    // override the text decoder to emit EOS immediately (caption='mocked-caption')
    // and then check mapRole via the public interface after loading a session
    // whose first-run returns a specific token sequence.
    // Since the internal tokenizer/decoder are private stubs, we test role
    // mapping by returning EOS immediately (caption='mocked-caption').
    // For an explicit 'button' caption we verify by inspecting the result caption
    // from a describeElement call that we're calling with 'a blue button' shape.
    //
    // Better: we test the role by constructing a session that emits tokens
    // spelling 'button' then EOS. Each token maps via detokenStub(token).
    // detokenStub(t) = chars[t % chars.length] where chars='abcdefghijklmnopqrstuvwxyz '
    // 'b'=1, 'u'=20, 't'=19, 't'=19, 'o'=14, 'n'=13 → tokens [1,20,19,19,14,13, EOS=1]
    // But token 1 is EOS, so we can't use it for 'b'. Use token 27 (27%27=0='a')... hmm.
    //
    // Actually the simplest approach: just stub the entire describeElement method
    // by checking the internal mapRole function indirectly via a known caption word.
    // We'll spy on the `run` mock to return logits that decode to 'button ' then EOS.
    // chars = 'abcdefghijklmnopqrstuvwxyz '(27 chars)
    // 'b'=1 (but token 1 = EOS). So use modular: want char index 1 → token=1, clash.
    // Use higher tokens: token=28 → 28%27=1='b', token=47→47%27=20='u'? 47%27=20, 'u'=20✓
    // 't'=19 → token=46 (46%27=19), 'o'=14→token=41, 'n'=13→token=40, EOS=1 → [28,47,46,46,41,40,1]
    // Let's verify: 28%27=1='b'✓ 47%27=20='u'✓ 46%27=19='t'✓ 41%27=14='o'✓ 40%27=13='n'✓
    const eosToken = 1;
    // Build a vocab where argmax cycles through the token sequence.
    let callIdx = 0;
    const sequence = caption === 'button' ? [28, 47, 46, 46, 41, 40, eosToken] : [eosToken];

    const tSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => {
        const tok = callIdx < sequence.length ? sequence[callIdx] : eosToken;
        callIdx++;
        const logits = new Float32Array(100).fill(0);
        logits[tok] = 10.0;
        return { logits: { type: 'float32', data: logits, dims: [1, 100] } };
      }),
      release: vi.fn(),
    };

    let t = 0;
    const deps = {
      loadVisionSession: vi.fn(async () => vSess),
      loadTextSession: vi.fn(async () => tSess),
      now: () => (t += 10),
      logger: vi.fn(),
    };
    const mv = new MoondreamVision(deps);
    await mv.load();
    return mv;
  }

  it('15: caption containing "button" → role "button"', async () => {
    const mv = await buildLoaded('button');
    const result = await mv.describeElement(makeImageData(100, 100), 'describe');
    expect(result).not.toBeNull();
    expect(result!.role).toBe('button');
  });
});

// ---------------------------------------------------------------------------
// 16. inferredLabel truncation
// ---------------------------------------------------------------------------

describe('MoondreamVision — inferredLabel', () => {
  it('16: inferredLabel truncates long captions to ≤ 40 chars and ≤ 3 words', async () => {
    // We want a caption > 3 words. Craft tokens that spell 'a a a a a a a a' (8 'a' tokens).
    // 'a'=0 → token=0 (EOS). Use token=27 → 27%27=0='a'.
    const eosToken = 1;
    let callIdx = 0;
    const aToken = 27; // 27%27=0='a'
    const sequence = [aToken, aToken, aToken, aToken, aToken, aToken, aToken, aToken, eosToken];

    const embedTensor: TensorLike = { type: 'float32', data: new Float32Array(16), dims: [1, 16] };
    const vSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => ({ image_embeds: embedTensor })),
      release: vi.fn(),
    };
    const tSess: InferenceSessionLike = {
      inputNames: [], outputNames: [],
      run: vi.fn(async () => {
        const tok = callIdx < sequence.length ? sequence[callIdx] : eosToken;
        callIdx++;
        const logits = new Float32Array(100).fill(0);
        logits[tok] = 10.0;
        return { logits: { type: 'float32', data: logits, dims: [1, 100] } };
      }),
      release: vi.fn(),
    };

    let t = 0;
    const deps = {
      loadVisionSession: vi.fn(async () => vSess),
      loadTextSession: vi.fn(async () => tSess),
      now: () => (t += 10),
      logger: vi.fn(),
    };
    const mv = new MoondreamVision(deps);
    await mv.load();
    const result = await mv.describeElement(makeImageData(100, 100), 'describe this');
    expect(result).not.toBeNull();
    expect(result!.inferredLabel.length).toBeLessThanOrEqual(40);
    expect(result!.inferredLabel.split(' ').length).toBeLessThanOrEqual(3);
  });
});
