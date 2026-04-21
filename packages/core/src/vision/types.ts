export interface UnlabeledElement {
  nodeHint: string;
  bbox: { x: number; y: number; w: number; h: number };
  computedRole: string | null;
  currentAriaLabel: string | null;
  textContent: string;
  siblingContext: string;
  classSignature: string;
  backgroundImageUrl: string | null;
}

export interface RecoveredLabel {
  element: UnlabeledElement;
  inferredRole: string;
  inferredLabel: string;
  inferredDescription: string;
  confidence: number;
  source: 'heuristic' | 'api-vision' | 'cached';
  tier: 1 | 2 | 3;
}

export interface VisionRecoveryConfig {
  tierEnabled: { 1: boolean; 2: boolean; 3: boolean };
  cacheTTLms: number;
  minConfidence: number;
  costBudgetPerDay: number;
}

export interface RecoveryCache {
  key: string;
  recovered: RecoveredLabel;
  cachedAt: number;
  appVersion: string;
}

export interface ApiVisionClient {
  inferElementMeaning(screenshot: string, domContext: string): Promise<{
    role: string;
    label: string;
    description: string;
    confidence: number;
  }>;
}

export const DEFAULT_VISION_CONFIG: VisionRecoveryConfig = {
  tierEnabled: { 1: true, 2: false, 3: false },
  cacheTTLms: 7 * 24 * 60 * 60 * 1000,
  minConfidence: 0.6,
  costBudgetPerDay: 0.10,
};
