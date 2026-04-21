import { AIEngine } from '../engine.js';

export interface VisionRecoveryInput {
  screenshot: string;
  domContext: string;
}

export interface VisionRecoveryOutput {
  role: string;
  label: string;
  description: string;
  confidence: number;
}

export class VisionRecoveryService {
  private readonly engine: AIEngine;

  constructor(engine: AIEngine) {
    this.engine = engine;
  }

  async inferElementMeaning(
    input: VisionRecoveryInput,
  ): Promise<VisionRecoveryOutput> {
    const prompt = buildPrompt(input.domContext);
    try {
      const resp = await this.engine.process({
        id: `vision-${Date.now().toString(36)}`,
        type: 'vision',
        input: prompt,
        metadata: { screenshot: input.screenshot },
      });
      return parseVisionOutput(resp.output);
    } catch {
      return DEFAULT_OUTPUT;
    }
  }
}

const DEFAULT_OUTPUT: VisionRecoveryOutput = {
  role: 'button',
  label: 'Unlabeled control',
  description: '',
  confidence: 0,
};

function buildPrompt(domContext: string): string {
  return (
    'You are an accessibility AI. Given context about a UI element that is missing an accessible label, infer its role and purpose.\n' +
    'Return ONLY a single-line JSON object with keys: role (ARIA role string), label (human-readable short name, max 6 words), description (one sentence, max 15 words), confidence (number 0 to 1).\n' +
    'Do not wrap in markdown code fences.\n\n' +
    'Element context:\n' +
    domContext
  );
}

function parseVisionOutput(output: string): VisionRecoveryOutput {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    // Fall through to JSON extraction.
  }

  if (parsed === null) {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
      } catch {
        // Fall through to text parsing.
      }
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return parseTextFallback(output);
  }

  const obj = parsed as Record<string, unknown>;
  return {
    role: sanitizeString(obj.role, 'button', 40),
    label: sanitizeString(obj.label, 'Unlabeled control', 60),
    description: sanitizeString(obj.description, '', 160),
    confidence: sanitizeConfidence(obj.confidence),
  };
}

function parseTextFallback(output: string): VisionRecoveryOutput {
  const roleMatch = output.match(/role\s*[:=]\s*([a-zA-Z-]+)/i);
  const labelMatch = output.match(/label\s*[:=]\s*"?([^",\n]+)"?/i);
  return {
    role: roleMatch ? roleMatch[1].trim() : 'button',
    label: labelMatch
      ? labelMatch[1].trim().slice(0, 60)
      : 'Unlabeled control',
    description: '',
    confidence: labelMatch ? 0.5 : 0.3,
  };
}

function sanitizeString(v: unknown, fallback: string, maxLen: number): string {
  if (typeof v !== 'string') return fallback;
  const trimmed = v.trim();
  return trimmed.length === 0 ? fallback : trimmed.slice(0, maxLen);
}

function sanitizeConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0.3;
  return Math.max(0, Math.min(1, n));
}
