# AccessBridge Documentation

> The Ambient Accessibility Operating Layer -- a Chrome extension that observes user behavior, detects struggle signals, and automatically adapts web interfaces for accessibility.

## Documentation Index

### Getting Started
- [Development Setup](./setup.md) -- prerequisites, installation, building, and testing

### Architecture
- [Architecture Overview](./architecture.md) -- 11-layer design, data flow, privacy model, and module breakdown

### Feature Documentation

| Feature | Status | Description |
|---------|--------|-------------|
| [Sensory Adapter](./features/sensory-adapter.md) | Implemented | Font scaling, contrast, color correction, reading mode |
| [Struggle Detection](./features/struggle-detection.md) | Implemented | 10 behavioral signals, weighted scoring, baseline tracking |
| [Decision Engine](./features/decision-engine.md) | Implemented | Rule-based adaptation selection with confidence thresholds |
| [AI Engine](./features/ai-engine.md) | In Progress | 3-tier AI (local, Gemini Flash, Claude), caching, cost tracking |
| [Cognitive Simplifier](./features/cognitive-simplifier.md) | Planned | Focus mode, summarization, distraction shield |
| [Motor Assistor](./features/motor-assistor.md) | Planned | Voice navigation, eye tracking, dwell click |
| [Accessibility Audit](./features/accessibility-audit.md) | In Progress | Automated WCAG 2.1 scanning, 20 rules, scored report, PDF export |

### Project Management
- [Shift Handoff](../HANDOFF.md) -- current sprint status, blockers, and next steps

## Project Structure

```
AccessBridge/
  packages/
    core/                 # Shared types, ProfileStore, StruggleDetector, DecisionEngine
      src/
        types/            # TypeScript interfaces (profile, signals, adaptation)
        profile/          # IndexedDB + AES-GCM encrypted profile storage
        signals/          # StruggleDetector with weighted scoring
        decision/         # DecisionEngine with rule evaluation
    extension/            # Chrome Manifest V3 extension
      src/
        popup/            # React popup UI (5 tabs)
        sidepanel/        # Side panel UI
        content/          # Content scripts, app adapters, sensory adapter
        background/       # Service worker
    ai-engine/            # Tiered AI processing (local, Gemini, Claude)
      src/
        types.ts          # AI request/response types, config, cost tracking
        cache.ts          # Request dedup and in-memory caching
  docs/                   # This documentation
```

## Sprint Timeline

This project is being built during a 5-day ideathon sprint (April 6-10, 2026) by a 3-person team.

| Day | Focus |
|-----|-------|
| Day 1 | Monorepo scaffold, core types, ProfileStore, StruggleDetector, DecisionEngine, extension shell, SensoryAdapter, VPS setup |
| Day 2 | AI engine completion, struggle signal collectors, decision-to-adaptation wiring, Cognitive Simplifier |
| Day 3 | Motor Assistor, voice commands, eye tracking, end-to-end testing on Gmail/Outlook |
| Day 4 | Polish, performance, edge cases, demo preparation |
| Day 5 | Final testing, demo recording, submission |
