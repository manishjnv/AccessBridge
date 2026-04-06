/**
 * Fatigue-Adaptive UI System
 *
 * Progressively simplifies the page UI throughout the day based on
 * estimated user fatigue. Fatigue is derived from time-of-day, session
 * duration, and declining interaction frequency. Adaptations are applied
 * via CSS classes on document.body and an injected stylesheet.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FatigueLevel = 0 | 1 | 2 | 3 | 4;

type LevelChangeCallback = (level: FatigueLevel, score: number) => void;

interface InteractionBucket {
  /** Timestamp (ms) of the start of this 1-minute bucket */
  timestamp: number;
  /** Number of interactions recorded in this bucket */
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REEVALUATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUCKET_DURATION_MS = 60 * 1000; // 1 minute per bucket
const MAX_BUCKETS = 60; // keep last 60 minutes of interaction history
const BREAK_BANNER_ID = 'a11y-fatigue-break-banner';
const STYLE_ELEMENT_ID = 'a11y-fatigue-styles';

const FATIGUE_CSS = `
/* ---- Fatigue-Adaptive UI Styles ---- */

/* Level 1 — slight comfort adjustments */
body.a11y-fatigue-1 {
  font-size: calc(1em + 1px);
  line-height: 1.65;
  letter-spacing: 0.015em;
  word-spacing: 0.05em;
}
body.a11y-fatigue-1 p,
body.a11y-fatigue-1 li,
body.a11y-fatigue-1 td {
  margin-bottom: 0.35em;
}

/* Level 2 — focus mode, reduced distractions */
body.a11y-fatigue-2 {
  font-size: calc(1em + 2px);
  line-height: 1.75;
  letter-spacing: 0.02em;
  word-spacing: 0.08em;
}
body.a11y-fatigue-2 aside,
body.a11y-fatigue-2 [role="complementary"],
body.a11y-fatigue-2 [role="banner"] ~ *:not(main):not([role="main"]),
body.a11y-fatigue-2 .ad,
body.a11y-fatigue-2 .sidebar {
  opacity: 0.3;
  pointer-events: none;
  transition: opacity 0.5s ease;
}
body.a11y-fatigue-2 main,
body.a11y-fatigue-2 [role="main"] {
  max-width: 50em;
  margin-left: auto;
  margin-right: auto;
}

/* Level 3 — reading mode, high contrast, break suggestion */
body.a11y-fatigue-3 {
  font-size: calc(1em + 3px);
  line-height: 1.85;
  letter-spacing: 0.025em;
  word-spacing: 0.1em;
  background-color: #fefcf3 !important;
  color: #1a1a1a !important;
}
body.a11y-fatigue-3 aside,
body.a11y-fatigue-3 [role="complementary"],
body.a11y-fatigue-3 .ad,
body.a11y-fatigue-3 .sidebar {
  display: none !important;
}
body.a11y-fatigue-3 img,
body.a11y-fatigue-3 video {
  filter: brightness(0.95) contrast(1.05);
}

/* Level 4 — maximum simplification */
body.a11y-fatigue-4 {
  font-size: calc(1em + 5px);
  line-height: 2;
  letter-spacing: 0.03em;
  word-spacing: 0.12em;
  background-color: #fdf6e3 !important;
  color: #111 !important;
}
body.a11y-fatigue-4 aside,
body.a11y-fatigue-4 [role="complementary"],
body.a11y-fatigue-4 nav:not([aria-label="primary"]),
body.a11y-fatigue-4 footer,
body.a11y-fatigue-4 .ad,
body.a11y-fatigue-4 .sidebar,
body.a11y-fatigue-4 [role="banner"] {
  display: none !important;
}
body.a11y-fatigue-4 * {
  animation: none !important;
  transition: none !important;
}
body.a11y-fatigue-4 main,
body.a11y-fatigue-4 [role="main"] {
  max-width: 42em;
  margin-left: auto;
  margin-right: auto;
}

/* Break banner */
#${BREAK_BANNER_ID} {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483647;
  max-width: 340px;
  padding: 16px 20px;
  border-radius: 12px;
  background: #1a1a2e;
  color: #eee;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: a11y-fatigue-slide-in 0.4s ease-out;
}
#${BREAK_BANNER_ID} .a11y-fatigue-banner-title {
  font-weight: 600;
  font-size: 15px;
}
#${BREAK_BANNER_ID} .a11y-fatigue-banner-body {
  opacity: 0.85;
}
#${BREAK_BANNER_ID} .a11y-fatigue-banner-dismiss {
  align-self: flex-end;
  background: rgba(255,255,255,0.15);
  border: none;
  color: #eee;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
#${BREAK_BANNER_ID} .a11y-fatigue-banner-dismiss:hover {
  background: rgba(255,255,255,0.25);
}
@keyframes a11y-fatigue-slide-in {
  from { transform: translateY(20px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentHour(): number {
  return new Date().getHours();
}

/** Time-of-day fatigue component (0-25). */
function timeOfDayScore(): number {
  const h = currentHour();
  if (h >= 6 && h < 12) return 5;   // morning — low
  if (h >= 12 && h < 17) return 12;  // afternoon — medium
  if (h >= 17 && h < 22) return 20;  // evening — high
  return 25;                          // night — very high
}

/** Session duration fatigue component (0-25). */
function sessionDurationScore(elapsedMs: number): number {
  const hours = elapsedMs / (1000 * 60 * 60);
  if (hours < 1) return 5;
  if (hours < 2) return 12;
  if (hours < 4) return 20;
  return 25;
}

/**
 * Interaction-decline fatigue component (0-25).
 *
 * Compares the average interactions-per-minute in the most recent 5 minutes
 * against the average of the preceding history. A large decline signals
 * fatigue.
 */
function interactionDeclineScore(buckets: InteractionBucket[]): number {
  if (buckets.length < 6) return 0; // not enough data

  const recent = buckets.slice(-5);
  const earlier = buckets.slice(0, -5);

  const avg = (arr: InteractionBucket[]): number =>
    arr.reduce((sum, b) => sum + b.count, 0) / arr.length;

  const recentAvg = avg(recent);
  const earlierAvg = avg(earlier);

  if (earlierAvg === 0) return 0;

  // ratio < 1 means activity is declining
  const ratio = recentAvg / earlierAvg;
  if (ratio >= 1) return 0;
  if (ratio >= 0.75) return 6;
  if (ratio >= 0.5) return 12;
  if (ratio >= 0.25) return 19;
  return 25;
}

/** Time-of-day bonus component (0-25) — a secondary ramp that rises smoothly. */
function continuousTodScore(): number {
  const h = currentHour();
  // Map 6am..2am(next day) onto 0..25 linearly, clamped.
  const adjusted = h >= 6 ? h - 6 : h + 18; // hours since 6am
  return Math.min(25, Math.round((adjusted / 20) * 25));
}

// ---------------------------------------------------------------------------
// FatigueAdaptiveUI
// ---------------------------------------------------------------------------

export class FatigueAdaptiveUI {
  private sessionStartTime: number = 0;
  private interactionBuckets: InteractionBucket[] = [];
  private currentBucketIndex: number = -1;

  private reevaluateTimer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  private lastLevel: FatigueLevel = 0;
  private lastScore: number = 0;

  private levelChangeCallbacks: LevelChangeCallback[] = [];
  private bannerDismissedUntil: number = 0; // timestamp — suppress banner until

  // Bound listeners so we can remove them later.
  private boundOnInteraction: () => void;

  constructor() {
    this.boundOnInteraction = this.recordInteraction.bind(this);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Begin tracking fatigue and applying adaptations. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.sessionStartTime = Date.now();
    this.interactionBuckets = [];
    this.currentBucketIndex = -1;
    this.lastLevel = 0;
    this.lastScore = 0;
    this.bannerDismissedUntil = 0;

    this.injectStyles();
    this.addInteractionListeners();

    // Initial evaluation.
    this.evaluate();

    this.reevaluateTimer = setInterval(() => this.evaluate(), REEVALUATE_INTERVAL_MS);
  }

  /** Stop tracking and remove all adaptations. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.reevaluateTimer !== null) {
      clearInterval(this.reevaluateTimer);
      this.reevaluateTimer = null;
    }

    this.removeInteractionListeners();
    this.clearAdaptations();
    this.removeBanner();
    this.removeStyles();
  }

  /** Get the current computed fatigue score (0-100). */
  getFatigueScore(): number {
    return this.lastScore;
  }

  /** Get the current fatigue level (0-4). */
  getCurrentLevel(): FatigueLevel {
    return this.lastLevel;
  }

  /** Register a callback invoked whenever the fatigue level changes. */
  onLevelChange(callback: LevelChangeCallback): void {
    this.levelChangeCallbacks.push(callback);
  }

  // -----------------------------------------------------------------------
  // Core evaluation
  // -----------------------------------------------------------------------

  private evaluate(): void {
    const elapsed = Date.now() - this.sessionStartTime;

    const todScore = timeOfDayScore();
    const durScore = sessionDurationScore(elapsed);
    const declineScore = interactionDeclineScore(this.interactionBuckets);
    const todContinuous = continuousTodScore();

    // Weighted combination — each component contributes up to 25.
    const raw = todScore + durScore + declineScore + todContinuous;
    const score = Math.min(100, Math.max(0, raw));

    const level = this.scoreToLevel(score);

    this.lastScore = score;

    if (level !== this.lastLevel) {
      const previous = this.lastLevel;
      this.lastLevel = level;
      this.applyAdaptations(level);

      // Show or hide break banner.
      if (level >= 3) {
        this.showBanner(level);
      } else {
        this.removeBanner();
      }

      for (const cb of this.levelChangeCallbacks) {
        try {
          cb(level, score);
        } catch {
          // swallow callback errors
        }
      }
    } else {
      this.lastLevel = level;
      // Refresh banner text if already visible and level changed within 3-4.
      if (level >= 3) {
        this.showBanner(level);
      }
    }
  }

  private scoreToLevel(score: number): FatigueLevel {
    if (score >= 80) return 4;
    if (score >= 60) return 3;
    if (score >= 40) return 2;
    if (score >= 20) return 1;
    return 0;
  }

  // -----------------------------------------------------------------------
  // Interaction tracking
  // -----------------------------------------------------------------------

  private addInteractionListeners(): void {
    document.addEventListener('click', this.boundOnInteraction, { passive: true, capture: true });
    document.addEventListener('keydown', this.boundOnInteraction, { passive: true, capture: true });
    document.addEventListener('scroll', this.boundOnInteraction, { passive: true, capture: true });
  }

  private removeInteractionListeners(): void {
    document.removeEventListener('click', this.boundOnInteraction, true);
    document.removeEventListener('keydown', this.boundOnInteraction, true);
    document.removeEventListener('scroll', this.boundOnInteraction, true);
  }

  private recordInteraction(): void {
    const now = Date.now();
    const bucketIndex = Math.floor(now / BUCKET_DURATION_MS);

    if (bucketIndex !== this.currentBucketIndex) {
      this.currentBucketIndex = bucketIndex;
      this.interactionBuckets.push({ timestamp: now, count: 1 });

      // Prune old buckets.
      if (this.interactionBuckets.length > MAX_BUCKETS) {
        this.interactionBuckets = this.interactionBuckets.slice(-MAX_BUCKETS);
      }
    } else {
      const last = this.interactionBuckets[this.interactionBuckets.length - 1];
      if (last) {
        last.count += 1;
      }
    }
  }

  // -----------------------------------------------------------------------
  // DOM adaptations
  // -----------------------------------------------------------------------

  private applyAdaptations(level: FatigueLevel): void {
    const body = document.body;

    // Remove all fatigue classes first.
    body.classList.remove('a11y-fatigue-1', 'a11y-fatigue-2', 'a11y-fatigue-3', 'a11y-fatigue-4');

    if (level >= 1) body.classList.add('a11y-fatigue-1');
    if (level >= 2) body.classList.add('a11y-fatigue-2');
    if (level >= 3) body.classList.add('a11y-fatigue-3');
    if (level >= 4) body.classList.add('a11y-fatigue-4');
  }

  private clearAdaptations(): void {
    document.body.classList.remove(
      'a11y-fatigue-1',
      'a11y-fatigue-2',
      'a11y-fatigue-3',
      'a11y-fatigue-4',
    );
  }

  // -----------------------------------------------------------------------
  // Injected stylesheet
  // -----------------------------------------------------------------------

  private injectStyles(): void {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = FATIGUE_CSS;
    document.head.appendChild(style);
  }

  private removeStyles(): void {
    const el = document.getElementById(STYLE_ELEMENT_ID);
    if (el) el.remove();
  }

  // -----------------------------------------------------------------------
  // Break banner
  // -----------------------------------------------------------------------

  private showBanner(level: FatigueLevel): void {
    // Respect dismissal cooldown (15 minutes).
    if (Date.now() < this.bannerDismissedUntil) return;

    let banner = document.getElementById(BREAK_BANNER_ID);

    const title = level >= 4
      ? 'You deserve a break'
      : 'Consider taking a break';

    const body = level >= 4
      ? 'You have been active for a long time and it is getting late. Step away, stretch, and rest your eyes for a few minutes.'
      : 'Your session has been going for a while. A short break can help you stay focused and comfortable.';

    if (!banner) {
      banner = document.createElement('div');
      banner.id = BREAK_BANNER_ID;
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML = `
        <div class="a11y-fatigue-banner-title">${title}</div>
        <div class="a11y-fatigue-banner-body">${body}</div>
        <button class="a11y-fatigue-banner-dismiss" aria-label="Dismiss break reminder">Dismiss</button>
      `;
      document.body.appendChild(banner);

      banner.querySelector('.a11y-fatigue-banner-dismiss')?.addEventListener('click', () => {
        this.bannerDismissedUntil = Date.now() + 15 * 60 * 1000;
        this.removeBanner();
      });
    } else {
      // Update text in case the level changed.
      const titleEl = banner.querySelector('.a11y-fatigue-banner-title');
      const bodyEl = banner.querySelector('.a11y-fatigue-banner-body');
      if (titleEl) titleEl.textContent = title;
      if (bodyEl) bodyEl.textContent = body;
    }
  }

  private removeBanner(): void {
    const banner = document.getElementById(BREAK_BANNER_ID);
    if (banner) banner.remove();
  }
}
