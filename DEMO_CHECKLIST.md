# AccessBridge — Demo Pre-Flight Checklist

**Purpose:** Run through this checklist before starting the recording for the Wipro TopGear Ideathon demo video. Allow 15 minutes for the full runthrough. Every item must be confirmed before the recorder starts.

**Author:** Manish Kumar

---

## Section 1 — Environment (Hardware)

- [ ] Laptop is on AC power (battery throttling increases Web Speech API latency and can drop caption frames mid-demo)
- [ ] External microphone tested: record a 5-second clip, play back, confirm no distortion and no background noise above 40 dB
- [ ] Microphone gain set to avoid clipping on plosives (check DAW meter or OS input level bar stays below -6 dB peak)
- [ ] Webcam tested and image is clear if demonstrating eye-tracker segment (M-03)
- [ ] Display resolution confirmed as 1920×1080 — right-click Desktop → Display Settings, confirm scale is exactly 100%
- [ ] Do Not Disturb / Focus Assist is ON — no OS toast notifications, calendar alerts, or messaging pops during recording

---

## Section 2 — Browser Setup

- [ ] **Fresh Chrome profile created** (`chrome://settings/people` → Add person) — prevents cached dev state, stale extension versions, or persistent console noise from contaminating the recording
- [ ] Pointer accessibility cues enabled: `chrome://settings/accessibility` → "Show a quick highlight on the focused object" is ON
- [ ] Browser zoom is 100% (`Ctrl+0` to reset, confirm via `chrome://settings` → Appearance → Page zoom = 100%)
- [ ] All other extensions are DISABLED (`chrome://extensions/` — toggle off every extension except AccessBridge)
- [ ] AccessBridge sideloaded from `packages/extension/dist/` (`chrome://extensions/` → Load unpacked → select `dist/` folder)
- [ ] AccessBridge icon is pinned to the toolbar (right-click extension icon → Pin)
- [ ] DevTools panel is CLOSED on all tabs (F12 to verify — open border shrinks recorded area and reveals internals)
- [ ] Developer Mode banner is visible in `chrome://extensions/` — note in narration that this is the sideloaded development build

---

## Section 3 — Feature Sanity Check

Run each check on the target demo page. Each check must complete within 15 seconds. These guard against the four highest-severity regressions.

- [ ] **BUG-001 regression (blank popup check):** Click the AccessBridge icon — popup must open in under 500 ms with UI fully rendered, no white blank page. A blank popup means the `base: ''` Vite invariant was broken.
- [ ] **BUG-005 regression (master toggle persistence):** Open popup → toggle Master Switch OFF → close popup → reopen popup → confirm toggle is still OFF and UI shows "disabled" state. Then re-enable.
- [ ] **BUG-007 regression (sensory slider effect):** Navigate to `en.wikipedia.org/wiki/Accessibility` → open popup → drag Font Scale slider to 2.0x → confirm article text visibly enlarges. Slider with no effect = BUG-007 recurrence.
- [ ] **BUG-008 regression (zero boot errors):** Open `chrome://extensions/` → AccessBridge → "Inspect views: service worker" → confirm the console shows zero errors on initial load. A `SyntaxError: Identifier already declared` means the IIFE chunk collision has returned.
- [ ] **Voice navigation smoke test:** Open popup → enable Voice Navigation (M-01) → grant mic permission when prompted → say "scroll down" clearly → confirm page scrolls. If no scroll, check mic permission in `chrome://settings/content/microphone`.
- [ ] **Side panel audit smoke test:** Open AccessBridge side panel → navigate to any content page → click "Run Audit" → accessibility score appears within 2 seconds.

---

## Section 4 — Recorder Setup

- [ ] Screen recorder configured at 1920×1080 (OBS: Settings → Video → Base and Output resolution both 1920×1080)
- [ ] Frame rate set to 30 fps or higher (OBS: Settings → Video → Common FPS = 30 or 60)
- [ ] Audio tracks: system audio and microphone on separate tracks (OBS: Settings → Audio → two tracks; track 1 = desktop, track 2 = mic)
- [ ] Cursor highlight is ON in recorder (OBS: Properties on Display Capture → no cursor filter; or use cursor-highlight plugin. Confirm cursor is visible in preview.)
- [ ] Record a 10-second test clip → play back in VLC or OS media player → verify: audio is in sync with cursor movement, no dropped frames, both audio sources audible
- [ ] Test clip deleted after review

---

## Section 5 — Test Accounts and URLs Ready

Open each of the following in the fresh profile before recording begins. These must not be the first navigation clicks during the demo — navigating to a URL on-camera wastes time and risks loading errors.

- [ ] **Gmail test inbox** — open in Tab 1. The inbox must contain at least one email thread with imperative-sentence content ("Please review the report by Friday", "Confirm the meeting before Thursday") to demonstrate the Action Items Extractor (C-08).
- [ ] **Banking public page** — open in Tab 2. Use SBI (`https://www.sbi.co.in`), HDFC (`https://www.hdfcbank.com`), or ICICI (`https://www.icicibank.com`) — any page reachable without login that contains form fields or IFSC/NEFT/RTGS jargon for the Banking Domain Connector (D-01).
- [ ] **Insurance comparison page** — open in Tab 3. An insurance company's public policy comparison page to demonstrate the Insurance Domain Connector (D-02) jargon decoder.
- [ ] **Wikipedia Accessibility article** — open in Tab 4: `https://en.wikipedia.org/wiki/Accessibility`. Used for sensory adapter demo (S-01 font scale, S-02 contrast), distraction shield (C-04), and AI summarize (C-05).
- [ ] **YouTube short video without native captions** — open in Tab 5: `https://www.youtube.com`. Find a video with auto-captions disabled or a language AccessBridge will override. Used for Live Captions demo (S-06 Web Speech API overlay).
- [ ] Confirm all five tabs have fully loaded (no spinner, no "page not available") before starting the recorder.

---

## Section 6 — Fallback Kit

If a live feature fails to work mid-recording, use the fallback material below. Do not re-attempt a broken live demo more than once — cut to the fallback immediately.

- [ ] Pre-recorded 15-second clip ready: **Live Captions on YouTube** — captions overlay visible on a playing video (covers S-06 failure)
- [ ] Pre-recorded 15-second clip ready: **Hindi voice command working** — screen shows command recognition and page response for a Hindi command (covers M-02 failure)
- [ ] Pre-recorded 15-second clip ready: **Dwell-click radial SVG animation** — the radial progress ring completing on a link (covers M-04 failure)
- [ ] Static text slide prepared: "Eye tracker demo in v0.4.1 — calibration requires webcam with 720p+ resolution" (covers M-03 eye-tracker calibration failure)
- [ ] Observatory dashboard link confirmed live: `http://72.61.227.64:8300/observatory/` — verify it loads in the browser before recording. Judges can open this URL during Q&A to see the real compliance metrics dashboard.
- [ ] All fallback clips stored in a local folder with keyboard-accessible filenames (no finder search needed during recording)

---

## Section 7 — Post-Record

- [ ] Watch the full recording at 1.5x speed — confirm all feature moments are visible and narration is audible throughout
- [ ] Check audio levels: no segment is inaudible (below -30 dB) and no segment clips (peaks at 0 dB)
- [ ] Scan every frame for PII: no personal email addresses, real names in email bodies, bank account numbers, or internal API keys visible in any tab
- [ ] Export final video at 1920×1080, H.264, ≤ 100 MB (or as required by submission form)
- [ ] Upload to shared Google Drive folder
- [ ] Paste the shareable Drive link into the Wipro TopGear submission form
- [ ] Confirm submission form shows the link as accessible (open the link in an incognito window)
