# Indian Language Support

## Overview

AccessBridge ships first-class voice-command and transliteration support for
**10 Indian languages plus English** natively through the Web Speech API, plus
**IndicWhisper ONNX Tier B STT infrastructure** (Session 17) that unlocks
**all 22 Indian languages** once the decoder loop lands in Session 18 —
reaching roughly **3.1 billion speakers**, about **39% of the world
population**, in their native script.

The goal: accessibility in your own language, not in a translation of someone
else's. Voice recognition routes through a **three-tier STT chain**:

- **Tier A (fastest, free)** — Chrome Web Speech API for the 11 natively
  supported locales (hi-IN · bn-IN · ta-IN · te-IN · mr-IN · gu-IN · kn-IN ·
  ml-IN · pa-IN · ur-IN · as-IN).
- **Tier B (on-device ONNX, ~80 MB)** — IndicWhisper-small int8 for the
  remaining 11 (Sanskrit, Kashmiri, Konkani, Manipuri, Nepali, Bodo, Santali,
  Maithili, Dogri, Sindhi, Odia) and as a quality-upgrade path for Tier A
  languages in low-signal situations. **Session 17 shipped: model wrapper,
  download UX, popup tier selector, tiered fallback logic. Session 18 ships:
  the Whisper decoder loop + language-forcing tokens.**
- **Tier C (cloud fallback)** — Gemini Flash multimodal audio, only when the
  user explicitly opts in via `voiceQualityTier = 'cloud-allowed'`.

User preference lives on `profile.motor.voiceQualityTier`
(`'auto' | 'native' | 'onnx' | 'cloud-allowed'`) — the popup's Motor tab
"Voice Quality Tier" panel picks it live.

## Supported Languages

| Code | Language  | Native       | Speakers (M) | Notes |
|------|-----------|--------------|-------------:|-------|
| hi-IN | Hindi    | हिन्दी      | 602 | Devanagari; flagship support, 24 commands |
| bn-IN | Bengali  | বাংলা       | 273 | Bengali script |
| ur-IN | Urdu     | اردو        | 232 | Perso-Arabic script, RTL |
| pa-IN | Punjabi  | ਪੰਜਾਬੀ       | 113 | Gurmukhi script |
| mr-IN | Marathi  | मराठी        | 99  | Devanagari, vocabulary distinct from Hindi |
| te-IN | Telugu   | తెలుగు      | 96  | Telugu script |
| ta-IN | Tamil    | தமிழ்       | 86  | Tamil script |
| gu-IN | Gujarati | ગુજરાતી      | 62  | Gujarati script |
| kn-IN | Kannada  | ಕನ್ನಡ       | 59  | Kannada script |
| ml-IN | Malayalam| മലയാളം    | 38  | Malayalam script |

Each language has approximately 24 command entries covering navigation, page
control, tabs, accessibility features, AI actions, and free-text interactions.

## Voice Commands

All commands are defined in a single registry
([`packages/extension/src/content/motor/indic-commands.ts`](../../packages/extension/src/content/motor/indic-commands.ts))
and each action name (`scroll-up`, `go-back`, `summarize`, etc.) matches the
English dispatcher in
[`content/index.ts`](../../packages/extension/src/content/index.ts), so a Tamil
or Telugu transcript routes through the exact same handler as `"scroll up"` in
English.

### Example commands per language

Three examples each — scroll down, go back, summarize:

#### Hindi (हिन्दी)
- `नीचे जाओ` — scroll-down
- `पीछे जाओ` — go-back
- `सारांश दो` — summarize

#### Tamil (தமிழ்)
- `கீழே போ` — scroll-down
- `பின்னே போ` — go-back
- `சுருக்கம் கொடு` — summarize

#### Telugu (తెలుగు)
- `క్రిందకి వెళ్ళు` — scroll-down
- `వెనక్కి వెళ్ళు` — go-back
- `సారాంశం చెప్పు` — summarize

#### Kannada (ಕನ್ನಡ)
- `ಕೆಳಗೆ ಹೋಗು` — scroll-down
- `ಹಿಂದೆ ಹೋಗು` — go-back
- `ಸಾರಾಂಶ ಕೊಡು` — summarize

#### Bengali (বাংলা)
- `নিচে যাও` — scroll-down
- `পিছনে যাও` — go-back
- `সারসংক্ষেপ দাও` — summarize

#### Marathi (मराठी)
- `खाली जा` — scroll-down
- `मागे जा` — go-back
- `सारांश द्या` — summarize

#### Gujarati (ગુજરાતી)
- `નીચે જાઓ` — scroll-down
- `પાછળ જાઓ` — go-back
- `સારાંશ આપો` — summarize

#### Malayalam (മലയാളം)
- `താഴേക്ക് പോകൂ` — scroll-down
- `പിന്നോട്ട് പോകൂ` — go-back
- `സംഗ്രഹം നൽകുക` — summarize

#### Punjabi (ਪੰਜਾਬੀ)
- `ਹੇਠਾਂ ਜਾਓ` — scroll-down
- `ਪਿੱਛੇ ਜਾਓ` — go-back
- `ਸੰਖੇਪ ਦਿਓ` — summarize

#### Urdu (اردو)
- `نیچے جاؤ` — scroll-down
- `پیچھے جاؤ` — go-back
- `خلاصہ دو` — summarize

## Transliteration (Latin → Indic)

Users who have no Indic keyboard installed can type Latin characters and
AccessBridge converts them to script on the fly.

- **Toggle:** press **Alt + T** anywhere in the page to enable/disable. A
  floating pill at the bottom-left shows the target script while active.
- **Scope:** any focused `<input type="text|search|email|url|tel">`, any
  `<textarea>`, and any contenteditable region.
- **Engine:** ITRANS-style greedy longest-match scan. Vowels following a
  consonant render as matras; consonant clusters insert the halant / virama
  automatically.

### Examples

| Latin input    | Devanagari | Tamil | Telugu | Kannada |
|----------------|------------|-------|--------|---------|
| `namaste`      | नमस्ते     | —     | —      | —       |
| `dhanyavaad`   | धन्यवाद    | —     | —      | —       |
| `vanakkam`     | —          | வணக்கம் | —   | —       |
| `namaskaaram`  | —          | —     | నమస్కారం | —    |
| `namaskara`    | —          | —     | —      | ನಮಸ್ಕರ  |
| `ka`           | क          | க     | క      | ಕ       |
| `kaa`          | का         | கா    | కా     | ಕಾ      |
| `ki`           | कि         | கி    | కి     | ಕಿ      |

Pure logic (including the full rule tables) lives in
[`packages/core/src/i18n/transliteration-rules.ts`](../../packages/core/src/i18n/transliteration-rules.ts)
and is covered by 49 unit tests.

## Page Language Auto-Detection

When **Auto-detect page language** is enabled in Settings, AccessBridge samples
up to 5000 characters of visible page text (prefering `<main>` or `<article>`
over `<body>`), tallies characters per Unicode block, and picks the dominant
language. The detected language overrides the default voice-recognition
locale.

### Unicode ranges

| Range            | Language  |
|------------------|-----------|
| U+0900–U+097F    | Hindi / Marathi (Devanagari) |
| U+0980–U+09FF    | Bengali   |
| U+0A00–U+0A7F    | Punjabi (Gurmukhi) |
| U+0A80–U+0AFF    | Gujarati  |
| U+0B80–U+0BFF    | Tamil     |
| U+0C00–U+0C7F    | Telugu    |
| U+0C80–U+0CFF    | Kannada   |
| U+0D00–U+0D7F    | Malayalam |
| U+0600–U+06FF    | Arabic (Urdu) |
| U+0041–U+007A    | English   |

Threshold is 30% of letter characters by default; non-Latin ranges win ties
(pages with substantial Indic content almost always intend that as primary).

## Implementation Files

- [`packages/extension/src/content/motor/indic-commands.ts`](../../packages/extension/src/content/motor/indic-commands.ts) — the unified 10-language voice-command registry + matcher
- [`packages/extension/src/content/motor/hindi-commands.ts`](../../packages/extension/src/content/motor/hindi-commands.ts) — backward-compat shim that re-exports the Hindi slice
- [`packages/extension/src/content/i18n/transliteration.ts`](../../packages/extension/src/content/i18n/transliteration.ts) — DOM controller for Alt+T toggle, input interception, floating indicator
- [`packages/extension/src/content/i18n/language-detect.ts`](../../packages/extension/src/content/i18n/language-detect.ts) — page text sampler + voice-locale mapper
- [`packages/core/src/i18n/transliteration-rules.ts`](../../packages/core/src/i18n/transliteration-rules.ts) — pure ITRANS rule tables and `transliterate()` engine
- [`packages/core/src/i18n/language-ranges.ts`](../../packages/core/src/i18n/language-ranges.ts) — pure `countByLang()` + `detectLanguage()` unicode-range detector
- [`packages/core/src/__tests__/transliteration.test.ts`](../../packages/core/src/__tests__/transliteration.test.ts) — 49 unit tests for all four scripts
- [`packages/core/src/__tests__/language-detect.test.ts`](../../packages/core/src/__tests__/language-detect.test.ts) — 22 unit tests covering 11 language cases

Settings live on `AccessibilityProfile` in
[`packages/core/src/types/profile.ts`](../../packages/core/src/types/profile.ts):
`language`, `autoDetectLanguage`, `transliterationEnabled`,
`transliterationScript`.
