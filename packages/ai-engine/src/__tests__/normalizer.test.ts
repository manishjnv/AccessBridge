import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  truncateForSummarization,
  extractKeyContent,
  deduplicateEmailThread,
  estimateTokenCount,
} from '../normalizer.js';

describe('normalizeText', () => {
  it('trims whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeText('hello   world\n\nfoo')).toBe('hello world foo');
  });

  it('truncates to maxLength', () => {
    expect(normalizeText('hello world', 5)).toBe('hello');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeText('')).toBe('');
  });
});

describe('truncateForSummarization', () => {
  it('returns short text unchanged', () => {
    const short = 'This is a short paragraph.';
    expect(truncateForSummarization(short)).toBe(short);
  });

  it('truncates long text keeping head and tail', () => {
    const longText = 'A'.repeat(3000) + ' middle content ' + 'B'.repeat(600);
    const result = truncateForSummarization(longText);
    expect(result).toContain('[... content truncated for summarization ...]');
    expect(result.length).toBeLessThan(longText.length);
  });

  it('preserves text at boundary length', () => {
    const text = 'x'.repeat(3550); // HEAD + TAIL + 50 = 3550
    const result = truncateForSummarization(text);
    expect(result).not.toContain('truncated');
  });
});

describe('extractKeyContent', () => {
  it('strips HTML tags', () => {
    expect(extractKeyContent('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script and style blocks', () => {
    const html = '<script>alert(1)</script><p>Text</p><style>.x{}</style>';
    expect(extractKeyContent(html)).toBe('Text');
  });

  it('converts block elements to newlines', () => {
    const html = '<h1>Title</h1><p>Body</p>';
    const result = extractKeyContent(html);
    expect(result).toContain('Title');
    expect(result).toContain('Body');
  });

  it('decodes HTML entities', () => {
    expect(extractKeyContent('&amp; &lt; &gt; &quot; &#039;')).toBe('& < > " \'');
  });

  it('decodes &nbsp;', () => {
    expect(extractKeyContent('hello&nbsp;world')).toBe('hello world');
  });
});

describe('deduplicateEmailThread', () => {
  it('removes quoted lines starting with >', () => {
    const thread = 'New reply here.\n> Quoted text\n> More quoted';
    expect(deduplicateEmailThread(thread)).toBe('New reply here.');
  });

  it('removes "On ... wrote:" lines', () => {
    const thread = 'Reply\nOn Mon, Jan 1 at 10:00 AM John wrote:\n> old';
    expect(deduplicateEmailThread(thread)).toBe('Reply');
  });

  it('removes separator lines', () => {
    const thread = 'Top message\n---\nOld content';
    const result = deduplicateEmailThread(thread);
    expect(result).toBe('Top message Old content');
  });

  it('removes "Original Message" separators', () => {
    const thread = 'New\n--- Original Message ---\nOld';
    const result = deduplicateEmailThread(thread);
    expect(result).not.toContain('Original Message');
  });
});

describe('estimateTokenCount', () => {
  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokenCount('hello world')).toBe(3); // 11 / 4 = 2.75 → 3
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(4000);
    expect(estimateTokenCount(text)).toBe(1000);
  });
});
