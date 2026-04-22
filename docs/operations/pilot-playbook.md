# Pilot Playbook — AccessBridge 100-User Pilot

This playbook guides a pilot coordinator through a 45–60 day, 100-user pilot of AccessBridge. It covers Plan Section 15 Phase 2: the structured cohort launch that validates Team deployment tooling, refines preset profiles, and produces a written decision artifact (scale / extend / abort).

For the install commands, flag reference, and preset profiles used during the pilot, see [docs/deployment/team.md](../deployment/team.md). For observatory analytics, see [docs/features/compliance-observatory.md](../features/compliance-observatory.md).

---

## Table of Contents

1. [Pre-launch Checklist (1 week before Day 1)](#1-pre-launch-checklist-1-week-before-day-1)
2. [Launch Day and Week 1 Ramp](#2-launch-day-and-week-1-ramp)
3. [Days 1–14: Daily Monitoring](#3-days-114-daily-monitoring)
4. [Days 15–30: Mid-Pilot Feedback and Profile Tuning](#4-days-1530-mid-pilot-feedback-and-profile-tuning)
5. [Days 31–45: Fold Learnings into Connectors and RCA](#5-days-3145-fold-learnings-into-connectors-and-rca)
6. [Days 46–60: Pilot Report and Decision](#6-days-4660-pilot-report-and-decision)
7. [Templates](#7-templates)
8. [Small-Cohort (N < 20) Handling](#8-small-cohort-n--20-handling)
9. [Escalation Matrix](#9-escalation-matrix)

---

## 1. Pre-launch Checklist (1 week before Day 1)

Complete every item in this checklist before sending the launch email. A missed item on launch day is an incident waiting to happen.

### Contact roster

- [ ] Compile the list of 100 participants: name, email, machine OS (Windows / macOS / Linux), Chrome version, department.
- [ ] Identify the 5 "super users" (one per 20-user wave) who will be primary feedback contacts during the first week.
- [ ] Identify the IT admin who has access to each machine (remote execution, SCCM, or physical access for the install command).
- [ ] Confirm the support channel assignment: Slack channel name, Teams channel name, or email alias — must be monitored during business hours for the first two weeks.
- [ ] Share the support channel link with every participant before Day 1.

### Preset selection

- [ ] Review the preset catalog in [docs/deployment/team.md §5](../deployment/team.md#5-preset-profile-catalog) and select the preset that best matches the cohort's primary accessibility needs.
- [ ] If no preset fits, download the closest preset and customize it:
  ```bash
  curl -fsSL https://accessbridge.space/team/profiles/pilot-default.json -o my-preset.json
  # Edit my-preset.json, then host it internally or pass --profile-file at install time
  ```
- [ ] Test the preset on one machine manually before deploying at scale. Confirm the extension loads, the profile applies, and no Chrome policy conflict appears.

### Admin token and observatory setup

- [ ] Confirm the observatory server is reachable from participant machines: `curl -I http://72.61.227.64:8300/api/version` must return `200 OK`.
- [ ] Generate a pilot ID. Convention: `<dept>-<YYYY>-<q>` (e.g. `hr-2026-q2`). Record it — all install commands and report generation commands will use this ID.
- [ ] Verify the pilot dashboard at `http://72.61.227.64:8300/observatory/pilot.html?pilot_id=<your-pilot-id>` loads (it will be empty until Day 2 after the first user opts in).
- [ ] If the pilot is a research study requiring observatory opt-in from all participants, use the `fatigue-study` preset or set `observatoryOptIn: true` in a custom preset and explain the data model to participants in the launch email.

### Rollback plan

- [ ] Document the rollback procedure in your internal runbook:
  ```bash
  # Remove managed-policy JSON — Chrome removes extension on next restart
  curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --uninstall
  ```
- [ ] Test the rollback on one machine before launch.
- [ ] Identify who has authorization to trigger a rollback (pilot coordinator + one IT admin backup, minimum).
- [ ] Define the rollback trigger condition: "if > 10% of users report a critical issue within the first 48 hours, trigger rollback immediately without waiting for a root-cause determination."

### Support channel assignment

- [ ] Create the support channel (Slack / Teams) and add the pilot coordinator, IT admin, and the 5 super users.
- [ ] Pin the following to the channel:
  - The install command for each OS.
  - Link to [docs/deployment/team.md §9](../deployment/team.md#9-troubleshooting) troubleshooting table.
  - The escalation matrix (§9 of this playbook).
  - The rollback command.

---

## 2. Launch Day and Week 1 Ramp

### Staggered enrollment — 20 users per day over 5 days

Enrolling all 100 users on Day 1 produces a spike of support requests if something goes wrong. Staggered enrollment limits the blast radius and provides 24 hours of observable data before adding the next wave.

| Day | Wave | Users | Pilot-ID tag |
|---|---|---|---|
| 1 | Wave 1 | Users 1–20 | `<pilot-id>-w1` |
| 2 | Wave 2 | Users 21–40 | `<pilot-id>-w2` |
| 3 | Wave 3 | Users 41–60 | `<pilot-id>-w3` |
| 4 | Wave 4 | Users 61–80 | `<pilot-id>-w4` |
| 5 | Wave 5 | Users 81–100 | `<pilot-id>-w5` |

After Day 5, generate a unified report using the parent pilot ID (without the `-wN` suffix) to aggregate all waves.

### Install command for each wave

```bash
# macOS / Linux — replace <preset> and <pilot-id>-w<N> per wave
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- \
  --profile <preset> \
  --pilot-id <pilot-id>-w<N>

# Windows — run as the user (not SYSTEM) unless using --all-users
iwr https://accessbridge.space/team/install.ps1 | iex -args `
  '--profile <preset> --pilot-id <pilot-id>-w<N>'
```

### Dashboard monitoring setup

After Wave 1 completes and participants have opened Chrome:

1. Open the pilot dashboard: `http://72.61.227.64:8300/observatory/pilot.html?pilot_id=<pilot-id>-w1`
2. Confirm the **Devices** counter increments as users opt in.
3. Bookmark the following URLs for daily monitoring:
   - `…/pilot.html?pilot_id=<pilot-id>-w1#overview` — device count, daily active, feature-usage heatmap
   - `…/pilot.html?pilot_id=<pilot-id>-w1#feedback` — survey responses
   - `…/observatory/#trends` — overall observatory trends (all cohorts)

### Incident response protocol

An incident is any event that prevents a user from using their machine productively or that could expose the organization to risk. Incidents are not just crashes — a mis-configured policy that locks users out of a feature they need is also an incident.

**Detection:** Users report via the support channel. The pilot coordinator monitors the dashboard for error-rate spikes (error_events counter climbing > 2× baseline for 2+ consecutive days).

**Triage (within 2 hours of report):**

1. Ask the affected user to share their Chrome version (`chrome://settings/help`) and OS version.
2. Ask the IT admin to run the installer in dry-run mode and share the output:
   ```bash
   curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --dry-run --log-file /tmp/ab-dryrun.log
   ```
3. Check the troubleshooting table in [docs/deployment/team.md §9](../deployment/team.md#9-troubleshooting).

**Resolution SLA:**

| Severity | Definition | Resolution SLA |
|---|---|---|
| P1 — Critical | Data loss, security concern, machine unusable | 4 hours |
| P2 — High | Extension non-functional for >20% of wave | 24 hours |
| P3 — Medium | Feature broken; workaround exists | 3 business days |
| P4 — Low | Cosmetic, documentation gap | Next minor release |

**Escalation:** If a P1 or P2 cannot be resolved within SLA, trigger rollback immediately and file a GitHub Issue with `[P1]` or `[P2]` in the title. See §9 for the escalation matrix.

---

## 3. Days 1–14: Daily Monitoring

The first two weeks are the highest-risk period. Users are forming habits; configuration problems surface quickly when a feature is exercised for the first time.

### Daily review routine (15 minutes per day)

1. Open the pilot dashboard for each active wave.
2. Check the **Devices** counter — is it growing as expected? A flat counter after 24 hours means users have not opted in to observatory. Reach out to wave super users.
3. Check the **Feature usage** heatmap — which features are being used? Which are at zero? Zero-usage features either are not relevant to the cohort (acceptable) or users do not know they exist (send a tip in the support channel).
4. Check the **Struggle score** trend line — is it decreasing over time? A flat or rising struggle score after Day 3 may indicate the preset is inappropriate for this cohort.
5. Check the **Error events** counter — any spike > 2× the Day 1 baseline warrants investigation.
6. Check the **Feedback** tab — any Likert responses below 3 (out of 5) on the same question for multiple users is a signal.

### Key metrics and thresholds

| Metric | Healthy range | Action if outside range |
|---|---|---|
| Daily active devices / enrolled devices | > 60% | Reach out to low-activity users; confirm Chrome is being used |
| Struggle score (7-day moving average) | Declining or < 30 | Investigate preset fit; consult §4 profile tuning |
| Feature usage — at least 3 features per active user per week | Yes | Highlight underused features in the support channel |
| Feedback Likert average (Q1–Q5) | > 3.5 | Survey open-text responses for patterns |
| Error events (daily) | < 5% of daily active devices | Investigate; check RCA.md for known patterns |
| Observatory opt-in rate | > 70% of enrolled devices | Remind non-opted-in users; cannot compel opt-in |

### When to intervene

Intervene (change the preset, re-enroll affected users, or add a tip to the support channel) when:

- The struggle score for a wave does not begin declining within 5 days of enrollment.
- A specific feature generates more than 3 negative feedback responses in one week.
- More than 10% of a wave's users have not opened the extension at all after 5 days.
- An error event appears in > 5% of devices on the same day (likely a Chrome update changed behavior — check the Chrome release calendar).

**Do not intervene** for:
- Individual users who report the extension is "distracting" — this is a preference issue, not a bug. Direct them to the popup's feature toggles.
- Struggle scores above 50 for the first 3 days — this is the baseline calibration period; the score is expected to start high.

---

## 4. Days 15–30: Mid-Pilot Feedback and Profile Tuning

### Feedback analysis

At Day 15, run the feedback report:

```bash
npx ts-node tools/pilot/generate-report.ts \
  --pilot-id <pilot-id> \
  --days 14 \
  --format json \
  --output reports/mid-pilot-day15.json
```

Open the JSON and look for:

1. **Low-scoring Likert items (< 3 average).** Which question? Q1 (ease of install), Q2 (feature relevance), Q3 (struggle score feels accurate), Q4 (would recommend), Q5 (overall satisfaction)?
2. **Open-text patterns.** Use simple keyword frequency on the `comments` array — themes like "too slow", "distracting captions", "wrong language" each suggest a specific preset change.
3. **Feature-specific feedback.** The feedback widget records which tab the user had open when they submitted — this links negative feedback to specific features.

### Preset iteration

If feedback analysis reveals a systematic issue with the preset:

1. Download the current preset:
   ```bash
   curl -fsSL https://accessbridge.space/team/profiles/pilot-<name>.json -o preset-v2.json
   ```
2. Make the targeted change (e.g. lower the dwell-click delay from 600 ms to 400 ms).
3. Re-enroll only the affected users using `--profile-file`:
   ```bash
   curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- \
     --profile-file ./preset-v2.json \
     --pilot-id <pilot-id>-tuned
   ```
4. Monitor the dashboard for the re-enrolled sub-cohort for 5 days before concluding the change helped.

### Re-enrollment

Re-enrollment overwrites the local profile JSON. The extension applies the new profile at next startup. Users who had customized settings beyond the preset defaults will see those customizations replaced with the preset. Warn users before re-enrolling them.

```bash
# Re-enroll a single user's machine
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- \
  --profile-file ./preset-v2.json \
  --pilot-id <pilot-id> \
  --quiet
```

---

## 5. Days 31–45: Fold Learnings into Connectors and RCA

### Capturing bugs in RCA.md

Any reproducible bug discovered during the pilot must be captured in [`RCA.md`](../../RCA.md) before the pilot ends. A bug that is not in RCA.md will be forgotten and will recur in the next cohort.

Format per the existing RCA.md pattern:

```
## BUG-0XX — <short title>

**Session:** 24 (Pilot)
**Symptom:** <what the user observed>
**Root cause:** <why it happened>
**Fix:** <file:line — what changed>
**Prevention:** <rule that prevents recurrence>
```

Common pilot-discovered bug classes based on past sessions:

- **Preset mismatch bugs** — a key in the preset JSON conflicts with the extension's current profile schema version. Prevention: validate preset JSON against `packages/core/src/types/profile.ts` before deploying.
- **Chrome policy path bugs** — the managed-policy JSON ends up in the wrong directory on a specific Linux distro. Prevention: add distro detection to the Linux installer.
- **Observatory opt-in not persisting** — user opts in, closes Chrome, reopens, and opt-in is gone (RCA BUG-005 pattern). Prevention: observatory opt-in must be stored in `chrome.storage.local`, not in-memory.

### Updating domain connectors

If the pilot cohort is domain-specific (e.g. banking, healthcare), analyze the observatory feature-usage data for domain-connector activation rates. If the `D-01` banking connector is active on fewer than 40% of banking-preset devices, the connector's hostname-match pattern may need updating.

To view connector activation:

```
http://72.61.227.64:8300/observatory/#features?filter=domain_connector
```

Domain connector files: [`packages/extension/src/content/domains/`](../../packages/extension/src/content/domains/). The registry at [`content/domains/index.ts`](../../packages/extension/src/content/domains/index.ts) routes by hostname match — add new patterns for internal-only domains that users access frequently.

---

## 6. Days 46–60: Pilot Report and Decision

### Generating the pilot report

The report generator at [`tools/pilot/generate-report.ts`](../../tools/pilot/generate-report.ts) queries the observatory API and produces a structured report.

```bash
# Full report — PDF format
npx ts-node tools/pilot/generate-report.ts \
  --pilot-id <pilot-id> \
  --days 45 \
  --format pdf \
  --output reports/pilot-final-<pilot-id>.pdf

# Also generate JSON for programmatic use
npx ts-node tools/pilot/generate-report.ts \
  --pilot-id <pilot-id> \
  --days 45 \
  --format json \
  --output reports/pilot-final-<pilot-id>.json
```

The PDF report includes:

- Enrollment curve (devices per day over the pilot period)
- Feature-usage heatmap (all 45 days)
- Struggle score trend (all users, 7-day moving average)
- Feedback Likert averages (Q1–Q5) with open-text word cloud
- Bug count and severity breakdown
- Comparison to pre-pilot baseline (if available)
- Recommendation appendix (generated from the decision matrix below)

### Scale / extend / abort decision matrix

Use the following matrix to produce a formal recommendation. The matrix assumes a 45-day pilot with 100 enrolled users.

| Dimension | Scale | Extend | Abort |
|---|---|---|---|
| Observatory opt-in rate | ≥ 70% | 40–70% | < 40% |
| Struggle score (Day 45 avg) | < 30 (vs > 50 at Day 1) | 30–50 | > 50 or rising |
| Feature usage (features used per user per week, avg) | ≥ 3 | 1–3 | < 1 |
| Feedback Likert average (Q4 — would recommend) | ≥ 4.0 | 3.0–4.0 | < 3.0 |
| P1/P2 incidents | 0 | 1 resolved | > 1 or unresolved |
| Rollback triggered | No | No | Yes |

**Scale:** Deploy to the full department (all remaining users). Proceed to Team → Enterprise upgrade if policy lockdown is needed. Archive the pilot preset as the department standard.

**Extend:** Run an additional 15 days with focused interventions. Re-survey users at Day 60. If still in "Extend" territory, move to Abort and document learnings.

**Abort:** Uninstall from all devices:
```bash
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --uninstall
```
Write a post-mortem in RCA.md covering the top 3 reasons the pilot did not meet criteria. Capture all learnings before they are lost.

---

## 7. Templates

### Launch email template

Subject: AccessBridge pilot — your install instructions

---

Hi {first_name},

You have been invited to join the AccessBridge accessibility pilot for {department}. AccessBridge is a Chrome extension that automatically adapts web pages to your accessibility preferences — adjusting fonts, reducing visual complexity, providing live captions, and more.

**Your pilot ID:** `{pilot_id}`

**Install command (takes about 2 minutes):**

macOS / Linux:
```
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile {preset} --pilot-id {pilot_id}
```

Windows (PowerShell):
```
iwr https://accessbridge.space/team/install.ps1 | iex -args '--profile {preset} --pilot-id {pilot_id}'
```

After installation, open Chrome. The AccessBridge icon will appear in your toolbar. Click it to explore features or adjust settings. To share anonymous usage data (which helps improve the tool), open the extension popup → Settings → Privacy → toggle on "Share anonymous metrics."

**Support:** Join {support_channel} for questions. Expected response time is under 4 hours during business hours.

**Feedback:** Use the Feedback button at the bottom of the extension popup at any time. Your responses help shape the final configuration.

**Install URL:** {install_url}
**Support email:** {support_email}

Thank you for participating.

— {pilot_coordinator_name}

---

### Feedback survey (5-question Likert)

Presented in the extension popup feedback widget. Scale: 1 (strongly disagree) — 5 (strongly agree).

| Q# | Question |
|---|---|
| Q1 | The extension was easy to install and set up. |
| Q2 | The features activated by default are relevant to my work. |
| Q3 | The extension correctly detects when I am struggling with a page. |
| Q4 | I would recommend this extension to a colleague who faces similar accessibility needs. |
| Q5 | Overall, this extension improves my experience with web-based tools. |

Optional open text (max 500 characters): "What one change would make this extension more useful to you?"

### Exit interview script (8 questions)

Conduct this 20-minute interview with 5–10 users at the end of the pilot (Days 46–50). Record audio with consent; transcribe into the pilot report's qualitative section.

1. "Walk me through a typical workday. At which points did you notice the extension helping — or getting in the way?"
2. "Were there features you actively sought out after the initial preset, or did you mostly use what was pre-configured?"
3. "The extension adapts automatically based on your behavior. Did you notice the adaptations? Did they feel accurate?"
4. "Were there moments where you felt the extension was slowing down your browser or interfering with a specific website?"
5. "The extension can activate domain-specific helpers for banking, healthcare, and other sites. Did you encounter any of these? Were they helpful?"
6. "If you could change one setting that is currently locked by your IT team, what would it be?"
7. "Did you trust the extension with the data it handles? Were you comfortable with the observatory opt-in?"
8. "On a scale of 1–10, how likely are you to continue using AccessBridge if it is offered to your full department?"

---

## 8. Small-Cohort (N < 20) Handling

The observatory applies a k-anonymity floor of 5 devices per statistical finding — any categorical value that appears on fewer than 5 devices is suppressed in the dashboard output. This is a privacy protection, not a bug.

A cohort of fewer than 20 enrolled users will have sparse dashboard data. Here is what to expect and what to do:

### What you will see with N < 20

- **Device count and feature-usage totals** appear normally — these are aggregate counts, not per-user values.
- **Top-N feature lists** may be suppressed if a feature is used on fewer than 5 devices. The suppressed entry is replaced with "(suppressed — fewer than 5 devices)".
- **Struggle score trend** may be noisy — the moving average across fewer than 10 devices produces high variance. Interpret directional trends, not precise values.
- **Feedback Likert averages** are shown when N ≥ 3 survey responses exist. With fewer than 3 responses, the chart is hidden.

### Why the observatory does not un-gate for small cohorts

The k-anonymity floor is architectural and deliberate. Lowering it for small cohorts would allow an observer with access to the dashboard to infer individual users' behavior by subtracting one cohort from another. The correct response to insufficient cohort size is to grow the cohort — not to weaken the privacy model.

If your pilot genuinely cannot exceed 20 users (e.g. a single team, a rare disability cohort), collect qualitative feedback via the exit interview script (§7) and the in-app feedback widget rather than relying on the observatory dashboard. File a GitHub Issue requesting a configurable k-anonymity floor for future research use cases — the implementation is in [`ops/observatory/server.js`](../../ops/observatory/server.js) in the `/api/pilot/*` endpoints.

### Minimum viable cohort for each observable metric

| Metric | Minimum devices |
|---|---|
| Total feature usage count | 1 |
| Feature usage top-N list (individual features visible) | 5 per feature |
| Struggle score trend (noisy but visible) | 3 |
| Struggle score trend (low noise, interpretable) | 20 |
| Feedback Likert averages | 3 survey responses |
| Domain connector activation rate | 5 per connector |

---

## 9. Escalation Matrix

Use this matrix to determine who to contact and what action to take based on severity.

| Severity | Definition | Who to page | SLA | Immediate action |
|---|---|---|---|---|
| P1 — Critical | Extension causing data loss, exposing credentials, or rendering the machine unusable | Pilot coordinator (immediate) + Manish Kumar (GitHub Issue tagged `[P1]`) | 4 hours | Trigger rollback on all affected machines immediately; do not wait for root-cause |
| P2 — High | Extension non-functional for > 20% of a wave; or Chrome crashes consistently after install | Pilot coordinator + IT admin | 24 hours | Pause that wave's enrollment; investigate on one machine before continuing |
| P3 — Medium | Specific feature broken; workaround exists (e.g. disable the feature in popup) | IT admin; pilot coordinator informed | 3 business days | Document the workaround in the support channel; continue pilot |
| P4 — Low | Cosmetic issue; typo in UI; feature behaves unexpectedly in one edge case | File GitHub Issue; pilot coordinator reviews at weekly summary | Next minor release | No immediate action |
| Observatory outage | Dashboard is unreachable or returning errors | IT admin checks VPS at `http://72.61.227.64:8300/api/version` | 24 hours | Pilot continues — observatory is opt-in and its outage does not affect extension function |
| Rollback decision | > 10% of users report P1/P2 in 48 hours, OR decision matrix (§6) yields Abort | Pilot coordinator unilaterally authorized to trigger | Immediate | Run `--uninstall` across all enrolled machines; post-mortem within 5 business days |

### Rollback command reference

```bash
# macOS / Linux — removes managed-policy JSON; Chrome removes extension on next restart
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --uninstall

# Windows PowerShell
iwr https://accessbridge.space/team/install.ps1 | iex -args '--uninstall'

# Verify the policy JSON was removed
ls /etc/opt/chrome/policies/managed/          # Linux
ls /Library/Managed\ Preferences/            # macOS
reg query "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"  # Windows
```

After rollback, users will see the extension removed on the next Chrome startup. No user data is lost — `chrome.storage.local` is not cleared by the uninstall process. If users wish to preserve their customized profile, they can export it from the extension popup before uninstalling.

---

*AccessBridge Pilot Playbook — maintained by Manish Kumar. For install documentation, see [docs/deployment/team.md](../deployment/team.md). For observatory privacy model, see [docs/features/compliance-observatory.md](../features/compliance-observatory.md).*
