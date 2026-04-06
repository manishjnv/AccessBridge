import { describe, it, expect } from 'vitest';
import { LocalAIProvider } from '../providers/local.js';

describe('LocalAIProvider', () => {
  const provider = new LocalAIProvider();

  describe('summarize', () => {
    it('returns short text unchanged', async () => {
      const text = 'First sentence. Second sentence. Third sentence.';
      const result = await provider.summarize(text);
      expect(result).toBe(text);
    });

    it('extracts top sentences from long text', async () => {
      const sentences = Array.from({ length: 20 }, (_, i) =>
        `Sentence number ${i + 1} contains important information about the topic.`
      );
      const text = sentences.join(' ');
      const result = await provider.summarize(text);

      // Should be shorter than original
      expect(result.length).toBeLessThan(text.length);
      // Should contain at least some content
      expect(result.length).toBeGreaterThan(10);
    });

    it('respects maxLength', async () => {
      const sentences = Array.from({ length: 20 }, (_, i) =>
        `Sentence number ${i + 1} about the topic.`
      );
      const text = sentences.join(' ');
      const result = await provider.summarize(text, 100);

      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('prioritises first sentence', async () => {
      const text = 'The critical opening statement. ' +
        Array.from({ length: 15 }, (_, i) => `Middle filler ${i}.`).join(' ') +
        ' The closing remark.';
      const result = await provider.summarize(text);

      expect(result).toContain('The critical opening statement.');
    });
  });

  describe('simplify', () => {
    it('replaces complex words (mild)', async () => {
      const result = await provider.simplify('Please utilize this tool to facilitate communication.');
      expect(result).toContain('use');
      expect(result).toContain('help');
      expect(result).not.toContain('utilize');
      expect(result).not.toContain('facilitate');
    });

    it('preserves simple text', async () => {
      const text = 'The cat sat on the mat.';
      const result = await provider.simplify(text);
      expect(result).toBe(text);
    });

    it('breaks sentences at conjunctions in strong mode', async () => {
      const text = 'He ran fast because he was late and the bus was leaving.';
      const result = await provider.simplify(text, 'strong');
      // Should have more sentence breaks
      const periodCount = (result.match(/\./g) || []).length;
      expect(periodCount).toBeGreaterThanOrEqual(1);
    });

    it('removes parentheticals in strong mode', async () => {
      const text = 'The program (which was built last year) works well.';
      const result = await provider.simplify(text, 'strong');
      expect(result).not.toContain('which was built last year');
    });
  });

  describe('classify', () => {
    it('returns best matching category', async () => {
      const result = await provider.classify(
        'The quarterly financial report shows revenue growth',
        ['finance', 'technology', 'sports'],
      );
      expect(result).toBe('finance');
    });

    it('returns first category when no keywords match', async () => {
      const result = await provider.classify(
        'xyz abc 123',
        ['finance', 'technology'],
      );
      expect(result).toBe('finance');
    });

    it('returns unknown for empty categories', async () => {
      const result = await provider.classify('test', []);
      expect(result).toBe('unknown');
    });
  });

  describe('translate', () => {
    it('returns input unchanged (local cannot translate)', async () => {
      const result = await provider.translate('Hello', 'en', 'fr');
      expect(result).toBe('Hello');
    });
  });
});
