import type {
  AuditInput,
  AuditFinding,
  AuditRule,
  AuditNode,
  WCAGPrinciple,
  AuditSeverity,
  WCAGLevel,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a CSS color string into [r, g, b, a] (0-255 for rgb, 0-1 for a).
 * Handles: rgb(r,g,b), rgba(r,g,b,a), #rgb, #rrggbb
 */
export function parseRgb(str: string): [number, number, number, number] | null {
  if (!str) return null;
  const s = str.trim();

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    return [r, g, b, a];
  }

  // #rgb shorthand
  const hex3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (hex3) {
    return [
      parseInt(hex3[1] + hex3[1], 16),
      parseInt(hex3[2] + hex3[2], 16),
      parseInt(hex3[3] + hex3[3], 16),
      1,
    ];
  }

  // #rrggbb
  const hex6 = s.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (hex6) {
    return [
      parseInt(hex6[1], 16),
      parseInt(hex6[2], 16),
      parseInt(hex6[3], 16),
      1,
    ];
  }

  return null;
}

/** WCAG 2.x relative luminance from an [r, g, b] triplet (0-255). */
export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between foreground and background color strings.
 * Returns null if either color is unparseable or bg has alpha < 1.
 */
export function contrastRatio(fg: string, bg: string): number | null {
  const fgParsed = parseRgb(fg);
  const bgParsed = parseRgb(bg);
  if (!fgParsed || !bgParsed) return null;
  if (bgParsed[3] < 1) return null;

  const l1 = relativeLuminance([fgParsed[0], fgParsed[1], fgParsed[2]]);
  const l2 = relativeLuminance([bgParsed[0], bgParsed[1], bgParsed[2]]);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Build a CSS-like selector string for an audit node. */
export function buildElementSelector(node: AuditNode): string {
  const idPart = node.id ? `#${node.id}` : '';
  const classPart = node.classes.length > 0 ? `.${node.classes[0]}` : '';
  return `${node.tag}${idPart}${classPart}`;
}

/**
 * Map a WCAG criterion's first digit to its principle.
 * 1 → perceivable, 2 → operable, 3 → understandable, 4 → robust
 */
export function principleForCriterion(criterion: string): WCAGPrinciple {
  const first = criterion.trim().charAt(0);
  switch (first) {
    case '1': return 'perceivable';
    case '2': return 'operable';
    case '3': return 'understandable';
    case '4': return 'robust';
    default: return 'robust';
  }
}

// ---------------------------------------------------------------------------
// Internal rule-building utilities
// ---------------------------------------------------------------------------

function makeFindingId(ruleId: string, nodeIndex: number | null, seq: number): string {
  return `${ruleId}-${nodeIndex ?? 'global'}-${seq}`;
}

function baseFinding(
  ruleId: string,
  ruleName: string,
  criterion: string,
  level: WCAGLevel,
  severity: AuditSeverity,
  node: AuditNode | null,
  message: string,
  suggestion: string,
  seq: number,
): AuditFinding {
  const nodeIndex = node?.index ?? null;
  return {
    id: makeFindingId(ruleId, nodeIndex, seq),
    ruleId,
    rule: ruleName,
    wcagCriterion: criterion,
    wcagPrinciple: principleForCriterion(criterion),
    level,
    severity,
    nodeIndex,
    elementSelector: node ? buildElementSelector(node) : 'document',
    message,
    suggestion,
    htmlSnippet: node?.htmlSnippet ?? '',
  };
}

// ---------------------------------------------------------------------------
// The 20 audit rules
// ---------------------------------------------------------------------------

export const AUDIT_RULES: AuditRule[] = [
  // -----------------------------------------------------------------------
  // 1. img-alt — 1.1.1 · A · critical
  // -----------------------------------------------------------------------
  {
    id: 'img-alt',
    name: 'Images must have alternative text',
    wcagCriterion: '1.1.1',
    wcagPrinciple: 'perceivable',
    level: 'A',
    severity: 'critical',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tag !== 'img') continue;
        // Session 10: skip elements where vision-recovery provided an aria-label.
        // The auto-recovered-info rule emits a separate info-level finding instead.
        if (el.dataRecovered) continue;
        // alt === null means attribute missing; alt === '' is decorative (valid)
        if (
          el.alt === null &&
          !el.ariaLabel &&
          !el.ariaLabelledBy &&
          el.role !== 'presentation'
        ) {
          findings.push(baseFinding(
            'img-alt', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            'Image is missing an alt attribute.',
            'Add an alt attribute. Use alt="" for decorative images.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 2. empty-link — 2.4.4 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'empty-link',
    name: 'Links must have discernible text',
    wcagCriterion: '2.4.4',
    wcagPrinciple: 'operable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tag !== 'a') continue;
        if (!el.href || el.href.trim() === '') continue;
        if (el.dataRecovered) continue;
        const hasName =
          el.text.trim().length > 0 ||
          (el.ariaLabel !== null && el.ariaLabel.trim() !== '') ||
          (el.title !== null && el.title.trim() !== '');
        if (!hasName) {
          findings.push(baseFinding(
            'empty-link', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            'Link has no accessible name.',
            'Add descriptive link text, an aria-label, or a title attribute.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 3. empty-button — 4.1.2 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'empty-button',
    name: 'Buttons must have discernible text',
    wcagCriterion: '4.1.2',
    wcagPrinciple: 'robust',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tag !== 'button' && el.role !== 'button') continue;
        if (el.dataRecovered) continue;
        const hasName =
          el.text.trim().length > 0 ||
          (el.ariaLabel !== null && el.ariaLabel.trim() !== '') ||
          (el.title !== null && el.title.trim() !== '');
        if (!hasName) {
          findings.push(baseFinding(
            'empty-button', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            'Button has no accessible name.',
            'Add button text, an aria-label, or a title attribute.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 4. form-label — 3.3.2 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'form-label',
    name: 'Form inputs must have labels',
    wcagCriterion: '3.3.2',
    wcagPrinciple: 'understandable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const EXEMPT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
      for (const el of input.elements) {
        const isFormControl =
          (el.tag === 'input' && !EXEMPT_TYPES.has(el.type ?? '')) ||
          el.tag === 'select' ||
          el.tag === 'textarea';
        if (!isFormControl) continue;
        const hasLabel =
          el.hasLabelElement ||
          (el.ariaLabel !== null && el.ariaLabel.trim() !== '') ||
          (el.ariaLabelledBy !== null && el.ariaLabelledBy.trim() !== '') ||
          (el.title !== null && el.title.trim() !== '');
        if (!hasLabel) {
          findings.push(baseFinding(
            'form-label', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            'Form control has no associated label.',
            'Add a <label> element, aria-label, aria-labelledby, or title attribute. Placeholder text alone is not a label.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 5. heading-order — 1.3.1 · AA · moderate
  // -----------------------------------------------------------------------
  {
    id: 'heading-order',
    name: 'Heading levels must not be skipped',
    wcagCriterion: '1.3.1',
    wcagPrinciple: 'perceivable',
    level: 'AA',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const headings = input.headings;
      if (headings.length === 0) return findings;

      // Flag multiple h1
      const h1s = headings.filter((h) => h.level === 1);
      if (h1s.length > 1) {
        for (let i = 1; i < h1s.length; i++) {
          const nodeIndex = h1s[i].nodeIndex;
          const el = input.elements[nodeIndex] ?? null;
          findings.push(baseFinding(
            'heading-order', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Multiple <h1> elements found (${h1s.length} total). Only one h1 is recommended.`,
            'Ensure the page has a single h1 as the main heading.',
            seq++,
          ));
        }
      }

      // Flag level jumps of 2+
      for (let i = 1; i < headings.length; i++) {
        const prev = headings[i - 1];
        const curr = headings[i];
        if (curr.level - prev.level >= 2) {
          const el = input.elements[curr.nodeIndex] ?? null;
          findings.push(baseFinding(
            'heading-order', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Heading level skipped: h${prev.level} followed by h${curr.level}.`,
            `Do not skip heading levels. Use h${prev.level + 1} instead of h${curr.level}.`,
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 6. contrast-aa — 1.4.3 · AA · serious
  // -----------------------------------------------------------------------
  {
    id: 'contrast-aa',
    name: 'Text must meet WCAG AA contrast ratio',
    wcagCriterion: '1.4.3',
    wcagPrinciple: 'perceivable',
    level: 'AA',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.text.trim().length === 0) continue;
        if (el.style.visibility !== 'visible') continue;
        if (el.style.opacity < 1) continue;
        const ratio = contrastRatio(el.style.color, el.style.backgroundColor);
        if (ratio === null) continue;
        const isLarge =
          el.style.fontSize >= 18 ||
          (el.style.fontSize >= 14 && el.style.fontWeight >= 700);
        const required = isLarge ? 3.0 : 4.5;
        if (ratio < required) {
          findings.push(baseFinding(
            'contrast-aa', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Contrast ratio ${ratio.toFixed(2)}:1 is below the required ${required}:1 (${isLarge ? 'large' : 'normal'} text).`,
            `Increase the contrast between foreground (${el.style.color}) and background (${el.style.backgroundColor}).`,
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 7. contrast-aaa — 1.4.6 · AAA · moderate
  // -----------------------------------------------------------------------
  {
    id: 'contrast-aaa',
    name: 'Text must meet WCAG AAA contrast ratio',
    wcagCriterion: '1.4.6',
    wcagPrinciple: 'perceivable',
    level: 'AAA',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.text.trim().length === 0) continue;
        if (el.style.visibility !== 'visible') continue;
        if (el.style.opacity < 1) continue;
        const ratio = contrastRatio(el.style.color, el.style.backgroundColor);
        if (ratio === null) continue;
        const isLarge =
          el.style.fontSize >= 18 ||
          (el.style.fontSize >= 14 && el.style.fontWeight >= 700);
        const required = isLarge ? 4.5 : 7.0;
        if (ratio < required) {
          findings.push(baseFinding(
            'contrast-aaa', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Contrast ratio ${ratio.toFixed(2)}:1 is below the AAA requirement of ${required}:1 (${isLarge ? 'large' : 'normal'} text).`,
            `Increase the contrast between foreground (${el.style.color}) and background (${el.style.backgroundColor}) to meet AAA.`,
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 8. target-size-aa — 2.5.8 · AA · moderate
  // -----------------------------------------------------------------------
  {
    id: 'target-size-aa',
    name: 'Interactive elements must meet minimum target size (AA: 24×24 px)',
    wcagCriterion: '2.5.8',
    wcagPrinciple: 'operable',
    level: 'AA',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const INTERACTIVE_TAGS = new Set(['a', 'button']);
      const INTERACTIVE_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'checkbox', 'radio']);
      for (const el of input.elements) {
        const isInteractive =
          INTERACTIVE_TAGS.has(el.tag) ||
          (el.tag === 'input' && INTERACTIVE_INPUT_TYPES.has(el.type ?? '')) ||
          el.role === 'button' ||
          el.role === 'link';
        if (!isInteractive) continue;
        // Skip zero-size off-screen elements
        if (el.bbox.w === 0 && el.bbox.h === 0) continue;
        if (el.bbox.w < 24 || el.bbox.h < 24) {
          findings.push(baseFinding(
            'target-size-aa', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Interactive element is too small: ${el.bbox.w}×${el.bbox.h}px (minimum 24×24px).`,
            'Increase the target size to at least 24×24 CSS pixels.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 9. target-size-aaa — 2.5.5 · AAA · minor
  // -----------------------------------------------------------------------
  {
    id: 'target-size-aaa',
    name: 'Interactive elements must meet enhanced target size (AAA: 44×44 px)',
    wcagCriterion: '2.5.5',
    wcagPrinciple: 'operable',
    level: 'AAA',
    severity: 'minor',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const INTERACTIVE_TAGS = new Set(['a', 'button']);
      const INTERACTIVE_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'checkbox', 'radio']);
      for (const el of input.elements) {
        const isInteractive =
          INTERACTIVE_TAGS.has(el.tag) ||
          (el.tag === 'input' && INTERACTIVE_INPUT_TYPES.has(el.type ?? '')) ||
          el.role === 'button' ||
          el.role === 'link';
        if (!isInteractive) continue;
        if (el.bbox.w === 0 && el.bbox.h === 0) continue;
        if (el.bbox.w < 44 || el.bbox.h < 44) {
          findings.push(baseFinding(
            'target-size-aaa', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Interactive element is below enhanced target size: ${el.bbox.w}×${el.bbox.h}px (recommended 44×44px).`,
            'Increase the target size to at least 44×44 CSS pixels for optimal accessibility.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 10. document-lang — 3.1.1 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'document-lang',
    name: 'Page must have a language attribute',
    wcagCriterion: '3.1.1',
    wcagPrinciple: 'understandable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      if (input.documentLang && input.documentLang.trim() !== '') return [];
      return [
        {
          id: makeFindingId('document-lang', null, 0),
          ruleId: 'document-lang',
          rule: 'Page must have a language attribute',
          wcagCriterion: '3.1.1',
          wcagPrinciple: 'understandable',
          level: 'A',
          severity: 'serious',
          nodeIndex: null,
          elementSelector: 'html',
          message: 'The <html> element is missing a lang attribute.',
          suggestion: 'Add a lang attribute to the <html> element, e.g. lang="en".',
          htmlSnippet: '',
        },
      ];
    },
  },

  // -----------------------------------------------------------------------
  // 11. duplicate-id — 4.1.1 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'duplicate-id',
    name: 'IDs must be unique',
    wcagCriterion: '4.1.1',
    wcagPrinciple: 'robust',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      return input.duplicateIds.map((dupId, seq) => ({
        id: makeFindingId('duplicate-id', null, seq),
        ruleId: 'duplicate-id',
        rule: 'IDs must be unique',
        wcagCriterion: '4.1.1',
        wcagPrinciple: 'robust' as WCAGPrinciple,
        level: 'A' as const,
        severity: 'serious' as AuditSeverity,
        nodeIndex: null,
        elementSelector: `[id="${dupId}"]`,
        message: `Duplicate id "${dupId}" found on multiple elements.`,
        suggestion: `Ensure each id attribute value is unique across the page. Rename one of the elements with id="${dupId}".`,
        htmlSnippet: '',
      }));
    },
  },

  // -----------------------------------------------------------------------
  // 12. table-headers — 1.3.1 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'table-headers',
    name: 'Data tables must have headers',
    wcagCriterion: '1.3.1',
    wcagPrinciple: 'perceivable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const table of input.tables) {
        if (table.hasHeaders) continue;
        if (table.rowCount <= 1 || table.colCount <= 1) continue;
        const el = input.elements[table.nodeIndex] ?? null;
        findings.push(baseFinding(
          'table-headers', this.name, this.wcagCriterion, this.level, this.severity,
          el,
          `Data table (${table.rowCount} rows × ${table.colCount} cols) has no header cells (<th>).`,
          'Add <th> elements to identify column or row headers. Consider adding a <caption> for context.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 13. keyboard-trap — 2.1.2 · A · moderate
  // -----------------------------------------------------------------------
  {
    id: 'keyboard-trap',
    name: 'Keyboard focus must not be trapped',
    wcagCriterion: '2.1.2',
    wcagPrinciple: 'operable',
    level: 'A',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tag !== 'div') continue;
        if (el.tabIndex === null) continue;
        if (el.tabIndex > 0 || el.tabIndex >= 10) {
          findings.push(baseFinding(
            'keyboard-trap', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `<div> with tabindex="${el.tabIndex}" may create a keyboard trap.`,
            'Avoid positive tabindex values on div elements. Use tabindex="0" for focusable divs and ensure keyboard users can navigate away.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 14. autoplay-media — 1.4.2 · A · serious (critical if no controls+unmuted)
  // -----------------------------------------------------------------------
  {
    id: 'autoplay-media',
    name: 'Autoplaying media must be controllable',
    wcagCriterion: '1.4.2',
    wcagPrinciple: 'perceivable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const idx of input.autoplayMedia) {
        const el = input.elements[idx];
        if (!el) continue;
        const severity: AuditSeverity =
          el.muted === false && el.controls === false ? 'critical' : 'serious';
        findings.push(baseFinding(
          'autoplay-media', this.name, this.wcagCriterion, this.level, severity,
          el,
          `Media element autoplays${el.muted ? ' (muted)' : ' with audio'}${el.controls ? ' with controls' : ' without controls'}.`,
          'Avoid autoplay for media with audio, or provide a mechanism to pause/stop it.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 15. flashing-content — 2.3.1 · A · serious (critical for flash/blink/strobe)
  // -----------------------------------------------------------------------
  {
    id: 'flashing-content',
    name: 'Content must not flash more than 3 times per second',
    wcagCriterion: '2.3.1',
    wcagPrinciple: 'operable',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const DANGER_CLASSES = new Set(['flash', 'blink', 'strobe']);
      for (const idx of input.animatedElements) {
        const el = input.elements[idx];
        if (!el) continue;
        const hasDangerClass = el.classes.some((c) => DANGER_CLASSES.has(c.toLowerCase()));
        const severity: AuditSeverity = hasDangerClass ? 'critical' : 'serious';
        findings.push(baseFinding(
          'flashing-content', this.name, this.wcagCriterion, this.level, severity,
          el,
          `Animated element may cause seizures${hasDangerClass ? ' (flash/blink/strobe class detected)' : ''}.`,
          'Ensure animated content does not flash more than 3 times per second. Use prefers-reduced-motion media query.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 16. skip-link — 2.4.1 · A · moderate
  // -----------------------------------------------------------------------
  {
    id: 'skip-link',
    name: 'Page must provide a skip navigation link',
    wcagCriterion: '2.4.1',
    wcagPrinciple: 'operable',
    level: 'A',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      if (input.skipLinks.length > 0) return [];
      if (input.landmarks.length === 0) return [];
      return [
        {
          id: makeFindingId('skip-link', null, 0),
          ruleId: 'skip-link',
          rule: 'Page must provide a skip navigation link',
          wcagCriterion: '2.4.1',
          wcagPrinciple: 'operable',
          level: 'A',
          severity: 'moderate',
          nodeIndex: null,
          elementSelector: 'document',
          message: 'No skip navigation link found. The page has landmark regions but no skip link.',
          suggestion: 'Add a "Skip to main content" link as the first focusable element on the page.',
          htmlSnippet: '',
        },
      ];
    },
  },

  // -----------------------------------------------------------------------
  // 17. frame-title — 4.1.2 · A · serious
  // -----------------------------------------------------------------------
  {
    id: 'frame-title',
    name: 'Frames must have a title attribute',
    wcagCriterion: '4.1.2',
    wcagPrinciple: 'robust',
    level: 'A',
    severity: 'serious',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const frame of input.frames) {
        if (frame.title && frame.title.trim() !== '') continue;
        const el = input.elements[frame.nodeIndex] ?? null;
        findings.push(baseFinding(
          'frame-title', this.name, this.wcagCriterion, this.level, this.severity,
          el,
          `Frame or iframe is missing a title attribute.`,
          'Add a descriptive title attribute to the frame element.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 18. focus-order — 2.4.3 · A · moderate
  // -----------------------------------------------------------------------
  {
    id: 'focus-order',
    name: 'Focus order must be logical (avoid positive tabindex)',
    wcagCriterion: '2.4.3',
    wcagPrinciple: 'operable',
    level: 'A',
    severity: 'moderate',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tabIndex === null) continue;
        if (el.tabIndex > 0) {
          findings.push(baseFinding(
            'focus-order', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `Element has tabindex="${el.tabIndex}" which disrupts the natural focus order.`,
            'Remove the positive tabindex or restructure the DOM to achieve the desired focus order.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 19. link-purpose — 2.4.4 · AA · minor
  // -----------------------------------------------------------------------
  {
    id: 'link-purpose',
    name: 'Link text must be descriptive',
    wcagCriterion: '2.4.4',
    wcagPrinciple: 'operable',
    level: 'AA',
    severity: 'minor',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      const VAGUE_TEXTS = new Set([
        'click here', 'read more', 'more', 'here', 'link', 'details', 'this',
      ]);
      for (const el of input.elements) {
        if (el.tag !== 'a') continue;
        const linkText = el.text.trim().toLowerCase();
        if (!VAGUE_TEXTS.has(linkText)) continue;
        if (el.ariaLabel && el.ariaLabel.trim() !== '') continue;
        findings.push(baseFinding(
          'link-purpose', this.name, this.wcagCriterion, this.level, this.severity,
          el,
          `Link text "${el.text.trim()}" is not descriptive out of context.`,
          'Replace vague link text with a description of the link destination or add an aria-label.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 21. auto-recovered-info — 4.1.2 · A · info (Session 10)
  // Reports elements whose accessible name was auto-inferred by AccessBridge
  // Vision Recovery. Downgrades the severity of the original img-alt / empty-button /
  // empty-link findings by replacing the critical/serious finding with an info
  // finding that encourages permanent author-side labels.
  // -----------------------------------------------------------------------
  {
    id: 'auto-recovered-info',
    name: 'Element accessible name was auto-inferred by AccessBridge',
    wcagCriterion: '4.1.2',
    wcagPrinciple: 'robust',
    level: 'A',
    severity: 'info',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (!el.dataRecovered) continue;
        findings.push(baseFinding(
          'auto-recovered-info', this.name, this.wcagCriterion, this.level, this.severity,
          el,
          `Auto-labeled by AccessBridge (${el.dataRecovered}). Element had no accessible name.`,
          'Consider adding a permanent alt / aria-label so every user-agent—including those without AccessBridge—can surface this control.',
          seq++,
        ));
      }
      return findings;
    },
  },

  // -----------------------------------------------------------------------
  // 20. redundant-title — 2.4.9 · AAA · info
  // -----------------------------------------------------------------------
  {
    id: 'redundant-title',
    name: 'Title attribute must not duplicate accessible name',
    wcagCriterion: '2.4.9',
    wcagPrinciple: 'operable',
    level: 'AAA',
    severity: 'info',
    check(input: AuditInput): AuditFinding[] {
      const findings: AuditFinding[] = [];
      let seq = 0;
      for (const el of input.elements) {
        if (el.tag !== 'a' && el.tag !== 'button') continue;
        if (!el.title || el.title.trim() === '') continue;
        if (el.title.trim().toLowerCase() === el.text.trim().toLowerCase()) {
          findings.push(baseFinding(
            'redundant-title', this.name, this.wcagCriterion, this.level, this.severity,
            el,
            `The title attribute duplicates the element's text content: "${el.title}".`,
            'The title attribute adds no additional information. Remove it or provide a unique description.',
            seq++,
          ));
        }
      }
      return findings;
    },
  },
];
