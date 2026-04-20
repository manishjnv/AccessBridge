/**
 * Action item extraction service.
 *
 * Wraps the AI engine with pre-processing and defensive parsing for
 * structured action item extraction from emails, meetings, and documents.
 */

import { AIEngine } from '../engine.js';
import { normalizeText, truncateForSummarization } from '../normalizer.js';

export interface ActionItemResult {
  task: string;
  assignee: string | null;
  deadline: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
}

type ActionItemContext = 'email' | 'meeting' | 'doc' | 'generic';

export class ActionItemsService {
  private readonly engine: AIEngine;

  constructor(engine: AIEngine) {
    this.engine = engine;
  }

  async extractActionItems(
    text: string,
    context: ActionItemContext = 'generic',
  ): Promise<ActionItemResult[]> {
    const normalised = truncateForSummarization(normalizeText(text));
    let resp;
    try {
      resp = await this.engine.process({
        id: `action-items-${Date.now().toString(36)}`,
        type: 'action-items',
        input: normalised,
        metadata: { context },
      });
    } catch {
      // Engine/provider doesn't handle 'action-items' yet — return empty so
      // callers can fall back to pattern-based extraction. The local provider
      // is rule-based and this type may not have a specialized branch.
      return [];
    }

    const parsed = parseActionItemsOutput(resp.output);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => sanitizeActionItem(item))
      .filter((item): item is ActionItemResult => item !== null);
  }
}

function parseActionItemsOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];

    try {
      return JSON.parse(output.slice(start, end + 1)) as unknown;
    } catch {
      return [];
    }
  }
}

function sanitizeActionItem(item: unknown): ActionItemResult | null {
  if (!isRecord(item)) return null;

  const task = typeof item.task === 'string' ? item.task.trim() : '';
  if (task.length === 0) return null;

  return {
    task,
    assignee: normalizeNullableString(item.assignee),
    deadline: normalizeDeadline(item.deadline),
    priority: normalizePriority(item.priority),
    confidence: normalizeConfidence(item.confidence),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePriority(value: unknown): ActionItemResult['priority'] {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'low';
}

function normalizeConfidence(value: unknown): number {
  const confidence =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : 0.5;

  if (!Number.isFinite(confidence)) return 0.5;
  return Math.min(1, Math.max(0, confidence));
}

function normalizeDeadline(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(trimmed)) return trimmed;

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return trimmed;
  return new Date(timestamp).toISOString();
}
