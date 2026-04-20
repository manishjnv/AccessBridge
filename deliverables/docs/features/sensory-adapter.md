# Sensory Adapter

**Status:** Implemented  
**Package:** `@accessbridge/extension`  
**Source:** `packages/extension/src/content/sensory/adapter.ts`

## Overview

The Sensory Adapter applies visual and perceptual accessibility adaptations to web pages. It handles font scaling, contrast adjustment, color blindness correction, spacing adjustments, reading mode, reduced motion, and cursor sizing. All changes are non-destructive and fully reversible.

## Features

### Font Scaling
- **Range:** 0.5x to 3.0x (user-facing range: 0.8x - 2.0x)
- **Implementation:** Sets `--a11y-font-scale` CSS custom property on `:root`, adds `a11y-font-scaled` class to `<body>`
- **Trigger rule:** Struggle score > 40 and reading speed signal < 0.3 (normalized)
- **How it works:** A companion stylesheet (injected via `<style>` element) uses `calc()` with the custom property to scale `font-size` on key elements without breaking layout-critical pixel values.

### Contrast Adjustment
- **Range:** 0.5x to 3.0x
- **Implementation:** Sets `--a11y-contrast` CSS custom property, adds `a11y-contrast` class
- **Trigger rule:** Struggle score > 45 and zoom events signal > 0.5
- **How it works:** The injected stylesheet applies a CSS `filter: contrast(var(--a11y-contrast))` to the page body, preserving the original DOM while amplifying visual contrast.

### Color Correction (Color Blindness)
- **Modes:** Protanopia (red-blind), Deuteranopia (green-blind), Tritanopia (blue-blind)
- **Implementation:** SVG `<feColorMatrix>` filters injected into the DOM, applied via CSS `filter: url(#filter-id)`
- **How it works:**
  1. On initialization, the adapter injects an invisible `<svg>` element containing three `<filter>` definitions with clinically-derived color transformation matrices.
  2. When activated, a CSS `filter` property on `<body>` references the appropriate SVG filter by ID.
  3. The color matrices remap the color space so that colors that would be indistinguishable to a user with that type of color blindness are shifted to distinguishable hues.
- **Matrix values:**
  - Protanopia: shifts red channel toward green
  - Deuteranopia: shifts green channel toward red
  - Tritanopia: shifts blue channel toward green/red

### Line Height
- **Range:** 1.0 to 4.0
- **Implementation:** Sets `--a11y-line-height` CSS custom property, adds `a11y-line-height` class
- **Trigger rule:** Struggle score > 50 and reading speed < 0.3
- **Default:** 1.5 (profile default)

### Letter Spacing
- **Range:** 0px to 10px
- **Implementation:** Sets `--a11y-letter-spacing` CSS custom property, adds `a11y-letter-spacing` class
- **Default:** 0px (no extra spacing)

### Reading Mode
- **Implementation:** Adds `a11y-reading-mode` class to the main content element
- **Content detection:** Searches for `<main>`, `[role="main"]`, `<article>`, `#content`, or falls back to `<body>`
- **Trigger rule:** Struggle score > 65 and error rate > 0.6
- **Effect:** Strips visual clutter, widens the content column, applies dyslexia-friendly typography (increased spacing, clear sans-serif fonts), and mutes background colors.

### Reduced Motion
- **Implementation:** Adds `a11y-reduced-motion` class to `<body>`
- **Trigger rule:** Struggle score > 50 and scroll velocity > 0.6
- **Effect:** The companion stylesheet sets `animation-duration: 0.01ms !important`, `animation-iteration-count: 1 !important`, and `transition-duration: 0.01ms !important` on all elements, mirroring the `prefers-reduced-motion: reduce` media query behavior.

### Cursor Size
- **Threshold:** When size multiplier exceeds 1.5x, the `a11y-cursor-large` class is added
- **Trigger rule:** Struggle score > 70 and cursor path signal > 0.7
- **Effect:** The companion stylesheet overrides the cursor with a larger SVG-based cursor image.

## Technical Implementation

### CSS Injection Strategy

The Sensory Adapter uses a layered CSS injection approach:

1. **CSS Custom Properties** -- Values like font scale and contrast are set as custom properties on `document.documentElement.style`. This allows the companion stylesheet to use `var()` references that update instantly without re-injecting CSS.

2. **CSS Classes** -- Feature activation is controlled by adding/removing classes on `document.body`. The companion stylesheet contains pre-authored rules keyed to these classes. This approach avoids per-element style manipulation and works with Shadow DOM boundaries.

3. **SVG Filters** -- Color correction uses inline SVG filters because CSS-only alternatives cannot express the full color matrix transformation needed for clinical-grade color blindness correction.

4. **Style Element** -- A single `<style id="a11y-sensory-styles">` element is injected into `<head>` on initialization. The adapter reuses it across adaptations to avoid DOM bloat.

### Revert Mechanism

Calling `revertAll()` performs a complete cleanup:
- Removes all `a11y-*` CSS classes from `<body>` and content elements
- Clears all `--a11y-*` CSS custom properties from `:root`
- Removes the CSS `filter` property from `<body>`
- Clears the internal tracking set

Individual adaptations can also be reverted through the Decision Engine's `revertAdaptation(id)` method.

### Transition Handling

When adaptations are applied, the `a11y-transition` class is added to enable smooth CSS transitions. This prevents jarring visual jumps when font sizes or contrast levels change. The transition timing is kept short (200-300ms) to avoid creating a laggy feel.

## App-Specific Overrides

The generic Sensory Adapter works on any website. App-specific adapters (Gmail, Outlook) extend the base adapter with domain-specific knowledge:

- **Gmail:** Knows about Gmail's compose window (`.Am.Al.editable`), action buttons (`.T-I`), and sidebar (`.aeN`) for targeted adaptations.
- **Outlook:** Targets Outlook's reading pane and ribbon UI for focused adaptation.
- **Generic:** Falls back to semantic HTML selectors (`<main>`, `<article>`, `[role]`) for broad compatibility.

## Configuration

Users control sensory settings through the extension popup's Sensory tab. The profile stores:

```typescript
interface SensoryProfile {
  fontScale: number;           // 1.0 default
  contrastLevel: number;       // 1.0 default
  colorCorrectionMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  lineHeight: number;          // 1.5 default
  letterSpacing: number;       // 0 default
  cursorSize: number;          // 1.0 default
  reducedMotion: boolean;      // false default
  highContrast: boolean;       // false default
}
```

In `auto` mode, the Decision Engine adjusts these values based on struggle signals. In `suggest` mode, changes are proposed to the user first. In `manual` mode, only user-initiated changes take effect.
