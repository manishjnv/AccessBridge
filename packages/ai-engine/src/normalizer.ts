/**
 * Input normalisation utilities.
 *
 * Every function here aims to *reduce* the amount of text sent to an AI
 * provider, cutting token cost without losing meaningful content.
 */

// ---------------------------------------------------------------------------
// General text normalisation
// ---------------------------------------------------------------------------

/**
 * Trim, collapse whitespace, and optionally truncate.
 */
export function normalizeText(text: string, maxLength?: number): string {
  let result = text.trim().replace(/\s+/g, ' ');
  if (maxLength !== undefined && result.length > maxLength) {
    result = result.slice(0, maxLength);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Summarisation-specific truncation
// ---------------------------------------------------------------------------

/**
 * For very long texts, keep the first 3 000 characters (which usually
 * contain the thesis / introduction) and the last 500 characters (which
 * often contain the conclusion), separated by a marker.
 */
export function truncateForSummarization(text: string): string {
  const HEAD = 3000;
  const TAIL = 500;

  const normalised = normalizeText(text);
  if (normalised.length <= HEAD + TAIL + 50) {
    return normalised;
  }

  const head = normalised.slice(0, HEAD);
  const tail = normalised.slice(-TAIL);
  return `${head}\n\n[... content truncated for summarization ...]\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and collapse whitespace, yielding plain text content.
 */
export function extractKeyContent(html: string): string {
  // Remove script and style blocks entirely.
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Convert common block elements to newlines for readability.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n');

  // Strip remaining tags.
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities.
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return normalizeText(text);
}

// ---------------------------------------------------------------------------
// Email thread deduplication
// ---------------------------------------------------------------------------

/**
 * Remove quoted reply blocks from an email thread, keeping only the
 * unique (top-level) content of each message.
 */
export function deduplicateEmailThread(thread: string): string {
  const lines = thread.split('\n');
  const uniqueLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip common quote indicators.
    if (trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('On ') && trimmed.endsWith(' wrote:')) continue;
    if (trimmed === '---' || trimmed === '___') continue;
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(trimmed)) continue;
    if (/^From:.*Sent:.*To:/i.test(trimmed)) continue;

    uniqueLines.push(line);
  }

  return normalizeText(uniqueLines.join('\n'));
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token count estimate.  The widely-used heuristic for English is
 * approximately 1 token per 4 characters.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
