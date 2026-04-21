import type { BrowserContext } from '@playwright/test';

/** Intercept outbound AI provider fetches (Gemini, Anthropic, Bedrock) and
 *  return canned responses so CI never burns real API credit.
 *
 *  Opt out per-test by passing `useAiMocks: false` to the fixture. */
export async function installAiMocks(context: BrowserContext): Promise<void> {
  await context.route(/generativelanguage\.googleapis\.com/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [
          { content: { parts: [{ text: '[mock] summary: key points unchanged.' }] } },
        ],
      }),
    }),
  );

  await context.route(/api\.anthropic\.com/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: [{ type: 'text', text: '[mock] claude summary' }],
        stop_reason: 'end_turn',
      }),
    }),
  );

  await context.route(/accessbridge\.space\/api\/ai/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: '[mock] bedrock summary', provider: 'mock' }),
    }),
  );
}
