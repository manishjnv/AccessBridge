# AccessBridge — Live Demo Script
### Wipro TopGear Ideathon | Stage presentation | Judges live Q&A
### Format: Single run, 7-minute maximum, no re-takes

---

## Pre-Stage Checklist (complete before walking on stage)

- [ ] Laptop plugged into stage power — not running on battery
- [ ] Chrome open, AccessBridge sideloaded and enabled (green icon visible)
- [ ] Three tabs pre-loaded in this order: (1) any Wikipedia article, (2) Gmail inbox with at least one multi-paragraph email open, (3) SBI or HDFC net-banking login page
- [ ] Popup opens and closes correctly — verify once backstage
- [ ] Microphone permission granted to Chrome — voice commands must not trigger a permission dialog on stage
- [ ] Clicker paired and tested
- [ ] Backup SD video file confirmed on USB (last resort only — do not mention it unless forced)
- [ ] Phone on silent, screen facing down

---

## Risk Tiers

### MUST WORK — 3 Features (demo these no matter what)

These three features are selected because each produces a visible, unmistakable result within 3 seconds, requires zero network connectivity, and has no permission prompt on a primed machine.

| # | Feature | Why picked |
|---|---------|-----------|
| 1 | **Sensory Font Scale slider (S-01)** | Pure CSS zoom on the `html` element. Deterministic, fully offline, instant visual effect. Wikipedia text reflows visibly in under 1 second at 2.0x. BUG-007 confirmed fixed with CSS `zoom` property — survives complex site-level selectors. |
| 2 | **Focus Mode spotlight (C-01)** | Purely DOM + CSS — no AI, no network, no permissions. The dark-overlay + cursor spotlight is the single highest-impact visual moment in the demo. Activates in under 300 ms. Audience sees it immediately. |
| 3 | **Struggle Score gauge (CORE-01 / CORE-02)** | Runs entirely in the background service worker. The gauge in the Status tab of the popup shows a live 0–100 score built from 10 behavioral signals. Requires no user action to demonstrate — it updates while the presenter interacts with the page. Zero network dependency. |

---

### SHOULD WORK — 5 Features

Show these if network and permissions cooperate. Each has a stated failure risk and a fallback talking point.

| # | Feature | Failure risk | Fallback talking point if it breaks |
|---|---------|-------------|-------------------------------------|
| 1 | **Voice Navigation — English (M-01)** | Web Speech API requires microphone permission and a working audio input. A stage PA system or noisy environment can cause mis-recognition. | "Voice commands use the browser's built-in Web Speech API — in a quiet environment it responds to 20+ English commands including scroll, click, go back, and open side panel. The Hindi variant works the same way with lang=hi-IN." |
| 2 | **Distraction Shield (C-04)** | Wikipedia's DOM structure can change. If the shield removes too much or too little, the effect looks broken rather than helpful. | "Distraction Shield uses a CSS rule-set that hides ad slots, floating banners, and modal overlays. On a site with dense ad inventory — a news portal, for example — the page goes from visually noisy to a clean reading column in one toggle." |
| 3 | **Reading Mode (C-03)** | Some single-page apps re-render the DOM after Reading Mode applies its 65-character column, which can cause the layout to snap back. | "Reading Mode rewrites the page's content column to a 65-character width at 1.8 line-height — the typographic sweet spot for sustained reading. It works on any static or server-rendered page." |
| 4 | **AI Summarize on Gmail (AI-01 / C-05)** | Requires the Gmail tab to be active and the email-ui toolbar injection to have fired. If Gmail's DOM has shifted since last build, the injected button may not appear. | "The AI engine routes through three tiers — local rule-based first, then Gemini Flash, then Claude Sonnet. The local tier works offline and produces bullet summaries from email threads. Cloud tiers are engaged only when the user has added an API key. Cost is tracked daily with an automatic downgrade if the budget ceiling is hit." |
| 5 | **Banking IFSC / jargon badge (D-01)** | Auto-detection triggers on hostname match. If the bank's site has changed its domain or the page loads slowly, the connector may not fire before the demo reaches this beat. | "The banking connector activates automatically on SBI, HDFC, ICICI, and similar hostnames. It decodes 25 domain-specific terms — NEFT, RTGS, EMI, KYC — inline on the page, and converts raw numbers to Lakh and Crore notation. No configuration required by the user." |

---

### NICE TO HAVE — 5 Features

Attempt these only if you are under 5 minutes and the demo is going smoothly. For each, if it breaks, pivot immediately using the instruction below.

| # | Feature | If it breaks, pivot to... |
|---|---------|--------------------------|
| 1 | **Hindi Voice Commands (M-02)** | State the command aloud ("neeche scroll karo") and explain the architecture: same recognition pipeline, lang=hi-IN passed to Web Speech API, 25 commands mapped. |
| 2 | **Eye Tracking (M-03)** | Explain: "Eye tracking uses the browser's FaceDetector API with a fallback to a JS head-pose estimator. It turns a standard webcam into a hands-free pointer — relevant for users with severe motor impairment." |
| 3 | **Live Captions on YouTube (S-06)** | Describe the feature: "The caption overlay attaches to any HTML5 video element. It supports 12 languages and optional live translation — built on Web Speech recognition, no third-party caption service needed." |
| 4 | **Side-panel Audit PDF export** | Open the side panel and show the gauge and adaptation history log instead. The PDF export is one button press from there. |
| 5 | **Observatory dashboard preview** | State the URL and describe: "The Compliance Observatory aggregates anonymized, differentially-private metrics from opted-in devices. HR and compliance teams see aggregate feature-usage trends — zero identity, zero content, zero IP addresses." |

---

## Spoken Walkthrough — 7 Minutes

Times are relative to microphone-on (M+0:00).

---

### Beat 1 — Opening elevator pitch
**Time:** M+0:00 to M+0:30

**Setup:** Stand at the podium. Clicker in hand. No screen action yet.

**Spoken line:**
"Every website was built for someone — but not for everyone. AccessBridge is an ambient accessibility layer that silently observes how you interact with the web and adapts the page in real time, without ever asking you to disclose a condition. We are building for the 1.3 billion people living with disabilities and the 2.5 billion aging adults who will benefit from better digital access — and we do it with a zero-disclosure, on-device privacy posture: your behavioral signals never leave your browser."

**Action:** None. Hold eye contact with the judges.

**Expected result:** Audience attention.

**Fallback line:** Not applicable — this beat cannot fail.

---

### Beat 2 — Show the popup and the live Struggle Score
**Time:** M+0:30 to M+1:15

**Setup:** Wikipedia tab is active.

**Spoken line:**
"Let me show you what is running right now, in the background, on this page."

**Action:** Click the AccessBridge toolbar icon to open the popup. Navigate to the Status tab. Point to the Struggle Score gauge.

**Expected result:** Popup opens showing the 0–100 gauge with a live number. The gauge updates as you move the mouse or scroll.

**Fallback line:** "The gauge is built from 10 behavioral signals — scroll velocity, click accuracy, dwell time, typing rhythm, backspace rate, and five others — aggregated over a 60-second sliding window by a local decision engine. The number you see reflects this session in real time. There is no server call involved."

---

### Beat 3 — Font Scale slider (MUST WORK #1)
**Time:** M+1:15 to M+1:50

**Setup:** Wikipedia tab still active. Popup is still open on the Sensory tab (or navigate there now).

**Spoken line:**
"Start with the most direct adaptation — text size. A user with low vision needs this to work on every site, every time."

**Action:** Drag the Font Scale slider from 1.0x to 2.0x. Pause for 2 seconds so judges can see the Wikipedia text reflow.

**Expected result:** Wikipedia article text enlarges visibly. The entire page reflows. Slider returns to 1.0x when you drag it back.

**Fallback line:** "Font scaling applies a CSS zoom property directly to the page root — it works on every website regardless of how complex the site's stylesheet is. That was a deliberate fix over the naive font-size approach, which fails on sites with highly specific CSS selectors."

---

### Beat 4 — Focus Mode spotlight (MUST WORK #2)
**Time:** M+1:50 to M+2:25

**Setup:** Wikipedia tab active. Popup open on Cognitive tab (or navigate there).

**Spoken line:**
"Cognitive overload is the invisible barrier. A user with ADHD opens a Wikipedia page and sees a wall of text, sidebars, infoboxes, and navigation. Focus Mode does one thing: it removes everything except where you are looking."

**Action:** Toggle Focus Mode on. Move the cursor slowly across the article text.

**Expected result:** A spotlight follows the cursor. The surrounding page area dims to a dark overlay. The effect is immediate.

**Fallback line:** "Focus Mode applies a CSS mask centred on the cursor position using a radial gradient. The computation is entirely on the GPU — no JavaScript runs per mouse move after initialization. This is why it works even on complex single-page applications without any site-specific code."

---

### Beat 5 — Voice Navigation (SHOULD WORK #1)
**Time:** M+2:25 to M+3:05

**Setup:** Wikipedia tab active. Popup open on Motor tab. Microphone confirmed live.

**Spoken line:**
"Now motor assistance. For a user who cannot use a mouse or trackpad, voice is the primary input. Watch what happens when I speak to the browser."

**Action:** Toggle Voice Commands on. Say clearly: "scroll down." Pause. Say: "go to top."

**Expected result:** Page scrolls down on the first command. Page returns to top on the second.

**Fallback line:** "Voice navigation maps 20-plus English commands to browser actions — scroll, click, navigate, zoom, open side panel. The command set is defined in a single file and is easily extensible. We also ship a Hindi command set — 25 commands at lang=hi-IN — because the majority of our target users in India are more comfortable in their native language."

---

### Beat 6 — AI Summarize on Gmail (SHOULD WORK #4)
**Time:** M+3:05 to M+3:50

**Setup:** Switch to the Gmail tab. The email should already be open.

**Spoken line:**
"The same ambient layer extends to productivity apps. Here is a Gmail thread — the kind of long email chain that loses users with reading fatigue or cognitive disability."

**Action:** Locate the AccessBridge Summarize button injected into the Gmail toolbar. Click it.

**Expected result:** A panel appears with bullet-point summary, estimated reading time, and a complexity score.

**Fallback line:** "The AI engine has three tiers. The local tier runs a rule-based summarizer offline — no API key required, no data leaves the device. When a Gemini or Claude key is configured, the engine upgrades automatically and applies a daily cost ceiling with automatic downgrade. The same engine handles email threads, documents, and meeting notes through three dedicated service methods."

---

### Beat 7 — Banking domain connector (SHOULD WORK #5)
**Time:** M+3:50 to M+4:25

**Setup:** Switch to the banking tab (SBI or HDFC).

**Spoken line:**
"Domain intelligence is where AccessBridge creates a moat. Banking is the sector where financial exclusion is most consequential — and where the terminology is most opaque."

**Action:** Hover over any banking term on the page (NEFT, KYC, RTGS, or EMI). If the page is a login screen, describe what would appear on the account overview.

**Expected result:** An inline tooltip appears with a plain-language explanation of the term.

**Fallback line:** "The banking connector auto-activates on hostname match. It carries a 25-term jargon dictionary, converts large numbers to Lakh and Crore notation, and provides form assistance on transaction screens. Five other domain connectors cover insurance, healthcare, telecom, retail, and manufacturing ERP — each with a domain-specific term library."

---

### Beat 8 — Distraction Shield and Reading Mode (SHOULD WORK #2 and #3, one beat)
**Time:** M+4:25 to M+5:00

**Setup:** Return to the Wikipedia tab.

**Spoken line:**
"Two more cognitive tools, quickly."

**Action:** Toggle Distraction Shield on — point to the disappearance of sidebar content. Then toggle Reading Mode on — point to the article column narrowing to reading width.

**Expected result:** Sidebar and non-content elements disappear. Article text reflows into a centered 65-character column.

**Fallback line:** "Distraction Shield uses a CSS allowlist approach — it hides elements matching common ad, sidebar, and modal patterns. Reading Mode constrains the content column width and increases line height. Both operate purely on the local DOM with no server interaction."

---

### Beat 9 — Observatory and privacy architecture
**Time:** M+5:00 to M+5:40

**Setup:** Popup open on Settings tab.

**Spoken line:**
"AccessBridge is a zero-disclosure system. No website ever learns that our extension is active. No behavioral data is sent to any server. If a user opts in to anonymous analytics — that toggle is here, off by default — we apply differential privacy: Laplace noise, Merkle commit verification, k-anonymity floor of five devices before any category appears in a report. The employer sees aggregate trends, never individual behavior."

**Action:** Show the Observatory opt-in toggle. If network is available, briefly show the live dashboard URL.

**Expected result:** Toggle is visible and clearly labeled as opt-in. Dashboard loads if network is present.

**Fallback line:** "The Observatory backend runs on our VPS and accepts only aggregated, noise-added metrics through a strict server-side key allowlist. Individual records are rejected if they do not pass merkle verification. The compliance report shows HR teams that accessibility tooling is in use — nothing more."

---

### Beat 10 — Closing
**Time:** M+5:40 to M+6:10

**Setup:** Return to the popup Status tab. Struggle Score visible.

**Spoken line:**
"What you have seen in the last five minutes is a 28-feature accessibility operating layer — sensory, cognitive, motor, AI, and domain intelligence — running entirely in a Chrome extension, on any website, right now. No enterprise integration. No disclosure. No configuration. You install it, and it learns you."

**Action:** No action. Maintain eye contact.

**Expected result:** Judges are engaged.

**Fallback line:** Not applicable.

---

### Beat 11 — Call to action and contact
**Time:** M+6:10 to M+6:40

**Spoken line:**
"The extension is sideloadable today — the instructions are on the GitHub repo at github.com/manishjnv/AccessBridge. We would welcome five minutes with any judge who wants to try it on their own machine. My name is Manish Kumar. Thank you."

**Action:** Advance clicker to the final slide (GitHub URL + QR code if prepared).

**Expected result:** Clean close.

**Fallback line:** Not applicable.

---

### Beat 12 — Buffer
**Time:** M+6:40 to M+7:00

Reserve for a judge question or a retry on any beat that ran short. Do not fill this time with additional features if the demo is going well. Silence is acceptable.

---

## Opening 30-Second Elevator Pitch

Read aloud, exactly as written:

"AccessBridge is an ambient accessibility operating layer — it silently observes how you interact with the web and adapts the experience in real time, without asking you to disclose anything about yourself. We built it for the 1.3 billion people living with disabilities and the 2.5 billion aging adults who deserve digital access that meets them where they are. Every adaptation runs on-device, under a zero-disclosure privacy posture: no behavioral signal ever leaves the browser, and no website ever knows the extension is present."

---

## Closing 30-Second Statement

Read aloud, exactly as written:

"AccessBridge is not a screen reader replacement — it is the layer that makes every website accessible without requiring anyone to identify themselves as disabled, configure a tool, or ask for help. If you want to experience it for yourself, the sideload instructions are at github.com/manishjnv/AccessBridge — it loads in under two minutes on any Chrome installation. Thank you — I am Manish Kumar, and I am available for questions."

---

## Q&A Prep Appendix

### Q1. Why a browser extension, not a screen reader replacement?

Screen readers replace the visual interface entirely — they are built for users who are blind and require complete adoption. AccessBridge targets the much larger population of users with partial, situational, or cognitive accessibility needs who continue to use the standard visual interface. A browser extension injects at the content-script layer and reaches every website without any server-side integration. The distribution barrier is a single sideload, not an OS-level install or enterprise procurement cycle.

---

### Q2. How do you detect struggle without labeling the user?

The Struggle Detector aggregates 10 behavioral signals — scroll velocity, click accuracy, dwell time, typing rhythm, backspace rate, zoom events, cursor path entropy, error rate, reading speed, and hesitation — into a 0–100 composite score over a 60-second sliding window. No signal individually identifies a condition. The score drives the Decision Engine's adaptation rules. The user is never classified; the page is adapted. The signal data never leaves the browser.

---

### Q3. What happens if the AI cloud APIs are down?

The AI engine has a three-tier fallback chain: local rule-based processing first, then Gemini Flash, then Claude Sonnet. The local tier runs entirely offline — it uses a 180-term simplification map and a rule-based summarizer. If cloud APIs are unreachable or the daily cost ceiling is hit, the engine downgrades automatically to the local tier. The user sees a slightly less fluent summary but the feature continues to work. The three MUST-WORK features in this demo have no AI dependency at all.

---

### Q4. How is this different from Chrome's built-in accessibility features or JAWS or NVDA?

Chrome's built-in features — large cursor, high contrast, zoom — are static, global settings applied uniformly to every site. JAWS and NVDA are screen reader platforms designed for users who are blind, requiring deep training and full-keyboard workflows. AccessBridge is adaptive and per-page: it observes interaction patterns and applies targeted adaptations without replacing the standard interface. It also adds domain intelligence (banking jargon, insurance policy simplification) and AI summarization that no platform-level accessibility tool provides.

---

### Q5. What is your moat — anyone could build this, right?

The individual features are replicable. The moat is in three places. First, the behavioral intelligence layer — the Struggle Detector + Decision Engine feedback loop — requires significant signal engineering and calibration across diverse user populations. Second, the domain connectors carry curated, hand-verified jargon dictionaries for Indian financial and healthcare domains that take months to build. Third, the privacy architecture — differential privacy with Merkle verification, k-anonymity floors, and on-device processing — is a design invariant baked into the system from the start, not a retrofit.

---

### Q6. How do you get users without them knowing they have a disability?

Disability is not a prerequisite for benefit. Focus Mode helps anyone in a noisy open-plan office. Reading Mode helps anyone reading a dense legal document. Voice commands help anyone whose hands are occupied. The zero-disclosure posture means users do not need to identify with a category to install the extension. The ambient detection model means the extension is useful from the first interaction, before any manual configuration.

---

### Q7. What is the enterprise deployment story?

A Chrome extension can be force-installed across a Chrome Enterprise or Google Workspace domain through the Admin Console in minutes — no individual user action required. The Compliance Observatory gives HR and compliance teams an opt-in aggregate view of feature usage. The domain connectors can be extended with enterprise-specific jargon (ERP terms, internal policy language) through a configuration file. The AI engine's cost ceiling and tier selection are configurable per deployment.

---

### Q8. Privacy — does any user data leave the device?

Behavioral signals (scroll velocity, click patterns, etc.) are processed entirely on-device in the content script and service worker. They are never transmitted anywhere. The AI engine attempts the local tier first; cloud API calls are made only when the user has configured an API key, and only the text of the content being processed (e.g., the email body being summarized) is sent — not behavioral data or identity. Observatory metrics, if opted in, are noise-added with Laplace differential privacy before transmission, and the server enforces k-anonymity and a strict metric key allowlist.

---

### Q9. Why these specific 6 domain connectors?

Banking, insurance, healthcare, telecom, retail, and manufacturing were selected based on two criteria: (1) high jargon density — these sectors use domain-specific terminology that excludes users without professional background, and (2) high consequence of misunderstanding — a user who misunderstands an EMI agreement, a health insurance clause, or a lab result faces real financial or physical harm. Manufacturing ERP was added because enterprise workers with literacy or cognitive accessibility needs face the same barriers inside internal tools.

---

### Q10. What is on the roadmap for v1?

The roadmap has four release phases. R1 focuses on Android WebView coverage and an offline-first Indic language pack covering six languages. R2 adds enterprise SSO, a managed extension policy template, and the Observatory compliance report PDF pipeline. R3 introduces a federated learning module so the Struggle Detector improves from aggregate patterns without centralizing any individual data. R4 is the API layer — allowing third-party developers to register custom domain connectors and adaptation rules against the AccessBridge engine without modifying the extension.

---

## On-Stage Gear

**Laptop:** Laptop must be connected to stage power before walking on — battery drain during a 7-minute demo on a power-hungry machine risks a sleep event mid-presentation.

**Clicker:** Use a clicker with an integrated lapel or clip-on microphone channel so advancing slides does not require returning to the podium and breaking eye contact with the judges.

**Backup SD video file:** A pre-recorded screen-capture video of the full demo flow is saved to a USB drive as a last resort — load it only if the extension fails to load at all, and state clearly to the judges that you are showing a recording.
