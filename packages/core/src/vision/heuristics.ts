import { ICON_LEXICON } from './icon-lexicon.js';
import type { UnlabeledElement, RecoveredLabel } from './types.js';

type LabelSignal = {
  label: string;
  confidence: number;
};

const ROLE_PATTERNS: Array<{ role: string; fragments: readonly string[] }> = [
  { role: 'button', fragments: ['btn', 'button'] },
  { role: 'menu', fragments: ['menu'] },
  { role: 'dialog', fragments: ['modal', 'dialog'] },
  { role: 'navigation', fragments: ['nav'] },
  { role: 'textbox', fragments: ['input', 'textbox'] },
  { role: 'link', fragments: ['link'] },
  { role: 'tab', fragments: ['tab'] },
  { role: 'tooltip', fragments: ['tooltip'] },
  { role: 'alert', fragments: ['alert'] },
];

const CLASS_PREFIXES = [
  'fa-solid-',
  'mdi-light-',
  'material-icons-',
  'feather-',
  'icon-',
  'mdi-',
  'fas-',
  'far-',
  'fab-',
  'fa-',
  'bi-',
];

export function inferRoleFromClass(classList: string[]): string | null {
  const normalized = classList.map((className) => className.trim().toLowerCase()).filter(Boolean);
  for (const pattern of ROLE_PATTERNS) {
    if (
      normalized.some((className) =>
        pattern.fragments.some((fragment) => className === fragment || className.includes(fragment)),
      )
    ) {
      return pattern.role;
    }
  }
  return null;
}

export function inferLabelFromSiblingContext(element: UnlabeledElement): string | null {
  const siblingContext = element.siblingContext.trim();
  if (siblingContext.length === 0) return null;

  const words = siblingContext.split(/\s+/).filter(Boolean);
  const lowerContext = siblingContext.toLowerCase();
  if (lowerContext.includes('search')) {
    const suffix = words
      .filter((word) => word.toLowerCase() !== 'search')
      .slice(0, 5)
      .join(' ');
    return suffix.length > 0 ? `Search ${toTitleCase(suffix)}` : 'Search';
  }

  if (words.length >= 1 && words.length <= 6) {
    return toTitleCase(siblingContext);
  }
  return null;
}

export function inferIconLabel(backgroundImageUrl: string | null, classSignature: string): string | null {
  const candidates = [
    ...classSignature
      .toLowerCase()
      .split(/\s+/)
      .map(stripKnownPrefix)
      .flatMap(expandCandidate),
    ...extractBackgroundCandidates(backgroundImageUrl),
  ];

  for (const candidate of candidates) {
    const label = ICON_LEXICON[candidate];
    if (label !== undefined) return label;
  }
  return null;
}

export function inferButtonFromPosition(
  bbox: { x: number; y: number; w: number; h: number },
  siblings: Array<{ role: string | null; text: string; bbox: { x: number; y: number; w: number; h: number } }>,
): string | null {
  for (const sibling of siblings) {
    const text = sibling.text.trim();
    const siblingCenterX = sibling.bbox.x + sibling.bbox.w / 2;
    const siblingCenterY = sibling.bbox.y + sibling.bbox.h / 2;
    const currentCenterX = bbox.x + bbox.w / 2;
    const currentCenterY = bbox.y + bbox.h / 2;
    const distance = Math.hypot(currentCenterX - siblingCenterX, currentCenterY - siblingCenterY);

    if ((sibling.role === 'searchbox' || text.toLowerCase().includes('search')) && distance <= 200) {
      return 'Search button';
    }

    if (text.endsWith(':')) {
      return toTitleCase(text.slice(0, -1));
    }

    if (text.endsWith('?') && bbox.x > sibling.bbox.x + sibling.bbox.w - 80 && bbox.y <= sibling.bbox.y + 80) {
      return 'Close';
    }
  }

  return null;
}

export function composeHeuristicLabel(element: UnlabeledElement): RecoveredLabel | null {
  const iconLabel = inferIconLabel(element.backgroundImageUrl, element.classSignature);
  const roleFromClass = inferRoleFromClass(element.classSignature.split(/\s+/));
  const siblingLabel = inferLabelFromSiblingContext(element);
  const positionLabel = inferButtonFromPosition(element.bbox, []);
  const signals: LabelSignal[] = [];

  if (iconLabel !== null) signals.push({ label: iconLabel, confidence: 0.75 });
  if (siblingLabel !== null) signals.push({ label: siblingLabel, confidence: 0.60 });
  if (positionLabel !== null) signals.push({ label: positionLabel, confidence: 0.50 });
  if (roleFromClass !== null && signals.length === 0) signals.push({ label: 'Control', confidence: 0.40 });
  if (signals.length === 0) return null;

  const chosen = signals.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );
  const agreementCount = signals.filter((signal) => normalizeLabel(signal.label) === normalizeLabel(chosen.label)).length;
  const confidence = Math.min(0.95, chosen.confidence + (agreementCount >= 2 ? 0.1 : 0));

  return {
    element,
    inferredRole: roleFromClass ?? element.computedRole ?? 'button',
    inferredLabel: chosen.label,
    inferredDescription: 'Auto-inferred via heuristic',
    confidence,
    source: 'heuristic',
    tier: 1,
  };
}

function toTitleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function stripKnownPrefix(value: string): string {
  let candidate = value.trim().replace(/_/g, '-');
  for (const prefix of CLASS_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  return candidate;
}

function expandCandidate(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split(/[^a-z0-9-]+/).filter(Boolean);
  return [trimmed, ...parts];
}

function extractBackgroundCandidates(backgroundImageUrl: string | null): string[] {
  if (backgroundImageUrl === null) return [];
  const cleanUrl = backgroundImageUrl.split(/[?#]/)[0] ?? '';
  const basename = cleanUrl.split('/').filter(Boolean).at(-1) ?? cleanUrl;
  const withoutExtension = basename.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/_/g, '-');
  return expandCandidate(stripKnownPrefix(withoutExtension));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
