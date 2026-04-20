# AccessBridge — UI Guidelines

Canonical tokens, component patterns, and branding rules for every surface — landing page, extension popup, side panel, content-script overlays, and any future deliverable on the [ROADMAP](ROADMAP.md).

**Reality first, aspiration second.** Every value here is in use somewhere in the codebase today. Sections marked ⚠ note corrections to apply.

---

## 1. Color Tokens (canonical)

Landing page CSS custom properties are the source of truth. All other surfaces must match.

### Brand core

| Token | Hex | CSS var | Used for |
|---|---|---|---|
| Primary | `#7b68ee` | `--primary` | Brand gradient start, primary CTAs, focus glow (not ring), brand logo mark |
| Accent | `#bb86fc` | `--accent` | Brand gradient end, highlights, interactive hover states, bright links |

### Surfaces (dark theme — baseline)

| Token | Hex | CSS var | Used for |
|---|---|---|---|
| BG | `#0a0a1a` | `--bg` | Page background |
| BG Alt | `#0d0d22` | `--bg-alt` | Section dividers, alt sections |
| Surface | `#1a1a2e` | `--surface` | Cards, panels, popup chrome |
| Surface hover | `#222240` | `--surface-hover` | Card hover state |

### Text

| Token | Hex | CSS var | Used for |
|---|---|---|---|
| Text | `#e2e8f0` | `--text` | Primary body text |
| Muted | `#94a3b8` | `--muted` | Secondary labels, microcopy, placeholders |

### Status

| Token | Hex | CSS var | Used for |
|---|---|---|---|
| Success | `#10b981` | `--success` | Health-ok, low-struggle score, confirmations |
| Warning | `#f59e0b` | `--warning` | Medium struggle, caution states |
| Danger | `#ef4444` | — | High-struggle, errors (content scripts) |

### Focus indicator (accessibility exception)

| Token | Hex | Used for |
|---|---|---|
| Focus ring | `#e94560` | 3px solid outline + 6px halo on keyboard focus in content scripts |

**Why coral for focus?** Maximum contrast against purple surfaces — WCAG 2.1 focus-visible requires ≥3:1 contrast with adjacent colors, and a second purple-family color would violate that. Coral-red is kept exclusively for this semantic role; do not use it as a decorative accent.

### Glow (derived)

| Token | Value |
|---|---|
| `--glow` | `rgba(123, 104, 238, 0.35)` — primary at 35% alpha |

All purple shadows derive from `--glow` or `rgba(123, 104, 238, <alpha>)` with alpha ∈ {0.08, 0.15, 0.18, 0.25, 0.35, 0.4, 0.55}.

---

## 2. Gradients

Always **135°** diagonal unless the surface demands otherwise.

### Primary gradient (brand)

```css
background: linear-gradient(135deg, var(--primary), var(--accent));
```

Used for: brand text fill, primary buttons, navbar brand mark, back-to-top button, section pill borders.

### Hero text gradient (triple-stop)

```css
background: linear-gradient(135deg, #fff 0%, var(--primary) 40%, var(--accent) 100%);
-webkit-background-clip: text;
```

Reserved for the H1 on the landing hero. Don't reuse elsewhere.

### Surface elevation (subtle)

```css
background: linear-gradient(180deg, var(--bg) 0%, var(--bg-alt) 100%);
```

Used for: section background transitions (e.g. roadmap section).

### Radial bloom (decorative only)

```css
background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(123, 104, 238, 0.18) 0%, transparent 70%);
```

Used for: hero background halo. Never on interactive elements.

---

## 3. Typography

### Families

| Context | Stack | Why |
|---|---|---|
| Landing / marketing | `'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif` | Web font loaded; consistent visual weight across OSes |
| Extension popup / side panel | `system-ui, -apple-system, sans-serif` | Cold-start performance — no web font fetch on popup open |
| Code / monospace | `'SF Mono', 'Fira Code', 'Consolas', 'Monaco', monospace` | — |
| Reading mode (accessibility) | `'OpenDyslexic', 'Comic Sans MS', 'Atkinson Hyperlegible', sans-serif` | User-selected dyslexia-friendly option |

### Weights used

`400` body · `500` secondary labels · `600` emphasis / nav · `700` headings · `800` brand text / display · `900` hero H1 only

### Size scale

| Px | Role |
|---|---|
| 10 | Micro labels (TOP on back-to-top), uppercase tracking |
| 11 | Pill badges, nav-stat labels |
| 12 | Footer microcopy, timestamps, footer links |
| 13 | Nav links, body in popup |
| 13.5 | Roadmap tier list items |
| 14 | Standard body, panel text |
| 15–16 | Subheadings, instruction text |
| 18–22 | Section subheadings |
| 28–40 | Section H2 (clamp-scaled) |
| 56–80 | Hero H1 only (clamp-scaled) |

Use `clamp(min, vw, max)` for responsive display text; fixed px for UI chrome.

---

## 4. Spacing Scale

4px rhythm. Preferred values:

**Micro:** 4 · 6 · 8 · 10 · 12
**Standard:** 14 · 16 · 18 · 20 · 24
**Section:** 28 · 32 · 40 · 48 · 56 · 72
**Hero:** 90 · 120

Horizontal padding on containers: `5vw` (landing) or `16–20px` (popup).

---

## 5. Border Radius

| Radius | Use |
|---|---|
| 4px | Inline code, very small controls |
| 6px | Nav-stat badges, small chips |
| 7px | Navbar brand mark |
| 8px | Inputs, select menus |
| 10px | Buttons, demo chrome |
| 12px | Secondary cards, stat tiles |
| 14px | Feature cards |
| 16px | Primary cards, roadmap tier cards |
| 18–20px | Demo card, install CTA |
| 24px | Hero badge, hero CTA |
| 999px | Pills, section labels, nav stat pills |
| 50% | Circles — avatars, back-to-top, dwell indicator, gaze cursor |

---

## 6. Shadow & Elevation

Three tiers + purple-glow variant for brand emphasis.

### Shadow tokens (recommend codifying as vars later)

```css
--shadow-sm: 0 2px 10px rgba(0,0,0,0.15);
--shadow-md: 0 4px 16px rgba(0,0,0,0.25);
--shadow-lg: 0 8px 32px rgba(0,0,0,0.45);

--shadow-glow-sm: 0 4px 12px var(--glow);
--shadow-glow-md: 0 8px 24px var(--glow);
--shadow-glow-lg: 0 12px 40px rgba(123, 104, 238, 0.45);

--shadow-ring: 0 0 0 4px rgba(123, 104, 238, 0.18);  /* soft halo for focus/hover */
```

### Double-shadow pattern (brand elements)

```css
box-shadow: 0 10px 30px var(--glow), 0 0 0 6px rgba(123, 104, 238, 0.18);
```

Used for: back-to-top button, primary CTA hover, dwell-click indicator. Creates a lifted-with-halo effect.

---

## 7. Transitions

| Role | Duration | Easing |
|---|---|---|
| Micro (transform on hover) | `0.15s` | default |
| Standard (color, opacity) | `0.2s` | default |
| Emphasis (box-shadow, background) | `0.25s` | default |
| Scroll / reveal | `0.6s` | `ease` |

Use `passive: true` on all `window.scroll` listeners.

---

## 8. Iconography

### Logo mark

[deploy/favicon.svg](deploy/favicon.svg) — the canonical mark.

- Rounded-square container (rx=14 on 64-viewBox)
- Filled with primary → accent gradient (135°)
- White inner glyph (stylized "A" with a horizontal crossbar and a bridge arc)
- Stroke weights: 4.5 / 3.5 / 2.8

Never display the mark on a light background without an adequate purple-gradient halo. Minimum size: 16×16 (favicon grade).

### UI icons

- All inline SVG; no icon font.
- viewBox: `0 0 24 24` for UI icons; `0 0 64 64` for logo variants.
- Stroke style: `fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"`.
- Size: 14px (nav), 16px (buttons), 18px (brand mark), 22–26px (back-to-top, large CTAs).

---

## 9. Component Patterns

### Primary button (CTA)

```css
background: linear-gradient(135deg, var(--primary), var(--accent));
color: #fff;
padding: 10px 20px;         /* or 12px 28px for large */
border-radius: 10px;
font-weight: 600;
font-size: 13–14px;
box-shadow: 0 4px 12px var(--glow);
transition: transform 0.2s, box-shadow 0.2s;
```

Hover: `transform: translateY(-1px)` + `box-shadow` upgraded to glow-md.

### Pill badge

```css
padding: 4px 10px;        /* or 6px 14px for nav stats */
border-radius: 999px;
font-size: 11–12px;
font-weight: 700;
letter-spacing: 1.2px;
text-transform: uppercase;
background: rgba(123, 104, 238, 0.15);
color: var(--accent);
```

### Card

```css
background: var(--surface);
border: 1px solid rgba(123, 104, 238, 0.18);
border-radius: 16px;
padding: 28px;
transition: transform 0.25s, border-color 0.25s, box-shadow 0.25s;
```

Hover: `transform: translateY(-4px)` + border-color `var(--primary)` + glow shadow.

Optional top-edge brand bar:

```css
/* ::before */
position: absolute; top: 0; left: 0; right: 0;
height: 4px;
background: linear-gradient(90deg, var(--primary), var(--accent));
```

### Overlay / panel (content scripts)

```css
background: rgba(10, 10, 26, 0.85);
border: 1px solid rgba(123, 104, 238, 0.3);
backdrop-filter: blur(12px);
box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
border-radius: 12–16px;
```

### Focus ring (keyboard-focus-visible in content scripts)

```css
outline: 3px solid #e94560;
outline-offset: 2px;
box-shadow: 0 0 0 6px rgba(233, 69, 96, 0.25);
```

Apply via `:focus-visible`, not `:focus` — don't steal focus from mouse users.

### Status indicator (struggle score, health dot)

```
0–33: var(--success)    green
34–66: var(--warning)   amber
67–100: #ef4444         red
```

Pulse for high-struggle using a `0→10px` expanding ring shadow animation.

### Navbar

- Fixed top, `z-index: 100`
- Background: `rgba(10, 10, 26, 0.85)` + `backdrop-filter: blur(12px)`
- Border-bottom: `1px solid rgba(123, 104, 238, 0.12)`
- Scroll-shadow: adds `box-shadow: 0 4px 24px rgba(0,0,0,0.4)` once `scrollY > 20`

### Back-to-top (pattern already shipped)

- Fixed bottom-left, 64px circle
- Primary gradient fill, 6px halo ring
- Pulsing ring animation (2.4s ease-in-out infinite)
- Visible only when `scrollY > 400`
- Smooth scroll on click

---

## 10. Voice & Tone

- **Team name:** always **"Manish Kumar"** — never "& Team" or variations. (RCA BUG-004 reference; enforced in content scan step of deploy pipeline.)
- Concise headlines, no exclamation marks unless quoting a user.
- Don't use "just" or "simply" — these minimize effort and read as condescending.
- Prefer second person ("You're in control") over first ("We give you…").
- Status messages read as facts, not apologies: "Extension offline" beats "Sorry, we couldn't reach the server."
- Avoid tech jargon on marketing surfaces; ship it freely in docs and product UI where the audience is developers.
- Footer/signature lines use em-dashes `—` not hyphens `-`.

---

## 11. Accessibility Requirements

Since the product *is* accessibility, the UI must pass the bar it promotes.

- **Contrast:** 4.5:1 minimum for body text, 3:1 for large text and UI components (WCAG AA).
- **Focus indicator:** must be visible on all interactive elements (use the coral focus-ring pattern — see §9).
- **Touch targets:** minimum 44×44 CSS px (WCAG 2.5.5).
- **Motion:** respect `prefers-reduced-motion` — disable pulse animations and reduce transition durations.
- **Color is never the sole signal** — status colors always accompanied by an icon or text.
- **Keyboard operability:** every control usable without a mouse; tab order matches visual order.
- **Live regions:** use `aria-live="polite"` for status changes (e.g. "Extension updated to v0.1.2") and `aria-live="assertive"` sparingly for errors.

---

## 12. Compliance Log

### ✅ Fixed 2026-04-20

- **Tailwind palette realigned** — `a11y-primary` `#0f3460` → `#7b68ee`, `a11y-accent` `#e94560` → `#bb86fc`, `a11y-surface` `#16213e` → `#1a1a2e`, `a11y-bg` `#1a1a2e` → `#0a0a1a`. Added `success/warning/danger/focus` tokens. Coral `#e94560` preserved as `a11y-focus` token for focus indicators only.
- **Sidepanel struggle-score gauge** — `#4ade80/#facc15/#f87171` (Tailwind default greens/yellows/reds) → canonical `#10b981/#f59e0b/#ef4444`.
- **Content-script grays** — all `#888`, `#cbd5e1`, `#8b8fa3` text colors migrated to canonical `#94a3b8` (muted).
- **Off-palette outliers** — `#6434db` → `#7b68ee`, `#e0e0e0` → `#e2e8f0`, `#059669` dropped (flat `#10b981`), `#16213e` in gradient → `#222240`, landing `#9488ff`/`#cf9efd` hover gradient → `var(--primary)`/`var(--accent)` + `filter: brightness(1.12)`.
- **Border-radius spec compliance** — `.ab-dwell-target`, `.ab-predict-phrase`, `.ab-domain-jargon:hover` moved from off-scale 2–3px → `4px`.
- **Semantic coral** — `.a11y-break-reminder button:hover` darkened via `filter: brightness(0.88)` instead of off-palette `#d63851`.

### Still Aspirational

- **Inline styles → Tailwind classes** — `popup/App.tsx` still has inline `#7b68ee`/`#bb86fc` in a few gradient/color spots. Values are canonical; refactor to classes is a code-quality improvement, not a palette violation. Track with a future `refactor:` commit, not a `fix:`.

---

## 13. Quick Reference Cheat Sheet

```css
:root {
  /* Brand */
  --primary: #7b68ee;
  --accent: #bb86fc;

  /* Surface */
  --bg: #0a0a1a;
  --bg-alt: #0d0d22;
  --surface: #1a1a2e;
  --surface-hover: #222240;

  /* Text */
  --text: #e2e8f0;
  --muted: #94a3b8;

  /* Status */
  --success: #10b981;
  --warning: #f59e0b;

  /* Effects */
  --glow: rgba(123, 104, 238, 0.35);

  /* Typography */
  --font-sans: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}
```

---

## 14. When to Update This Doc

- New canonical color added / removed → update §1.
- New component pattern used in ≥2 surfaces → promote to §9.
- Deviation intentionally introduced for a surface → document it in §12 with rationale.
- After shipping a ROADMAP item with its own UI surface → cross-reference here, don't fork.

Treat this doc like code: changes go through the same commit as the UI change itself, not as a separate "cleanup PR."
