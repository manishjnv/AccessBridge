# Compliance Observatory

An anonymous, differentially-private dashboard giving HR and compliance teams aggregate visibility
into accessibility accommodation patterns across an organization — without exposing individual
employees.

---

## 1. Why This Exists

### The regulatory pressure

Three major legal frameworks now place affirmative obligations on employers to demonstrate
meaningful accommodation:

- **RPwD Act 2016, Section 20 (India).** VERIFY: The Rights of Persons with Disabilities Act 2016,
  Section 20, requires every establishment to provide reasonable accommodation to employees with
  disabilities. The Act also empowers the appropriate government to require employers to furnish
  returns on the steps taken. An employer seeking to show compliance needs contemporaneous evidence
  of what accommodations were offered and actually used.

- **European Accessibility Act 2025, Article 4.** VERIFY: Article 4 sets mandatory accessibility
  requirements for products and services placed on the EU market. Employers who provide internal
  digital services to employees with disabilities fall within scope once the Act's transitional
  provisions expire. Compliance requires documented evidence of conformance, not merely a policy
  statement.

- **ADA Title I (USA).** The Americans with Disabilities Act requires employers to provide
  reasonable accommodation to qualified individuals with disabilities unless doing so would cause
  undue hardship. EEOC guidance expects employers to engage in an interactive process and maintain
  records of that process.

### The tooling gap

Existing approaches fall into two failure modes:

1. **Identity exposure.** HR systems that track accommodation requests by employee ID create a
   chilling effect. Workers fear that disclosing a need will affect performance reviews, promotion
   decisions, or employment continuity. Underreporting is the norm, which means management
   never sees accurate demand for assistive features.

2. **No usable data.** Accessibility audits produce point-in-time WCAG scan reports. They measure
   whether a product *can* be used accessibly, not whether employees *are* using accessibility
   features and whether those features are adequate. A clean audit score tells HR nothing about
   daily lived experience.

Compliance Observatory is designed to close this gap: it produces continuous, aggregated signal
about accommodation demand without the identity exposure that makes workers reluctant to
self-disclose.

### The contract with users

Every aspect of the system is subordinate to three commitments:

1. **Opt-in only.** The extension never transmits any Observatory data until the user explicitly
   enables the toggle. Default state is off.

2. **Zero identity.** No user ID, device ID, employee ID, IP address, browser fingerprint, or any
   other identifying artifact is transmitted or retained on the server beyond the network session
   boundary.

3. **Zero content.** No page URLs, page text, form inputs, voice recordings, or eye-tracking
   frames are ever collected. Only coarse daily counts of *categories* of accessibility activity
   are considered.

---

## 2. What Is and Is Not Collected

The following table is the canonical reference for data collection scope. Any deviation — whether
in a future extension version or a server-side schema change — must be reflected here before
shipping.

| Collected (opt-in only) | Never collected |
|---|---|
| Daily count of adaptations applied, broken down by `AdaptationType` enum value | User ID, device ID, or employee ID of any kind |
| Daily count of struggle events triggered (all types summed) | IP address (retained by nginx only for rate-limit window; never inserted into the application database) |
| Per-feature enable count: `focus_mode`, `voice_nav`, `eye_tracking`, `keyboard_only`, `predictive_input`, `dwell_click` | Browser fingerprint, user-agent string, screen resolution |
| Per-domain-connector activation count: `banking`, `insurance`, `telecom`, `retail`, `healthcare`, `manufacturing` | Page URL, hostname, or any part of a page address |
| Deduplicated set of language codes active during the day (e.g. `["en", "hi", "ta"]`) | Page content, form inputs, email body, or any user-authored text |
| Estimated accessibility score improvement (integer 0–100, computed locally before any noise is added) | Per-event timestamps; only the day-level aggregate is ever formed |
| SHA-256 Merkle root of the counter bundle (tamper-evidence; does not reveal individual counters) | Voice recordings or partial voice transcripts |
| Local calendar date (YYYY-MM-DD; no time component) | Eye-tracking frames, gaze coordinates, or dwell-click target coordinates |

The "Never collected" column is enforced at the source: the `ObservatoryCollector` class never
reads these values. There is no code path that touches them. The server-side schema has no columns
for them.

---

## 3. Differential Privacy Rationale

Raw counts, even when stripped of explicit identifiers, can reveal sensitive information when an
organization is small or when a particular adaptation type has very few users. A single person
using eye tracking in a 15-person team is effectively identified by that count alone. Differential
privacy (DP) addresses this by adding calibrated noise so that the presence or absence of any one
individual's data cannot be detected from the published aggregate.

### Why the Laplace mechanism

Compliance Observatory collects count queries: "how many times was font scaling applied today?"
Count queries have a natural sensitivity of 1 because adding or removing one user changes the
true count by at most 1. The Laplace mechanism is the standard, well-understood tool for
privatizing count queries under this sensitivity model. It is computationally simple (a single
pseudorandom draw), does not require a trusted curator beyond the local device, and admits a
closed-form privacy-loss bound.

### Parameter choices

The privacy budget is set to **epsilon (ε) = 1.0** with **sensitivity = 1**. This gives a noise
scale parameter **b = sensitivity / ε = 1.0**. At b = 1, roughly 60% of draws fall within ±1 of
zero and roughly 86% fall within ±2. For a counter of, say, 50 adaptation events, the expected
error is ±1–2 counts — acceptable for trend analysis while providing strong per-user protection.

The privacy guarantee: for any two neighboring datasets (differing in exactly one individual's
contribution), the probability ratio of any output is bounded by e^ε = e^1 ≈ 2.718. This is
considered a strong guarantee for aggregate reporting; it is the same budget used by Apple's
keyboard emoji frequency collection and the US Census Bureau's OnTheMap product.

### Signal-to-noise guidance

Laplace noise has standard deviation √2 × b ≈ 1.41. For a segment of N devices each contributing
one submission per day, the noise in the segment aggregate scales as √N (because i.i.d. noise
sums in quadrature). Practical interpretability threshold: **a minimum of 20 devices per reported
segment** is recommended before drawing conclusions from trends. Below 20, the noise dominates
and month-over-month deltas are not statistically meaningful.

### The noise draw

```
Laplace(μ=0, b=sensitivity/ε):  f(x) = (1 / 2b) * exp(-|x - μ| / b)

Draw:  u ~ Uniform(-0.5, 0.5) \ {0}
       noise = -b * sign(u) * ln(1 - 2|u|)

noised_count = max(0, round(raw_count + noise))
```

The `max(0, ...)` floor prevents negative counts, which are meaningless for rate data. The
`round(...)` keeps the output as an integer, which is consistent with the source data type and
avoids introducing fractional-count artifacts that would look anomalous in dashboard charts.

### Known limit: composition over time

Laplace is applied independently per submission (i.e., per device per day). Over 30 daily
submissions from the same device, the composed privacy budget is ε = 30 × 1.0 = 30. This is a
known and documented limitation. VERIFY: Whether sequential composition or advanced composition
(Rényi DP accounting) should be applied in a future revision is an open design question. The v0
system documents this limit here rather than hiding it.

---

## 4. Merkle Commitment

### Purpose

Each published bundle includes a SHA-256 Merkle root computed over all counters in the bundle.
This root serves two purposes:

1. **Tamper evidence.** If a server-side process modifies a stored submission, the root no longer
   matches a recomputation from the stored counters. Any auditor can recompute the root and detect
   alteration.

2. **Zero-knowledge attestation hook (future).** The Merkle tree structure allows individual
   counter leaves to be proven against the root using a Merkle inclusion proof without revealing
   the other leaves. This is the foundation on which range proofs (see Section 9) will be built.

### Construction

The tree is a standard binary Merkle tree using SHA-256 at each internal node. Construction rules:

- Leaves are formed from counter lines in canonical format (see below), UTF-8 encoded, then
  SHA-256 hashed.
- Nodes are formed by hashing the concatenation of left child and right child digests.
- When a level has an odd number of nodes, the last node is duplicated to make the count even
  before ascending. This is the standard Bitcoin-style odd-level handling.

### Canonical line format

Each counter is serialized as a single line in the form `key:subkey=value` before hashing. The
key-subkey separator is always `:`, and the subkey is omitted (leaving the colon immediately
before `=`) for counters with no subtype. Example leaf lines for a given day's bundle:

```
adaptations_applied:FONT_SCALE=12
adaptations_applied:FOCUS_MODE=4
struggle_events_triggered:=7
features_enabled:focus_mode=1
languages_used:=[en,hi,ta]
estimated_accessibility_score_improvement:=63
```

Lines are sorted lexicographically before tree construction to ensure determinism. Two bundles
with identical counter values will always produce the same root, which enables proof-of-consistency
across recomputations.

### Privacy properties

The Merkle root is a cryptographic hash. It does not expose the individual counter values — a
root of `a3f9...` reveals nothing about whether `adaptations_applied:FONT_SCALE` is 5 or 500.
The root is therefore safe to log, publish in audit trails, and compare across periods without
introducing additional disclosure risk beyond the noised counters themselves.

---

## 5. Data Flow End-to-End

The following describes the full lifecycle of a single day's Observatory submission from the
extension through to the dashboard.

**Step 1 — In-memory collection.**
The background service worker hosts an `ObservatoryCollector` instance. As the content script
emits adaptation events and struggle-detector signals through the extension message bus, the
collector increments the appropriate counters in memory. At each browser session start the
collector checks `chrome.storage.local` for a persisted counter state for the current calendar
date; if found, it restores those counters so that a browser restart mid-day does not lose the
morning's data. At local midnight, the collector resets all counters to zero and begins a new
day's accumulation.

**Step 2 — Publish alarm.**
A `chrome.alarms` alarm fires every hour. On each alarm, the publisher checks three conditions:
(a) the user has opted in (`shareAnonymousMetrics: true` in their profile); (b) the current local
hour falls within the device's deterministic publish window, 02:00–05:00 local time, chosen to
avoid overlap with active working hours; and (c) at least 24 hours have elapsed since the last
successful publish for this calendar date. All three must hold before proceeding.

**Step 3 — Bundle, noise, and commit.**
The publisher calls `aggregateDailyBundle()`, which reads the raw counters, applies the Laplace
draw to each numeric counter, floors negative results to zero, rounds to integers, and then
constructs the Merkle tree over the canonical leaf lines. The Merkle root is appended to the
bundle. The raw (pre-noise) counters are discarded after this step; they are never transmitted.

**Step 4 — Publish to VPS.**
The publisher sends a single HTTP POST to
`http://72.61.227.64:8300/observatory/api/publish`. The nginx reverse proxy at port 8300
routes the request to the `accessbridge-observatory` container listening on port 8200. The
request body is a JSON object containing the noised counters, the Merkle root, the calendar date,
and a schema version field. No cookies, no session tokens, no identifying headers are included
or accepted. The server does not log the source IP to the application database — it appears only
in the transient nginx rate-limit memory.

**Step 5 — Server ingestion.**
The Observatory server validates the incoming JSON against the schema (required fields, date
format, counter value types, Merkle root length). On validation success it performs two writes
in a single transaction: an INSERT into `submissions` (one row per payload, for audit trail) and
an UPSERT into `aggregated_daily` (summing noised counters by date and feature category). The
Merkle root is stored with the submission row. If the date is more than 48 hours in the past
or more than 1 hour in the future, the submission is rejected with a 400 response to limit
replay window.

**Step 6 — Dashboard consumption.**
The static dashboard HTML/JS served at
`http://72.61.227.64:8300/observatory/` reads three API endpoints:
`/observatory/api/summary` (current-period KPI cards), `/observatory/api/trends` (time-series
data for charts), and `/observatory/api/compliance-report` (regulatory evidence tables and
PDF export data). All three endpoints read only from `aggregated_daily`; the `submissions` table
is inaccessible to the dashboard layer.

---

## 6. Opt-In and Revoke Flow

### Enabling Observatory

1. Open the AccessBridge popup and navigate to the **Settings** tab.
2. Scroll to the **Anonymous Metrics (Opt-in)** section.
3. Toggle the switch to the on position. A brief confirmation message appears confirming
   that data collection has started.
4. The `shareAnonymousMetrics` field on the user's `AccessibilityProfile` is set to `true`
   and persisted via `chrome.storage.local`.
5. Collection begins immediately for the current day. The first publish occurs at the next
   02:00–05:00 local window following a full calendar day of data accumulation.

### What happens while enabled

The `ObservatoryCollector` increments counters on every adaptation event and struggle trigger.
Counters persist across popup opens and closes, across tab navigations, and across browser restarts
within the same calendar day. At local midnight the day's counters are finalized and queued for
publishing at the next eligible alarm.

### Revoking consent

1. Return to Settings → Anonymous Metrics.
2. Toggle the switch to the off position.
3. The `shareAnonymousMetrics` field is set to `false`. The in-memory collector clears its
   counters immediately. No further data is accumulated or transmitted for any subsequent day.
4. The pending hourly alarm continues to fire but the opt-in check in Step 2 of the data flow
   will fail, so no publish occurs.

### Revoke is forward-only

This is a deliberate design constraint, not an oversight. Prior published aggregates cannot be
retracted. Because the server stores only noised aggregate counts with no device association,
there is no key that would allow the server to identify which rows to remove. A retraction
mechanism would require the server to store per-device identifiers, which would defeat the
primary privacy goal. Users should understand this before enabling: enabling means contributing
to aggregate counts that will remain in the dashboard indefinitely.

---

## 7. Regulatory Mapping

The following subsections describe how Observatory data can serve as supporting evidence for
common regulatory obligations. They are not legal opinions.

### 7.1 RPwD Act 2016 (India) — Section 20

VERIFY: The Rights of Persons with Disabilities Act 2016, Section 20, requires every
establishment to make reasonable accommodation for persons with disabilities. "Reasonable
accommodation" is defined in Section 2(y) as necessary and appropriate modification and
adjustments, without imposing a disproportionate or undue burden, to ensure persons with
disabilities enjoy equal rights and opportunities. The appropriate government may prescribe
the manner in which establishments shall inform employees of available accommodations.

**How Observatory supports compliance:**

- The adaptation-event counts broken down by `AdaptationType` (font scale, contrast, color
  correction, focus mode, voice navigation, dwell click, etc.) demonstrate that accommodation
  mechanisms are not only deployed but actively used on working days.
- The per-domain-connector activation counts show whether accommodation extends across the
  digital tools employees actually encounter — banking portals, insurance platforms, healthcare
  systems, ERP interfaces — rather than being limited to a single application.
- The languages-used dimension is particularly relevant for India's multilingual workforce.
  An establishment with employees across Hindi, Tamil, Telugu, Kannada, Bengali, and other
  language groups can demonstrate that accessibility accommodation reaches workers in their
  preferred language, not only in English.
- Month-over-month trends from the Trends tab provide evidence that accommodation is an
  ongoing operational practice, not a one-time configuration.

**This is supporting evidence only. Consult counsel for a regulatory audit.**

### 7.2 European Accessibility Act 2025 — Article 4

VERIFY: Article 4 of the European Accessibility Act 2025 (Directive (EU) 2019/882 as enacted)
sets out accessibility requirements for products and services in scope of the directive. Member
states are required to ensure that economic operators make their products and services accessible
in accordance with the requirements of Annex I. The deadline for compliance for new products and
services is June 2025; the transitional period for existing services extends to 2030 for services
and 2032 for certain hardware categories.

**How Observatory supports compliance:**

- Domain-connector adoption counts show which categories of employee-facing services are
  covered by accessibility adaptations. An employer can demonstrate that accessibility measures
  were applied on the banking, insurance, telecom, retail, healthcare, and manufacturing digital
  surfaces that employees use in their role.
- Adaptation-type distribution shows breadth of conformance across sensory (visual), cognitive
  (reading, simplification), and motor (voice, keyboard, dwell) accommodation categories, which
  maps to the multi-modal nature of Annex I requirements.

**Scope note:** Article 4 applies to employers as economic operators providing services and
to product manufacturers. AccessBridge covers employee-facing use of external web services.
Internal intranet and SaaS applications that fall within an employer's own service provision
require separate conformance assessment.

**This is supporting evidence only. Consult counsel for a regulatory audit.**

### 7.3 ADA Title I (USA) — Reasonable Accommodation

Title I of the Americans with Disabilities Act prohibits covered employers from discriminating
against qualified individuals on the basis of disability. Reasonable accommodation is a central
obligation: employers must provide accommodations that allow a qualified individual to perform
the essential functions of the job, unless the accommodation would pose an undue hardship.
EEOC regulations and guidance describe an interactive process between employer and employee,
and the EEOC expects employers to maintain records of that process.

**How Observatory supports compliance:**

- Per-feature enablement counts (focus mode, voice navigation, eye tracking, keyboard-only mode,
  predictive input, dwell click) provide evidence that specific accommodation categories are
  deployed and in active use. An employer responding to an EEOC inquiry about whether a given
  accommodation was available can point to aggregate usage data showing the feature was actively
  in use by the workforce during the relevant period.
- Struggle-trigger trend data shows that the employer's accessibility infrastructure is
  responding to real-time user difficulty signals — evidence of a proactive accommodation stance
  rather than a passive one.

**Scope note:** EEOC formal accommodation requests and any litigation record still require
individual-level documentation (the interactive process between employer and the specific
employee). Observatory aggregate data does not substitute for individual accommodation
records when a formal request has been made or when a complaint has been filed.

**This is supporting evidence only. Consult counsel for a regulatory audit.**

---

## 8. HR Operational Workflow

Observatory is designed to fit into existing HR review rhythms without requiring new tooling
expertise. Three use cases, three time scales.

### Weekly review (HR manager, approximately 10 minutes)

Open the dashboard Overview tab at `http://72.61.227.64:8300/observatory/`. The top row
of KPI cards shows the current week's total adaptation events, total struggle triggers,
active feature count, and estimated accessibility score improvement. Scan for anomalies:
a sudden drop in adaptation events may indicate a browser update broke a feature; a spike
in struggle triggers may indicate a newly deployed internal application is causing difficulty.

The adaptation breakdown panel below the KPIs shows the top five adaptation types by event
count. This is the week's primary signal on which accommodation categories are most in demand.

Typical time: three minutes to scan KPIs, five minutes to investigate any anomaly.

### Monthly audit (DEI lead, approximately 30 minutes)

Navigate to the Trends tab. Set the date range to the previous calendar month. The time-series
charts show daily counts for adaptation events, struggle triggers, and feature enablements.

Key analysis steps:
1. Compare the current month's totals to the previous month. Decreasing adaptation events
   with stable struggle triggers may indicate that users are abandoning the extension rather
   than finding it less necessary.
2. Examine the language coverage breakdown. If the workforce has significant Hindi, Tamil,
   or Telugu speakers but those language codes are absent from the languages-used data,
   there is a coverage gap worth investigating.
3. Check domain-connector adoption. If the organization uses a specific banking or insurance
   portal and that connector shows zero activations, either the URL domain is not matched
   by the connector or employees are not using AccessBridge on that portal.
4. Use the browser's print dialog (or the Export PDF button if present in the dashboard)
   to generate a monthly snapshot for the record.

Typical time: 20 minutes analysis, 10 minutes documentation.

### Regulatory evidence package (compliance lead, as needed)

Navigate to the Compliance Report tab. Select the reporting period (typically a calendar quarter
or the period since last filing). Click "Generate PDF". The generated report includes:

- Period summary: total adaptation events, unique feature categories, language coverage
- Adaptation-type breakdown table (suitable for attachment to an RPwD or ADA response)
- Domain coverage table
- Month-over-month trend chart
- A statement of methodology noting that all data is anonymized and differentially private

Attach the PDF to the relevant quarterly filing, HR audit response, or regulatory inquiry
package. Include the methodology statement as it contextualizes the aggregate-only nature
of the data for regulators unfamiliar with differential privacy.

---

## 9. Zero-Knowledge Attestation (Future)

Today, the Merkle root transmitted with each submission serves as tamper evidence only. An
auditor who receives both the published counters and the root can verify that the counters
have not been modified since submission by recomputing the tree. However, nothing prevents
the submitting device from fabricating counters before submission — the current system requires
trust in the extension's local computation. This is acceptable for v0 because the primary
threat model concern is server-side tampering and re-identification, not fabrication.

The post-submission roadmap (informed by the direction of R2-01, the admin console, and the
longer-horizon R4-04 on-device ML work) anticipates a transition to cryptographic range proofs
that keep counter values device-side while proving to the server that they satisfy certain
bounds — for example, that an adaptation count is non-negative and below a plausible daily
ceiling, or that the estimated accessibility score falls within the 0–100 range declared in the
schema. VERIFY: The specific proof system — candidates include Groth16 zk-SNARKs for arithmetic
circuits or BBS+ signatures for selective disclosure of committed attributes — has not been
selected. Selection depends on the computational budget available in a Chrome extension service
worker and the complexity of the statement being proven. This section will be updated when a
proof system is chosen and a prototype is benchmarked.

---

## 10. Threat Model and Residual Risk

### Mitigated by design

**Per-user re-identification via counter pattern.**
An adversary who observes a bundle where `eye_tracking=1` and all other feature counts are zero
might infer that exactly one person used eye tracking that day. The Laplace mechanism addresses
this: with b = 1.0, a true count of 1 produces a noised output anywhere in the range 0–4 with
non-trivial probability. The adversary cannot distinguish "one user, noised count of 1" from
"zero users, noised count of 1 (positive noise draw)." Bounded per-user contribution (sensitivity
= 1) ensures the guarantee holds for any single individual.

**Server compromise.**
The application database stores only noised aggregates. A complete database dump reveals
what the aggregate workforce was doing on which dates, at the category level. No individual
record exists to extract. The `submissions` table contains one row per bundle with noised
counters and a Merkle root — still aggregate data, not individual.

**Replay attacks.**
The server rejects submissions with a date field more than 48 hours in the past or more than
1 hour in the future. Combined with nginx's per-IP rate limiting, this prevents a single
client from inflating aggregate counts by replaying old valid bundles.

**Cross-day aggregation collapsing noise.**
Each Laplace draw is independent. Summing 30 days of noised counts from a single device gives
a composed epsilon of 30, not 1. This is documented in Section 3 as a known limit. For the
*server-side aggregate* across many devices, the noise terms partially cancel, improving the
signal quality of the aggregate while the per-device composition budget remains bounded.

### Not mitigated

**Network observer timing and egress-IP correlation.**
A network observer (corporate proxy, ISP, or government monitor) can see that a device sends
an outbound HTTPS POST to `72.61.227.64:8300` once per day in the 02:00–05:00 window. This
reveals that AccessBridge Observatory is running on that device, which may itself be sensitive
in some contexts. Hiding this would require routing through a mix network or Tor, which is out
of scope for v0 and would likely violate enterprise network policies. This risk is documented
and accepted.

**Revoke does not retroactively delete aggregates.**
As described in Section 6, prior published aggregates have no per-device association on the
server. There is no technical mechanism to retract them. A user who opts out stops contributing
future data but their past contributions (as noised counts summed into aggregates) remain. This
is a deliberate design choice, not a gap.

---

## 11. Implementation File Map

| Role | File | Purpose |
|---|---|---|
| Extension publisher | `packages/extension/src/background/observatory-publisher.ts` | Hourly alarm handler; opt-in check; calls collector, applies Laplace noise, constructs Merkle root, POSTs bundle |
| Extension collector | `packages/extension/src/background/observatory-collector.ts` | In-memory counter store; `chrome.storage.local` persistence; midnight reset; increments on adaptation and struggle events |
| Settings UI | `packages/extension/src/popup/App.tsx` | Settings tab — Anonymous Metrics section with opt-in toggle wired to `shareAnonymousMetrics` profile field |
| Profile type | `packages/core/src/types/profile.ts` | `shareAnonymousMetrics: boolean` field on `AccessibilityProfile` |
| VPS server | `ops/observatory/server.js` | Express app; `/api/publish`, `/api/summary`, `/api/trends`, `/api/compliance-report`, `/api/health`, `/api/observatory/{funnel,feature-usage,language-breakdown,domain-penetration,adaptation-effectiveness,compliance/rpwd,compliance/ada,compliance/eaa}` (Session 23) |
| Seed script | `ops/observatory/seed-demo-data.js` | Populates `aggregated_daily` with 30 days of synthetic data for dashboard demos |
| Dashboard — entry | `ops/observatory/public/index.html` | Single-page dashboard shell; tab navigation |
| Dashboard — styles | `ops/observatory/public/styles.css` | Dashboard visual layer |
| Dashboard — logic | `ops/observatory/public/app.js` | Fetches API endpoints; renders KPI cards, trend charts, compliance report tables |
| Infra — compose | `ops/docker-compose.yml` | `accessbridge-observatory` service definition; port 8200 internal |
| Infra — nginx | `ops/nginx/default.conf` | `/observatory/` location block proxying to `accessbridge-observatory:8200` |
| Tests | `packages/extension/src/background/__tests__/observatory-publisher.test.ts` | Unit tests for Laplace draw, Merkle construction, bundle format, publish logic |

---

## 12. Installation and Operation

### VPS operator — starting the Observatory service

```bash
# SSH into the VPS, then:
cd /opt/accessbridge

# Bring up the Observatory container (alongside the main app)
docker compose up -d observatory

# Verify the server is healthy
curl http://127.0.0.1:8200/api/health
# Expected: {"status":"ok","uptime":<seconds>}

# Verify nginx is proxying correctly from the public port
curl http://127.0.0.1:8300/observatory/api/health
# Expected: same {"status":"ok",...}
```

The dashboard is available at `http://72.61.227.64:8300/observatory/` once the container
is running and nginx has reloaded its configuration.

### Seeding demo data (optional, for presentations)

```bash
docker compose exec observatory node /app/seed-demo-data.js
# Inserts 30 days of synthetic aggregate data.
# Safe to run on a live instance — seed rows use future dates by default
# and do not conflict with real submissions.
```

### User opt-in walkthrough

1. Install AccessBridge from the Chrome Web Store or load the unpacked extension from `dist/`.
2. Click the AccessBridge icon in the Chrome toolbar to open the popup.
3. Click the **Settings** tab (gear icon or "Settings" label depending on popup layout).
4. Scroll down to the **Anonymous Metrics (Opt-in)** section.
5. Read the short disclosure statement, then toggle the switch to the on position.
6. A confirmation note appears: "Data collection active. First report publishes tonight."
7. The first publish occurs during the 02:00–05:00 local window on the following night,
   provided the browser is running at that time.

### User revoke walkthrough

1. Open the AccessBridge popup → Settings tab.
2. Scroll to **Anonymous Metrics (Opt-in)**.
3. Toggle the switch to the off position.
4. Collection halts immediately. In-memory counters are cleared.
5. No further data is transmitted for any subsequent day.
6. Historical aggregate contributions are not retractable — see Section 6 for rationale.

---

## 12b. Session 23 — Enterprise analytics expansion

Session 23 added 8 additive analytics endpoints under `/api/observatory/` to drive richer enterprise pilot → scale ROI narratives. Every endpoint preserves the differential-privacy contract (Laplace ε=1.0), applies the k-anonymity floor of 5 to any categorical breakdown, uses parameterized `better-sqlite3` prepared statements, and honors the existing `rateLimit` middleware.

### New endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/observatory/funnel?days=30` | Adoption funnel: enrolled → active → features_used → sustained_use_7d → sustained_use_30d |
| `GET /api/observatory/feature-usage?days=30&bucket=day\|week\|month` | Top-10 per-feature time series; bucket collapse via SQLite `strftime` |
| `GET /api/observatory/language-breakdown?days=30` | Per-BCP-47 devices + 14 script-family rollups (Devanagari, Tamil, Bengali, CJK, Arabic, Latin, Cyrillic, Thai, Turkish, …) |
| `GET /api/observatory/domain-penetration?days=30` | Per-domain-connector devices + usage_score, ranked |
| `GET /api/observatory/adaptation-effectiveness?days=30` | `applied / reverted / effectiveness_pct` overall + per-adaptation. `reverted` proxied to 0 until Session 24 collects the counter |
| `GET /api/observatory/compliance/rpwd?days=30` | Maps features to RPwD Act 2016 Section 20 accommodation categories (Visual / Auditory / Motor / Cognitive) with per-category coverage % |
| `GET /api/observatory/compliance/ada?days=30` | Same shape, ADA Title I regulation label |
| `GET /api/observatory/compliance/eaa?days=30` | Same shape, EAA Article 4 regulation label |

### Differential privacy contract — unchanged

All new endpoints read from the same `aggregated_daily` table that the legacy `/api/summary` + `/api/trends` use. The Laplace noise is added at the device on the write path (in `observatory-publisher.ts`), not at the read path, so additive endpoints inherit the same ε=1.0 guarantee. Adding 8 new read endpoints does **not** increase the privacy loss for a given user's counter — it just re-slices already-noised aggregates.

### RPwD / ADA / EAA mapping rationale

Regulatory frameworks don't enumerate specific web accommodations — they require "reasonable accommodation" without prescribing technique. We therefore group the 12 internal adaptation types into four canonical disability categories (Visual / Auditory / Motor / Cognitive), each of which maps to an accommodation surface:

| Category | Adaptations that count toward coverage |
|---|---|
| Visual | `FONT_SCALE`, `CONTRAST`, `REDUCED_MOTION` |
| Auditory | `AUTO_SUMMARIZE` (text alternative to audio content) |
| Motor | `VOICE_NAV`, `EYE_TRACKING`, `KEYBOARD_ONLY`, `PREDICTIVE_INPUT`, `CLICK_TARGET_ENLARGE` |
| Cognitive | `FOCUS_MODE`, `READING_MODE`, `TEXT_SIMPLIFY`, `LAYOUT_SIMPLIFY` |

`coverage_pct` per category = 100 if **any** adaptation in that category triggered in the window, else 0. `overall_coverage_pct` = mean of the four category values. The disclaimer is explicit: this is a self-assessment aid, not a legal certification.

### Dashboard tabs

The static dashboard at `/observatory/` gains 5 new tabs (Funnel, Features, Languages, Domains, Compliance), each rendered with pure inline SVG — no new JS dependencies. The existing Overview and Trends tabs are unchanged. The Compliance tab is a tri-column view showing RPwD / ADA / EAA side-by-side plus a "Generate Compliance Report" button that downloads JSON and triggers browser print-to-PDF.

---

## 13. See Also

- [Feature catalog](../../FEATURES.md) — full list of AccessBridge features.
  Note: Feature #10 (Compliance Observatory) does not yet have a row in FEATURES.md
  as of the current catalog revision; add a row in the same commit that ships the Observatory
  feature end-to-end.
- [Architecture](../../ARCHITECTURE.md) — system design, message bus, storage keys, package
  boundaries, and the VPS deployment topology that Observatory builds on.
- [Roadmap](../../ROADMAP.md) — post-submission execution plan. R2-01 (admin console with
  anonymized aggregate struggle data) and R4-04 (on-device ML, relevant to local-only
  computation for ZK proofs) are the roadmap items most relevant to Observatory's future.
- [UI Guidelines](../../UI_GUIDELINES.md) — canonical color tokens, spacing rhythm, and
  component patterns. Any changes to the dashboard UI or the popup Settings toggle must
  source values from the tokens defined there.
