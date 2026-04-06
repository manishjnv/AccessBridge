# AccessBridge — Deferred Tasks

Tasks deferred for post-submission or production phase. Grouped by priority.

---

## Production / Distribution

### DEF-001: Chrome Web Store publishing for auto-updates
- **Priority**: Post-submission
- **Description**: Publish to CWS for fully automatic zero-click updates
- **Current workaround**: Self-hosted 2-click update (Settings > Check for Update > Download > Reload)
- **When done**: Remove `update_url` from manifest, remove update banner UI

### DEF-002: Demo video recording
- **Priority**: Before April 11 submission
- **Description**: Record 5-7 min walkthrough using `DEMO_SCRIPT.md` showing all features
- **Status**: Script ready, needs recording

### DEF-003: PPT polish with real screenshots
- **Priority**: Before April 11 submission
- **Description**: Add screenshots from working Chrome extension to the 15-slide PPT
- **Status**: PPT generated, needs real screenshots

---

## Indian Language Support

### DEF-004: 22 Indian language support (AI4Bharat IndicWhisper)
- **Priority**: Phase 2 (post-prototype)
- **Description**: Original spec calls for 22 Indian languages. Currently only Hindi + 7 international languages supported via Web Speech API `lang` parameter
- **What's done**: Hindi STT (hi-IN), 25+ Hindi voice commands mapped
- **What's needed**: IndicWhisper integration for offline Indian language STT, UI translations, localized jargon decoders

### DEF-005: Full Hindi/regional language UI
- **Priority**: Phase 2
- **Description**: Translate popup, side panel, and overlay UI text into Hindi and other Indian languages
- **Current**: All UI is English-only. Voice commands work in Hindi but UI labels are English

---

## AI Engine

### DEF-006: Real API keys for Gemini/Claude AI tiers
- **Priority**: Post-prototype
- **Description**: Local tier works offline. Gemini Flash and Claude tiers need real API keys to function
- **Current workaround**: All AI runs through local extractive summarizer (rule-based, zero cost)
- **What's needed**: Gemini API key, Claude API key, Settings UI to enter keys

### DEF-007: ONNX Runtime for local translation
- **Priority**: Phase 2
- **Description**: `local.ts` translate() is a no-op stub. Integrate ONNX runtime with translation models for offline translation
- **Source**: `packages/ai-engine/src/providers/local.ts:249`

### DEF-008: AI response quality threshold fallback
- **Priority**: Phase 2
- **Description**: Auto-escalate to higher AI tier when local response quality is below threshold
- **Source**: `docs/features/ai-engine.md:110`

---

## Desktop & Platform

### DEF-009: Desktop Agent (Tauri/Rust)
- **Priority**: Phase 2 (weeks 9-16)
- **Description**: Original spec includes a Tauri/Rust desktop agent for system-wide accessibility beyond the browser
- **Status**: Not started. Current scope is Chrome extension only

### DEF-010: Edge/Firefox extension ports
- **Priority**: Phase 3
- **Description**: Port Manifest V3 extension to Edge (minimal changes) and Firefox (Manifest V2 compatibility)

---

## Features — Enhancements

### DEF-011: MediaPipe Face Mesh for precise eye tracking
- **Priority**: Phase 2
- **Description**: Current eye tracker uses Chrome FaceDetector API (bounding box + landmarks) with skin-colour fallback. MediaPipe Face Mesh gives 468 facial landmarks for much more precise gaze tracking
- **Current**: FaceDetector API works, good enough for demo

### DEF-012: On-device ML models (~4-5GB)
- **Priority**: Phase 2
- **Description**: Original spec includes whisper.cpp, llama.cpp for fully offline AI. Current local tier uses rule-based heuristics
- **Models**: whisper.cpp (STT), llama.cpp (text generation), ONNX (classification)

### DEF-013: SQLCipher encrypted profile storage
- **Priority**: Phase 2
- **Description**: Profiles currently stored in chrome.storage.local (unencrypted). Spec calls for SQLCipher for encrypted local storage
- **Privacy**: Important for workplace accessibility — profiles contain disability indicators

### DEF-014: Observability layer
- **Priority**: Phase 2
- **Description**: Monitoring dashboard for accessibility analytics. VPS Observatory container exists (port 8200) but not wired
- **Status**: Docker container running, no data flowing

---

## VPS / Infrastructure

### DEF-015: VPS deployment automation
- **Priority**: Post-submission
- **Description**: `deploy.sh` exists but full VPS deploy (git pull + pnpm build on server) requires Node/pnpm on VPS. Currently manual SCP of built files
- **Current workaround**: SCP zip + landing page to VPS

---

## Summary

| Priority | Count | IDs |
|----------|-------|-----|
| Before April 11 | 2 | DEF-002, DEF-003 |
| Post-submission | 3 | DEF-001, DEF-006, DEF-015 |
| Phase 2 (post-prototype) | 8 | DEF-004, DEF-005, DEF-007, DEF-008, DEF-009, DEF-011, DEF-012, DEF-013 |
| Phase 3 (scale) | 2 | DEF-010, DEF-014 |
| **Total** | **15** | |
