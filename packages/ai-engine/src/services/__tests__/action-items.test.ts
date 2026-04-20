// Tests for ActionItemsService: defensive JSON parsing, sanitization, deadline
// normalization, and try/catch graceful fallback.
import { describe, it, expect, vi } from 'vitest';
import { ActionItemsService } from '../action-items.js';
import type { AIEngine } from '../../engine.js';
import type { AIRequest, AIResponse } from '../../types.js';

function makeEngine(respond: (req: AIRequest) => Promise<AIResponse> | AIResponse): AIEngine {
  return {
    async process(req: AIRequest): Promise<AIResponse> {
      const r = await respond(req);
      return r;
    },
  } as unknown as AIEngine;
}

function okResp(output: string): AIResponse {
  return {
    id: 'test',
    output,
    cached: false,
    tier: 'local',
    provider: 'local',
    cost: 0,
    tokensUsed: 0,
    latencyMs: 1,
  } as unknown as AIResponse;
}

describe('ActionItemsService', () => {
  it('parses valid JSON array output', async () => {
    const svc = new ActionItemsService(
      makeEngine(() =>
        okResp(JSON.stringify([
          { task: 'Send report', assignee: 'Bob', deadline: '2026-05-01', priority: 'high', confidence: 0.9 },
        ])),
      ),
    );
    const items = await svc.extractActionItems('Send the report by Friday.', 'email');
    expect(items.length).toBe(1);
    expect(items[0]?.task).toBe('Send report');
    expect(items[0]?.assignee).toBe('Bob');
    expect(items[0]?.priority).toBe('high');
  });

  it('parses bracket-wrapped payload in malformed envelope', async () => {
    const svc = new ActionItemsService(
      makeEngine(() =>
        okResp('Here you go:\n[{"task":"Call vendor","priority":"medium","confidence":0.7}] end'),
      ),
    );
    const items = await svc.extractActionItems('Call the vendor.');
    expect(items.length).toBe(1);
    expect(items[0]?.task).toBe('Call vendor');
    expect(items[0]?.priority).toBe('medium');
  });

  it('returns [] on totally invalid output', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp('Sorry, I cannot process that')),
    );
    const items = await svc.extractActionItems('foo');
    expect(items).toEqual([]);
  });

  it('coerces unknown priority strings to low', async () => {
    const svc = new ActionItemsService(
      makeEngine(() =>
        okResp(JSON.stringify([
          { task: 'X', priority: 'critical', confidence: 0.5 },
        ])),
      ),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.priority).toBe('low');
  });

  it('clamps confidence to [0,1]: negative → 0', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X', confidence: -0.5 }]))),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.confidence).toBe(0);
  });

  it('clamps confidence >1 to 1', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X', confidence: 5 }]))),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.confidence).toBe(1);
  });

  it('defaults confidence to 0.5 for non-numeric / missing', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X' }]))),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.confidence).toBe(0.5);
  });

  it('keeps ISO date deadline as-is', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X', deadline: '2026-05-01' }]))),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.deadline).toBe('2026-05-01');
  });

  it('parses non-ISO parseable date string to ISO', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X', deadline: 'May 1, 2026' }]))),
    );
    const items = await svc.extractActionItems('x');
    // TZ-agnostic: Date.parse('May 1, 2026') resolves to local midnight, so
    // UTC representation may be 2026-04-30T18:30:00Z in +5:30 or 2026-05-01 elsewhere.
    // Assert the shape is valid ISO and year matches.
    expect(items[0]?.deadline).toMatch(/^2026-0[45]-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('keeps unparseable deadline string raw', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => okResp(JSON.stringify([{ task: 'X', deadline: 'sometime soon' }]))),
    );
    const items = await svc.extractActionItems('x');
    expect(items[0]?.deadline).toBe('sometime soon');
  });

  it('filters out items with empty task', async () => {
    const svc = new ActionItemsService(
      makeEngine(() =>
        okResp(JSON.stringify([
          { task: '', priority: 'high' },
          { task: 'Real task', priority: 'low' },
        ])),
      ),
    );
    const items = await svc.extractActionItems('x');
    expect(items.length).toBe(1);
    expect(items[0]?.task).toBe('Real task');
  });

  it('passes context through as metadata to engine.process', async () => {
    const spy = vi.fn<(req: AIRequest) => AIResponse>(() => okResp('[]'));
    const svc = new ActionItemsService(makeEngine(spy));
    await svc.extractActionItems('hello', 'meeting');
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0] as AIRequest;
    expect((call.metadata as { context?: string } | undefined)?.context).toBe('meeting');
  });

  it('returns [] when engine.process throws', async () => {
    const svc = new ActionItemsService(
      makeEngine(() => { throw new Error('boom'); }),
    );
    const items = await svc.extractActionItems('x');
    expect(items).toEqual([]);
  });
});
