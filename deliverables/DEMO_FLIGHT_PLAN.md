# AccessBridge — Demo Flight Plan

**Purpose:** Structured beat-by-beat guide for a 5-minute recorded walkthrough of the AccessBridge Chrome extension submitted to the Wipro TopGear Ideathon.
**Target duration:** 5 minutes (300 seconds)
**Target audience:** Wipro TopGear Ideathon evaluation panel
**Author:** Manish Kumar

---

## Prerequisites

- Chrome (stable channel) with AccessBridge v0.4.0 sideloaded via `chrome://extensions` → Developer Mode → Load unpacked → `packages/extension/dist/`
- Extension icon pinned to the Chrome toolbar
- Stable internet connection (required for Gemini/Claude AI tier fallback during Beat 5)
- Gmail account with at least one multi-paragraph email visible in inbox view
- Wikipedia article pre-loaded and ready: `https://en.wikipedia.org/wiki/Accessibility`
- A banking or insurance demo page ready in a second tab (a public-facing page such as `https://www.bankbazaar.com` for domain intelligence)
- OBS or equivalent screen recorder configured at 1920×1080, 30 fps, microphone input confirmed
- Popup pre-closed; all AccessBridge toggles in their default off state; Side Panel closed
- Do a dry run at full speed at least once before recording

---

## Beat Sheet

---

### Beat 1 — Open: Problem Statement
**Time budget:** `0:00 → 0:30`

**URL to open:** No navigation required. Start on the Chrome new-tab page or any neutral page.

**Actions:**
1. Face the camera (or speak directly to the recording) — no screen interaction yet.
2. At the 10-second mark, click the AccessBridge toolbar icon to show the popup briefly, then close it.

**Expected on screen:** Chrome new-tab page with the AccessBridge icon visible and pinned in the toolbar. The popup flash confirms the extension is loaded.

**Speaker notes:** "1.3 billion people live with a disability. Another 2.5 billion adults are aging into accessibility needs. Today's web asks every one of them to find a settings menu, label themselves, and configure things manually — before they can read the page. AccessBridge takes a different approach: it observes how you interact with the web and adapts the experience automatically, without any disclosure required."

**If this beat fails:** Skip the popup flash. Continue speaking and move directly to Beat 2.

---

### Beat 2 — Popup Tour: Overview and Master Toggle
**Time budget:** `0:30 → 1:00`

**URL to open:** No navigation. Remain on current page.

**Actions:**
1. Click the AccessBridge toolbar icon to open the popup.
2. Point to the **Overview tab** — show the master toggle (on/off switch at the top).
3. Toggle the master switch **on**, then **off**, then back **on**.
4. Point to the **Status tab** — show the real-time struggle score gauge (0–100) and the active adaptations count.
5. Point to the **Profile tab** briefly — show sensory, cognitive, and motor preference sections.
6. Leave the popup open.

**Expected on screen:** Popup with three tabs visible. Status tab shows a live gauge reading and a session timer. Toggling the master switch changes the gauge state.

**Speaker notes:** "This is the command center. The master toggle enables or disables every adaptation with a single click — that respects users who want a clean off state on a particular site. The Status tab shows the live struggle score, computed from ten behavioral signals over a 60-second window. The score is deviation from your own baseline, not an absolute threshold, so it calibrates to each individual."

**If this beat fails:** If the popup is blank, close it, run `pnpm build` in the terminal, reload the extension at `chrome://extensions`, and reopen. If time is gone, describe the popup structure verbally.

---

### Beat 3 — Sensory Adaptations
**Time budget:** `1:00 → 1:45`

**URL to open:** `https://en.wikipedia.org/wiki/Accessibility`

**Actions:**
1. Navigate to the Wikipedia Accessibility article.
2. Open the AccessBridge popup → **Sensory** controls.
3. Drag the **Font Scale** slider from 1.0x to 1.5x — observe the page text enlarge live.
4. Drag the **Contrast** slider to 1.6x — observe the color shift.
5. Toggle **Reading Mode** on — observe the page reflow to a 65-character column with increased line height.
6. Toggle **Reduced Motion** on — point out that any Wikipedia animations stop.
7. Reset font scale and contrast to 1.0x for a clean state before the next beat.

**Expected on screen:** Wikipedia article text visibly enlarges, contrast deepens, then the page reflows to a narrow single-column reading layout. The popup sliders move in sync.

**Speaker notes:** "You're looking at live CSS adaptation — font scale, contrast, and line height applied directly to the page's root element without any site involvement. Reading Mode enforces a 65-character column and 1.8 line-height, which measurably reduces eye-tracking regression for users with dyslexia. Every adaptation is reversible: the master toggle restores the original page in one click."

**If this beat fails:** If sliders do not affect the page, confirm the master toggle is on, then hard-reload the page and retry. Fallback talking point: "Reading Mode and font scale are CSS-level; they work on any site without requiring ARIA compliance from the page."

---

### Beat 4 — Cognitive Adaptations
**Time budget:** `1:45 → 2:30`

**URL to open:** Stay on `https://en.wikipedia.org/wiki/Accessibility`, then switch to Gmail for the summarize step.

**Actions:**
1. In the popup, go to **Cognitive** controls.
2. Toggle **Focus Mode** on — observe the spotlight effect dimming peripheral content.
3. Toggle **Distraction Shield** on — any sidebar ads or floating banners are removed.
4. Toggle **Reading Guide** on — observe the horizontal highlight bar that tracks the cursor.
5. Open the Gmail tab (pre-loaded with a multi-paragraph email open).
6. Observe the **Summarize** button injected into the Gmail toolbar by AccessBridge.
7. Click **Summarize** — wait for the summary panel to appear with bullet points and a reading-time estimate.

**Expected on screen:** Wikipedia with the dimmed-periphery focus spotlight and the reading guide bar. Then Gmail with a summary panel showing bullet-point extraction and a complexity score.

**Speaker notes:** "Focus Mode, Distraction Shield, and Reading Guide activate manually here, but they also activate automatically when the Struggle Detector sees cognitive overload signals — rapid scrolling, frequent tab switches, or hesitation. The summarize button is injected into Gmail and Outlook automatically on those domains. The AI engine tries local rule-based extraction first; it only calls Gemini or Claude if local quality is insufficient, keeping the default cost at zero."

**If this beat fails:** If Gmail is not loaded, stay on Wikipedia and describe the summarize feature verbally. Skip the email tab switch.

---

### Beat 5 — Motor Assistance
**Time budget:** `2:30 → 3:15`

**URL to open:** Stay on Gmail or return to `https://en.wikipedia.org/wiki/Accessibility`.

**Actions:**
1. In the popup, go to **Motor** controls.
2. Toggle **Voice Navigation** on.
3. Say clearly: "scroll down" — the page scrolls.
4. Say clearly: "go back" — the browser navigates back.
5. Say clearly: "neeche scroll karo" (Hindi for "scroll down") — the page scrolls.
6. Toggle **Dwell Click** on.
7. Hover the cursor over a visible link for 1.5 seconds without clicking — observe the radial SVG progress ring fill, then the auto-click fire.
8. Toggle **Keyboard-Only Mode** on.
9. Press `Tab` twice to show the enhanced focus ring jumping between interactive elements.
10. Press `?` to open the keyboard shortcuts overlay.
11. Press `Escape` to close the overlay.

**Expected on screen:** Page scrolls on voice command. A radial ring appears around a hovered link and completes to trigger the click. Tab focus rings are visibly larger and higher-contrast than the browser default. The `?` overlay shows a list of bound shortcuts.

**Speaker notes:** "Voice navigation covers 20-plus commands in English and 25-plus in Hindi — the `hi-IN` language code runs through the Web Speech API with no third-party service. Dwell Click is designed for users with tremor or limited hand mobility; the radial indicator gives visual confirmation before the click fires. Keyboard-Only Mode injects skip links and a full shortcut overlay, so a power keyboard user never touches the mouse."

**If this beat fails:** If voice commands do not respond, confirm microphone permission is granted at `chrome://settings/content/microphone`. Fallback: demonstrate Dwell Click and Keyboard-Only Mode only, describe voice verbally.

---

### Beat 6 — Domain Intelligence
**Time budget:** `3:15 → 3:45`

**URL to open:** `https://www.bankbazaar.com` (or any publicly accessible banking/insurance page with visible jargon terms such as IFSC, EMI, NEFT, or premium/deductible).

**Actions:**
1. Navigate to the banking or insurance page.
2. Hover over a banking term such as "IFSC" or "NEFT" — observe the tooltip badge with a plain-English explanation.
3. Hover over "EMI" — observe the expanded definition and lakh/crore amount translation if a figure is present.
4. If on an insurance page: hover over "deductible" or "sum insured" — observe the policy simplifier tooltip.
5. Point to the AccessBridge icon in the toolbar — note that the domain connector activated automatically on page load with no manual step.

**Expected on screen:** Tooltip badges appear on hover over financial jargon. The plain-English definitions replace or annotate technical terms inline. No popup interaction was required — activation was automatic.

**Speaker notes:** "AccessBridge ships with six domain connectors — banking, insurance, healthcare, telecom, retail, and manufacturing ERP. The banking connector decodes 25 terms and translates large numbers into the Indian lakh/crore format that is standard in domestic financial documents. The insurance connector covers 35 terms and can flag potential coverage gaps in a policy. These activate automatically by hostname match — no configuration from the user."

**If this beat fails:** If the domain connector tooltips do not appear, confirm the Master Toggle is on and the page has fully loaded. Fallback: open the popup and show the Domain Intelligence section in the Status tab, describing what auto-activated.

---

### Beat 7 — Side Panel: Audit, Struggle Score, Action Items
**Time budget:** `3:45 → 4:15`

**URL to open:** Stay on the current page (banking/insurance page from Beat 6) or return to Gmail.

**Actions:**
1. Right-click the AccessBridge toolbar icon → select **"Open side panel"** (or use the side panel button if visible).
2. Point to the **Struggle Score gauge** — a live 0–100 reading with confidence level.
3. Point to the **Adaptation History** log — last 5–10 adaptations that fired and why.
4. Point to the **Page Accessibility Score** — the audit result for the current page.
5. If on Gmail: toggle **Action Items** on in the popup, then return to the side panel to show the extracted task list with assignees, deadlines, and confidence scores.
6. Point to the **CSV export** button on the action items drawer.

**Expected on screen:** Side panel open alongside the page, showing the live gauge, adaptation log, and page score. If Gmail is active, a task list with structured fields (task, assignee, deadline, priority, confidence) is visible.

**Speaker notes:** "The side panel gives full transparency into what AccessBridge is doing and why. Every adaptation in the history log is labeled with the signal that triggered it, so users are never in the dark. The Action Items extractor parses emails and documents for tasks — it runs a DOM-regex pass first, then an LLM second pass for confidence scoring. Extracted items link directly to Google Tasks and export to CSV for enterprise workflows."

**If this beat fails:** If the side panel does not open, use the popup's Status tab as a fallback view. Describe the side panel capabilities verbally.

---

### Beat 8 — Architecture, Privacy, Observatory, Close
**Time budget:** `4:15 → 5:00`

**URL to open:** `http://72.61.227.64:8300/observatory/` (live Compliance Observatory dashboard on VPS).

**Actions:**
1. Navigate to the Observatory dashboard URL.
2. Point to the **Overview tab** — device count, feature usage distribution, and daily active sessions.
3. Point to the **Trends tab** — 30-day time series charts.
4. Point to the **Compliance tab** — the print-to-PDF compliance report button.
5. Face the camera for the closing statement — no further screen interaction.

**Expected on screen:** The Observatory dashboard with seeded demo data showing 30 days of metrics across up to 47 simulated devices. The three tab panels are visible. No personally identifiable information is shown anywhere in the dashboard.

**Speaker notes:** "The architecture has three runtime layers: a content script for DOM adaptation, a service worker for message routing and AI orchestration, and the AI engine with a local-first fallback chain. Behavioral signals never leave the browser — only differentially-private aggregate counts reach the Observatory, and only with explicit opt-in. The Laplace noise mechanism and Merkle-commit verification are baked in to prevent replay and forgery. AccessBridge works on any website, any enterprise app, in Chrome, today — no server-side changes, no ARIA retrofit, no disclosure required from the user."

**If this beat fails:** If the Observatory URL is unreachable, open the popup Settings tab and show the opt-in toggle and the dashboard link. Describe the differential-privacy properties verbally using the four bullet points: opt-in gate, allowlist of metric keys, Merkle anti-replay, and k-anonymity floor of 5 devices.

---

## Cut-List (use if running long)

- **Gesture Shortcuts (M-08):** The 16-gesture bindable system adds approximately 20 seconds to Beat 5. Cut the gesture demonstration and mention it exists by name only.
- **Eye Tracker Calibration (M-03):** Webcam activation and the FaceDetector API calibration sequence takes 30–40 seconds and is dependent on camera permissions. Remove entirely if over time — describe as "shipped, live on request."
- **Profile Export / Import:** Showing the profile JSON export from the popup Settings tab is a secondary feature. Cut and replace with one spoken sentence in Beat 2.

---

## Contingency Appendix

- **Microphone fails:** Describe voice commands verbally ("the spoken phrase 'scroll down' triggers a `scroll` action; 'neeche scroll karo' routes through the `hi-IN` STT instance") and demonstrate Dwell Click and Keyboard-Only Mode instead.
- **Camera fails:** Continue audio-only. The screen recording remains the primary artifact; face-to-camera moments in Beat 1 and Beat 8 can be replaced by staying on the screen content.
- **Internet connection fails:** All sensory and cognitive features (Beats 3–4), motor features (Beat 5), and domain connectors (Beat 6) operate offline. AI summarization falls back to the local rule-based provider automatically. The Observatory dashboard (Beat 8) will be unreachable — use the popup Settings tab as described in the Beat 8 fallback.
- **Live captions malfunction:** Live Captions (S-06) are not in the critical path of this demo. If the caption overlay fails to appear on a video element, skip that sub-feature, note it exists with 12 supported languages, and continue.
