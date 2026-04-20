# AccessBridge Demo Script

## Setup (Before Demo)
1. Open Chrome, go to `chrome://extensions/`
2. Enable Developer Mode (top-right toggle)
3. Click "Load unpacked" → select `packages/extension/dist/`
4. Verify AccessBridge icon appears in toolbar
5. Pin the extension icon for easy access

## Demo Flow (5-7 minutes)

### 1. Introduction (30s)
> "AccessBridge is an ambient accessibility operating layer. Unlike traditional accessibility tools that require users to disclose their disabilities and configure everything manually, AccessBridge **silently observes** how you interact with the web and **automatically adapts** the experience."

### 2. Show the Popup (30s)
- Click AccessBridge icon → popup opens
- **Profile tab**: Show user profile settings (disability type, severity, preferences)
- **Status tab**: Show live struggle score (0-100 gauge), session timer, active adaptations count
- Key point: *"The struggle score updates in real-time based on 10 behavioral signals."*

### 3. Cognitive Features (1 min)
- Open any content-heavy page (e.g., Wikipedia article or news site)
- Toggle **Focus Mode** → spotlight follows cursor, periphery dims
- Toggle **Distraction Shield** → ads, sidebars, animations removed
- Toggle **Reading Guide** → ruler line follows reading position
- Key point: *"These activate automatically when we detect cognitive overload — rapid scrolling, frequent tab switches, or hesitation patterns."*

### 4. Motor Assistance (1.5 min)
- Toggle **Voice Commands** → say "scroll down", "go back", "click first link"
- Show Hindi voice: say "neeche scroll karo" (scroll down)
- Toggle **Dwell Click** → hover over a link for 1.5s → auto-clicks with radial progress indicator
- Toggle **Keyboard Only Mode** → show skip links, enhanced focus ring, `?` for shortcuts overlay
- Toggle **Predictive Input** → start typing in a form field, show word suggestions (Alt+1-5)
- Key point: *"20+ voice commands in English and Hindi. Zero mouse required."*

### 5. AI-Powered Features (1 min)
- Open Gmail (or any email)
- Click **Summarize** button injected into Gmail toolbar
- Show summary panel: bullets, reading time, complexity score
- Click **Simplify** → complex text becomes plain language
- Click **Read Aloud** → TTS reads the summary
- Key point: *"3-tier AI: free local processing first, then Gemini, then Claude. Cost-optimized with caching."*

### 6. Domain Intelligence (45s)
- Open a banking website (e.g., SBI or HDFC)
- Show **jargon decoder** → hover over banking terms for plain-English explanations
- Show **Indian numbering** → amounts displayed as "15 Lakh" instead of "1,500,000"
- Open an insurance page → show **policy simplifier**
- Key point: *"Domain-specific intelligence for banking and insurance — the sectors where accessibility matters most."*

### 7. Fatigue Adaptation (30s)
- Show the Fatigue tab in popup
- Explain 4 levels: Mild → Moderate → High → Critical
- At Critical: page auto-simplifies, reduces to essential content only
- Key point: *"The system gets progressively more helpful as it detects increasing fatigue — larger buttons, simpler layouts, proactive summaries."*

### 8. Side Panel Dashboard (30s)
- Right-click extension icon → "Open side panel"
- Show: real-time struggle gauge, adaptation history log, AI insights, accessibility score
- Key point: *"Full transparency — users can see exactly what adaptations are active and why."*

### 9. Architecture & Privacy (30s)
> "Everything runs on-device. Behavioral signals never leave the browser. Profile data is encrypted in IndexedDB. The AI engine tries local processing first — only escalates to cloud APIs when needed. Zero disclosure to websites."

### 10. Close (30s)
> "AccessBridge serves 1.3 billion people with disabilities plus 2.5 billion aging adults — without asking them to label themselves. It's ambient, adaptive, and private. Built as a Chrome extension that works on any website, any enterprise app, right now."

## Backup Demos (if time permits)
- **Eye Tracking**: Toggle eye tracking → webcam activates → gaze-based cursor control
- **Side Panel**: Show AI cost stats, cache hit rates
- **Multi-tab**: Show adaptations persist across tabs

## Troubleshooting
- **Extension not loading?** Check chrome://extensions for errors, click "Errors" button
- **Voice commands not working?** Allow microphone permission when prompted
- **Eye tracking not starting?** Allow camera permission, ensure FaceDetector API support
- **Popup blank?** Rebuild with `pnpm build`, reload extension
