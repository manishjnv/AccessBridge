/**
 * AccessBridge Pilot Dashboard — pilot.js
 *
 * Vanilla JS module. Wires on DOMContentLoaded.
 * Hash-router: #pilot-<id> → detail view; bare hash / empty → list view.
 * Polls /api/pilot/:id/status every 60 s. AbortController on route change.
 *
 * XSS: all user-data inserted via textContent / createElement, never innerHTML.
 * CORS: credentials: 'same-origin' throughout.
 */

'use strict';

(function () {

  /* ── Constants ─────────────────────────────────────────────────── */
  const API_BASE = '/api/pilot';
  const POLL_INTERVAL = 60_000; // 60 s

  /* ── STUB DATA (used when API is unreachable) ──────────────────── */
  const STUB_PILOTS = [
    {
      id: 1,
      name: 'Wipro Hyderabad Pilot',
      preset: 'pilot-default',
      enrolled: 142,
      target: 200,
      days_remaining: 18,
      status: { struggle_rate_trend: 'improving' }
    },
    {
      id: 2,
      name: 'Tamil Banking Cohort',
      preset: 'pilot-tamil',
      enrolled: 87,
      target: 150,
      days_remaining: 25,
      status: { struggle_rate_trend: 'stable' }
    },
    {
      id: 3,
      name: 'Dyslexia Study — Chennai',
      preset: 'pilot-dyslexia',
      enrolled: 14,
      target: 20,
      days_remaining: 7,
      status: 'gated'
    },
    {
      id: 4,
      name: 'Fatigue Research Cohort',
      preset: 'pilot-fatigue-study',
      enrolled: 63,
      target: 80,
      days_remaining: 30,
      status: { struggle_rate_trend: 'worsening' }
    }
  ];

  const STUB_DETAIL = {
    id: 1,
    name: 'Wipro Hyderabad Pilot',
    preset: 'pilot-default',
    enrolled: 142,
    target: 200,
    days_remaining: 18,
    burndown: [
      { date: '2026-03-25', devices: 12 },
      { date: '2026-03-26', devices: 18 },
      { date: '2026-03-27', devices: 27 },
      { date: '2026-03-28', devices: 34 },
      { date: '2026-03-29', devices: 48 },
      { date: '2026-03-30', devices: 61 },
      { date: '2026-03-31', devices: 75 },
      { date: '2026-04-01', devices: 89 },
      { date: '2026-04-02', devices: 104 },
      { date: '2026-04-03', devices: 115 },
      { date: '2026-04-04', devices: 126 },
      { date: '2026-04-05', devices: 133 },
      { date: '2026-04-06', devices: 142 }
    ],
    metrics: {
      install_rate:       { value: 84,   target: 80,  unit: '%'  },
      daily_active_users: { value: 72,   target: 70,  unit: '%'  },
      adaptations_per_day:{ value: 8.3,  target_min: 5, target_max: 15, unit: '/user/day' },
      override_rate:      { value: 15,   target: 20,  unit: '%', invert: true },
      voice_cmds_per_day: { value: 12,   target: 10,  unit: '/day' },
      indian_lang_usage:  { value: 54,   target: 50,  unit: '%'  }
    }
  };

  const STUB_FEEDBACK = {
    words: [
      { word: 'helpful', count: 87 },
      { word: 'faster', count: 74 },
      { word: 'font', count: 68 },
      { word: 'Tamil', count: 62 },
      { word: 'voice', count: 59 },
      { word: 'smooth', count: 54 },
      { word: 'easy', count: 49 },
      { word: 'adapt', count: 44 },
      { word: 'zoom', count: 38 },
      { word: 'contrast', count: 35 },
      { word: 'lag', count: 28 },
      { word: 'install', count: 24 },
      { word: 'language', count: 21 },
      { word: 'quick', count: 19 },
      { word: 'screen', count: 17 }
    ]
  };

  /* ── State ─────────────────────────────────────────────────────── */
  let currentAbortController = null;
  let pollTimer = null;

  /* ── Root element refs ─────────────────────────────────────────── */
  const $root = document.getElementById('pilot-root');
  const $listView = document.getElementById('view-list');
  const $detailView = document.getElementById('view-detail');

  /* ── Fetch helper ──────────────────────────────────────────────── */
  async function apiFetch(path, signal) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
    return res.json();
  }

  /* ── Abort & clear poll ────────────────────────────────────────── */
  function teardown() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ── Health colour from struggle_rate_trend ─────────────────────── */
  function trendToHealth(trend) {
    if (!trend) return 'amber';
    if (trend === 'improving') return 'green';
    if (trend === 'worsening') return 'red';
    return 'amber';
  }

  /* ── Metric status: green / amber / red ─────────────────────────── */
  function metricStatus(key, value) {
    const m = STUB_DETAIL.metrics[key];
    if (!m) return 'amber';
    if (key === 'adaptations_per_day') {
      if (value >= m.target_min && value <= m.target_max) return 'green';
      return value < m.target_min ? 'amber' : 'red';
    }
    if (m.invert) return value <= m.target ? 'green' : (value <= m.target * 1.25 ? 'amber' : 'red');
    return value >= m.target ? 'green' : (value >= m.target * 0.85 ? 'amber' : 'red');
  }

  /* ── Status icon ─────────────────────────────────────────────────── */
  function statusIcon(s) {
    if (s === 'green') return '✓';
    if (s === 'red')   return '✕';
    return '~';
  }

  /* ── SVG progress ring ───────────────────────────────────────────── */
  function buildProgressRing(enrolled, target) {
    const R = 34;
    const C = 2 * Math.PI * R;
    const pct = Math.min(1, enrolled / target);
    const offset = C * (1 - pct);
    const colour = pct >= 0.8 ? 'var(--success)' : pct >= 0.5 ? 'var(--warning)' : 'var(--danger)';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'progress-ring-svg');
    svg.setAttribute('width', '80');
    svg.setAttribute('height', '80');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.setAttribute('aria-label', `${enrolled} of ${target} enrolled`);
    svg.setAttribute('role', 'img');

    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'progress-ring-track');
    track.setAttribute('cx', '40');
    track.setAttribute('cy', '40');
    track.setAttribute('r', String(R));

    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fill.setAttribute('class', 'progress-ring-fill');
    fill.setAttribute('cx', '40');
    fill.setAttribute('cy', '40');
    fill.setAttribute('r', String(R));
    fill.setAttribute('stroke', colour);
    fill.style.strokeDasharray = String(C);
    fill.style.strokeDashoffset = String(offset);
    fill.style.transform = 'rotate(-90deg)';
    fill.style.transformOrigin = 'center';

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '40');
    label.setAttribute('y', '44');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '16');
    label.setAttribute('font-weight', '800');
    label.setAttribute('fill', 'currentColor');
    label.textContent = Math.round(pct * 100) + '%';

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(label);
    return svg;
  }

  /* ── Mini sparkline (metric tile) ───────────────────────────────── */
  function buildSparkline(dataPoints, targetLine, colour) {
    const W = 280, H = 40;
    const minV = Math.min(...dataPoints, targetLine * 0.8);
    const maxV = Math.max(...dataPoints, targetLine * 1.1);
    const scaleX = i => (i / (dataPoints.length - 1)) * W;
    const scaleY = v => H - ((v - minV) / (maxV - minV || 1)) * H;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'metric-mini-chart-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-hidden', 'true');

    // target dashed line
    const ty = scaleY(targetLine);
    const tLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tLine.setAttribute('x1', '0'); tLine.setAttribute('y1', String(ty));
    tLine.setAttribute('x2', String(W)); tLine.setAttribute('y2', String(ty));
    tLine.setAttribute('stroke', 'rgba(123,104,238,0.4)');
    tLine.setAttribute('stroke-width', '1.5');
    tLine.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(tLine);

    // data polyline
    const pts = dataPoints.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ');
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', pts);
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', colour);
    pl.setAttribute('stroke-width', '2');
    pl.setAttribute('stroke-linecap', 'round');
    pl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pl);

    return svg;
  }

  /* ── Burndown line chart ─────────────────────────────────────────── */
  function buildBurndownChart(burndown, target) {
    const W = 760, H = 200;
    const values = burndown.map(d => d.devices);
    const maxV = Math.max(target, ...values) * 1.05;
    const scaleX = i => 40 + (i / (burndown.length - 1)) * (W - 60);
    const scaleY = v => H - 20 - ((v / maxV) * (H - 40));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'burndown-chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Enrollment burndown chart showing devices enrolled per day');

    // Grid lines
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
      const y = scaleY(maxV * f);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      g.setAttribute('x1', '40'); g.setAttribute('y1', String(y));
      g.setAttribute('x2', String(W - 20)); g.setAttribute('y2', String(y));
      g.setAttribute('stroke', 'rgba(255,255,255,0.06)');
      g.setAttribute('stroke-width', '1');
      svg.appendChild(g);

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', '36'); t.setAttribute('y', String(y + 4));
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('font-size', '10');
      t.setAttribute('fill', 'rgba(148,163,184,0.6)');
      t.textContent = Math.round(maxV * f);
      svg.appendChild(t);
    });

    // Target line
    const ty = scaleY(target);
    const tl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tl.setAttribute('x1', '40'); tl.setAttribute('y1', String(ty));
    tl.setAttribute('x2', String(W - 20)); tl.setAttribute('y2', String(ty));
    tl.setAttribute('stroke', 'rgba(123,104,238,0.5)');
    tl.setAttribute('stroke-width', '1.5');
    tl.setAttribute('stroke-dasharray', '6 4');
    svg.appendChild(tl);

    // Target label
    const tlbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tlbl.setAttribute('x', String(W - 16)); tlbl.setAttribute('y', String(ty - 4));
    tlbl.setAttribute('text-anchor', 'end'); tlbl.setAttribute('font-size', '10');
    tlbl.setAttribute('fill', 'rgba(187,134,252,0.8)'); tlbl.textContent = 'Target ' + target;
    svg.appendChild(tlbl);

    // Enrollment line
    const pts = values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ');

    // Area fill
    const areaPath = `M${scaleX(0)},${scaleY(0)} ` +
      values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ') +
      ` L${scaleX(values.length - 1)},${scaleY(0)} Z`;
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'url(#burndown-gradient)');
    area.setAttribute('opacity', '0.25');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', 'burndown-gradient');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s1.setAttribute('offset', '0'); s1.setAttribute('stop-color', '#7b68ee');
    const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s2.setAttribute('offset', '1'); s2.setAttribute('stop-color', '#7b68ee');
    s2.setAttribute('stop-opacity', '0');
    grad.appendChild(s1); grad.appendChild(s2);
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(area);

    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', pts);
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', 'url(#burndown-stroke)');
    pl.setAttribute('stroke-width', '2.5');
    pl.setAttribute('stroke-linecap', 'round');
    pl.setAttribute('stroke-linejoin', 'round');
    pl.setAttribute('stroke', '#7b68ee');
    svg.appendChild(pl);

    // X-axis labels (first and last)
    if (burndown.length > 0) {
      const addXLabel = (i) => {
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', String(scaleX(i)));
        lbl.setAttribute('y', String(H - 4));
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('font-size', '10');
        lbl.setAttribute('fill', 'rgba(148,163,184,0.6)');
        lbl.textContent = burndown[i].date.slice(5); // MM-DD
        svg.appendChild(lbl);
      };
      addXLabel(0);
      addXLabel(Math.floor(burndown.length / 2));
      addXLabel(burndown.length - 1);
    }

    return svg;
  }

  /* ── Word cloud ─────────────────────────────────────────────────── */
  function buildWordCloud(words) {
    const cloud = document.createElement('div');
    cloud.className = 'word-cloud';
    cloud.setAttribute('aria-label', 'Feedback word frequency cloud');

    const maxCount = Math.max(...words.map(w => w.count));
    words.forEach(({ word, count }) => {
      const span = document.createElement('span');
      span.className = 'word-cloud-item';
      // font-size 12 → 32 px scaled by frequency
      const size = 12 + Math.round((count / maxCount) * 20);
      span.style.fontSize = size + 'px';
      span.style.fontWeight = size > 22 ? '800' : size > 16 ? '700' : '600';
      span.style.opacity = String(0.55 + (count / maxCount) * 0.45);
      span.textContent = word; // XSS-safe
      span.setAttribute('title', `${word}: ${count} mentions`);
      span.setAttribute('aria-label', `${word}, ${count} mentions`);
      cloud.appendChild(span);
    });

    return cloud;
  }

  /* ── Build pilot list card ─────────────────────────────────────── */
  function buildPilotCard(pilot) {
    const card = document.createElement('button');
    card.className = 'pilot-card';
    card.setAttribute('type', 'button');
    card.setAttribute('aria-label', `Open pilot: ${pilot.name}`);

    // Header row
    const header = document.createElement('div');
    header.className = 'pilot-card-header';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pilot-card-name';
    name.textContent = pilot.name;
    const preset = document.createElement('div');
    preset.className = 'pilot-card-preset';
    preset.textContent = pilot.preset;
    info.appendChild(name);
    info.appendChild(preset);

    const healthWrap = document.createElement('div');
    healthWrap.className = 'health-indicator';

    if (pilot.status === 'gated') {
      const dot = document.createElement('span');
      dot.className = 'health-dot amber';
      dot.setAttribute('aria-hidden', 'true');
      const lbl = document.createElement('span');
      lbl.textContent = 'Gated';
      healthWrap.appendChild(dot);
      healthWrap.appendChild(lbl);
    } else {
      const trend = pilot.status && pilot.status.struggle_rate_trend;
      const colour = trendToHealth(trend);
      const dot = document.createElement('span');
      dot.className = `health-dot ${colour}`;
      dot.setAttribute('aria-hidden', 'true');
      const lbl = document.createElement('span');
      lbl.textContent = colour === 'green' ? 'Healthy' : colour === 'amber' ? 'Stable' : 'At risk';
      healthWrap.appendChild(dot);
      healthWrap.appendChild(lbl);
    }

    header.appendChild(info);
    header.appendChild(healthWrap);
    card.appendChild(header);

    // Gated disclosure floor
    if (pilot.status === 'gated') {
      const banner = document.createElement('div');
      banner.className = 'gated-banner';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('width', '16'); icon.setAttribute('height', '16');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2.5');
      icon.setAttribute('aria-hidden', 'true');
      const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p1.setAttribute('d', 'M12 9v4M12 17h.01');
      const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p2.setAttribute('d', 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z');
      icon.appendChild(p1); icon.appendChild(p2);
      const msg = document.createElement('span');
      msg.textContent = `Enrollment below N=20 disclosure floor — aggregate metrics hidden (${pilot.enrolled}/${pilot.target} enrolled)`;
      banner.appendChild(icon);
      banner.appendChild(msg);
      card.appendChild(banner);
    } else {
      // Progress ring
      const ringWrap = document.createElement('div');
      ringWrap.className = 'progress-ring-wrap';
      ringWrap.appendChild(buildProgressRing(pilot.enrolled, pilot.target));

      const ringInfo = document.createElement('div');
      const ringVal = document.createElement('div');
      ringVal.className = 'progress-ring-value';
      ringVal.textContent = `${pilot.enrolled} / ${pilot.target}`;
      const ringLbl = document.createElement('div');
      ringLbl.className = 'progress-ring-label';
      ringLbl.textContent = 'Enrolled / Target';
      ringInfo.appendChild(ringVal);
      ringInfo.appendChild(ringLbl);
      ringWrap.appendChild(ringInfo);
      card.appendChild(ringWrap);
    }

    // Days remaining
    const days = document.createElement('div');
    days.className = 'days-remaining';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '13'); svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5'); svg.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '3'); rect.setAttribute('y', '4');
    rect.setAttribute('width', '18'); rect.setAttribute('height', '18');
    rect.setAttribute('rx', '2'); rect.setAttribute('ry', '2');
    const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l1.setAttribute('x1', '16'); l1.setAttribute('y1', '2'); l1.setAttribute('x2', '16'); l1.setAttribute('y2', '6');
    const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l2.setAttribute('x1', '8'); l2.setAttribute('y1', '2'); l2.setAttribute('x2', '8'); l2.setAttribute('y2', '6');
    const l3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l3.setAttribute('x1', '3'); l3.setAttribute('y1', '10'); l3.setAttribute('x2', '21'); l3.setAttribute('y2', '10');
    svg.appendChild(rect); svg.appendChild(l1); svg.appendChild(l2); svg.appendChild(l3);
    days.appendChild(svg);
    const daysText = document.createElement('span');
    daysText.innerHTML = ''; // safe: we set via textContent pieces
    const strong = document.createElement('strong');
    strong.textContent = String(pilot.days_remaining);
    daysText.appendChild(strong);
    const daysLabel = document.createTextNode(' days remaining');
    daysText.appendChild(daysLabel);
    days.appendChild(daysText);
    card.appendChild(days);

    card.addEventListener('click', () => {
      location.hash = `#pilot-${pilot.id}`;
    });

    return card;
  }

  /* ── Build metric tile ──────────────────────────────────────────── */
  function buildMetricTile(key, metric, statusOverride) {
    const NAMES = {
      install_rate: 'Install Rate',
      daily_active_users: 'Daily Active Users',
      adaptations_per_day: 'Adaptations / User / Day',
      override_rate: 'Override Rate',
      voice_cmds_per_day: 'Voice Commands / Day',
      indian_lang_usage: 'Indian Language Usage'
    };
    const TARGETS = {
      install_rate: '> 80%',
      daily_active_users: '> 70%',
      adaptations_per_day: '5 – 15 /user/day',
      override_rate: '< 20%',
      voice_cmds_per_day: '> 10 /day',
      indian_lang_usage: '> 50%'
    };

    const status = statusOverride || metricStatus(key, metric.value);
    const statusColour = status === 'green' ? 'var(--success)' : status === 'amber' ? 'var(--warning)' : 'var(--danger)';

    const tile = document.createElement('div');
    tile.className = `metric-tile status-${status}`;

    const hdr = document.createElement('div');
    hdr.className = 'metric-tile-header';
    const tileName = document.createElement('div');
    tileName.className = 'metric-tile-name';
    tileName.textContent = NAMES[key] || key;
    const tileIcon = document.createElement('div');
    tileIcon.className = 'metric-tile-status-icon';
    tileIcon.setAttribute('aria-label', `Status: ${status}`);
    tileIcon.textContent = statusIcon(status);
    hdr.appendChild(tileName);
    hdr.appendChild(tileIcon);

    const val = document.createElement('div');
    val.className = `metric-tile-value status-${status}`;
    val.textContent = metric.value + (metric.unit || '');

    const tgt = document.createElement('div');
    tgt.className = 'metric-tile-target';
    tgt.textContent = 'Target: ' + (TARGETS[key] || '—');

    tile.appendChild(hdr);
    tile.appendChild(val);
    tile.appendChild(tgt);

    // Stub sparkline — flat trend with slight noise
    const basePoints = Array.from({ length: 10 }, (_, i) =>
      metric.value * (0.92 + Math.sin(i * 0.6) * 0.05 + Math.random() * 0.06)
    );
    const targetForSpark = metric.target || metric.target_max || metric.value;
    const sparkWrap = document.createElement('div');
    sparkWrap.className = 'metric-mini-chart';
    sparkWrap.appendChild(buildSparkline(basePoints, targetForSpark, statusColour));
    tile.appendChild(sparkWrap);

    return tile;
  }

  /* ── Render list view ─────────────────────────────────────────── */
  async function renderList() {
    teardown();

    $listView.hidden = false;
    $detailView.hidden = true;
    document.title = 'Pilot Dashboard · AccessBridge';

    const grid = $listView.querySelector('.pilot-grid');
    const loading = $listView.querySelector('.loading-spinner');
    const errorEl = $listView.querySelector('.pilot-list-error');

    if (loading) loading.hidden = false;
    if (grid) grid.textContent = '';
    if (errorEl) errorEl.hidden = true;

    const ac = new AbortController();
    currentAbortController = ac;

    let pilots;
    try {
      pilots = await apiFetch(API_BASE + '/', ac.signal);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Graceful fallback to stub data
      console.warn('[pilot] API unreachable, using stub data:', err.message);
      pilots = STUB_PILOTS;
    }

    if (loading) loading.hidden = true;

    if (!pilots || pilots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('width', '64'); icon.setAttribute('height', '64');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.5');
      icon.setAttribute('aria-hidden', 'true');
      const ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ci.setAttribute('cx', '12'); ci.setAttribute('cy', '12'); ci.setAttribute('r', '10');
      const lk = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      lk.setAttribute('x1', '12'); lk.setAttribute('y1', '8'); lk.setAttribute('x2', '12'); lk.setAttribute('y2', '12');
      const lk2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      lk2.setAttribute('x1', '12'); lk2.setAttribute('y1', '16'); lk2.setAttribute('x2', '12.01'); lk2.setAttribute('y2', '16');
      icon.appendChild(ci); icon.appendChild(lk); icon.appendChild(lk2);
      const eh = document.createElement('h3');
      eh.textContent = 'No pilots yet';
      const ep = document.createElement('p');
      ep.textContent = 'Create a pilot enrollment via the admin API to see data here.';
      empty.appendChild(icon);
      empty.appendChild(eh);
      empty.appendChild(ep);
      if (grid) grid.appendChild(empty);
      return;
    }

    if (grid) {
      pilots.forEach(p => grid.appendChild(buildPilotCard(p)));
    }
  }

  /* ── Render detail view ───────────────────────────────────────── */
  async function renderDetail(id) {
    teardown();

    $listView.hidden = true;
    $detailView.hidden = false;
    $detailView.textContent = '';
    document.title = `Pilot #${id} · AccessBridge`;

    // Loading spinner
    const loadDiv = document.createElement('div');
    loadDiv.className = 'loading-spinner';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const loadText = document.createElement('span');
    loadText.textContent = 'Loading pilot data…';
    loadDiv.appendChild(spinner);
    loadDiv.appendChild(loadText);
    $detailView.appendChild(loadDiv);

    const ac = new AbortController();
    currentAbortController = ac;

    let pilot, feedback, statusData;
    try {
      [pilot, feedback, statusData] = await Promise.all([
        apiFetch(`${API_BASE}/${id}`, ac.signal),
        apiFetch(`${API_BASE}/${id}/feedback/aggregate`, ac.signal).catch(() => STUB_FEEDBACK),
        apiFetch(`${API_BASE}/${id}/status`, ac.signal).catch(() => null)
      ]);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[pilot] Detail API unreachable, using stub data:', err.message);
      pilot = { ...STUB_DETAIL, id };
      feedback = STUB_FEEDBACK;
      statusData = null;
    }

    $detailView.textContent = '';

    // ── Header ──────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'detail-header no-print';

    const backBtn = document.createElement('a');
    backBtn.className = 'btn-back';
    backBtn.setAttribute('href', '#');
    backBtn.setAttribute('aria-label', 'Back to pilot list');
    backBtn.innerHTML = ''; // build safely
    const bkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bkSvg.setAttribute('width', '16'); bkSvg.setAttribute('height', '16');
    bkSvg.setAttribute('viewBox', '0 0 24 24'); bkSvg.setAttribute('fill', 'none');
    bkSvg.setAttribute('stroke', 'currentColor'); bkSvg.setAttribute('stroke-width', '2.5');
    bkSvg.setAttribute('aria-hidden', 'true');
    const bkP = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bkP.setAttribute('d', 'M19 12H5M12 5l-7 7 7 7');
    bkSvg.appendChild(bkP);
    backBtn.appendChild(bkSvg);
    backBtn.appendChild(document.createTextNode(' All Pilots'));
    backBtn.addEventListener('click', e => {
      e.preventDefault();
      history.pushState(null, '', location.pathname);
      route();
    });

    const titleBlock = document.createElement('div');
    const dtitle = document.createElement('div');
    dtitle.className = 'detail-title';
    dtitle.textContent = pilot.name || `Pilot #${id}`;
    const dmeta = document.createElement('div');
    dmeta.className = 'detail-meta';
    const presetSpan = document.createElement('span');
    presetSpan.className = 'pill';
    presetSpan.textContent = pilot.preset || 'default';
    dmeta.appendChild(presetSpan);
    titleBlock.appendChild(dtitle);
    titleBlock.appendChild(dmeta);

    const actions = document.createElement('div');
    actions.className = 'detail-header-actions';

    const exportCsv = document.createElement('a');
    exportCsv.className = 'btn-primary';
    exportCsv.href = `${API_BASE}/${id}/export.csv`;
    exportCsv.textContent = 'Export CSV';
    exportCsv.setAttribute('download', `pilot-${id}.csv`);

    const exportPdf = document.createElement('button');
    exportPdf.className = 'btn-primary';
    exportPdf.textContent = 'Export PDF';
    exportPdf.setAttribute('type', 'button');
    exportPdf.addEventListener('click', () => {
      apiFetch(`${API_BASE}/${id}/results`, new AbortController().signal)
        .catch(() => null)
        .finally(() => window.print());
    });

    actions.appendChild(exportCsv);
    actions.appendChild(exportPdf);

    header.appendChild(backBtn);
    header.appendChild(titleBlock);
    header.appendChild(actions);
    $detailView.appendChild(header);

    // ── Burndown chart ──────────────────────────────────────────────
    const burnCard = document.createElement('div');
    burnCard.className = 'card';
    const burnH = document.createElement('h2');
    burnH.className = 'section-heading';
    burnH.textContent = 'Enrollment Burndown (devices / day)';
    burnCard.appendChild(burnH);
    burnCard.appendChild(buildBurndownChart(pilot.burndown || STUB_DETAIL.burndown, pilot.target || 200));
    $detailView.appendChild(burnCard);

    // ── Metric tiles ────────────────────────────────────────────────
    const metCard = document.createElement('div');
    metCard.className = 'card';
    const metH = document.createElement('h2');
    metH.className = 'section-heading';
    metH.textContent = 'Pilot KPIs';
    metCard.appendChild(metH);

    const metGrid = document.createElement('div');
    metGrid.className = 'metric-grid';

    const metricsData = pilot.metrics || STUB_DETAIL.metrics;

    // Compute status from API statusData if available
    const statusMap = {};
    if (statusData && statusData.metrics) {
      Object.entries(statusData.metrics).forEach(([k, v]) => {
        statusMap[k] = v.status; // 'green'|'amber'|'red'
      });
    }

    Object.entries(metricsData).forEach(([key, metric]) => {
      metGrid.appendChild(buildMetricTile(key, metric, statusMap[key]));
    });

    metCard.appendChild(metGrid);
    $detailView.appendChild(metCard);

    // ── Satisfaction score ──────────────────────────────────────────
    const satCard = document.createElement('div');
    satCard.className = 'card';
    const satH = document.createElement('h2');
    satH.className = 'section-heading';
    satH.textContent = 'Satisfaction Score (manual entry)';

    const satNote = document.createElement('p');
    satNote.className = 'satisfaction-note';
    satNote.textContent = 'Score stored locally — will sync to API in Phase 3.';

    const satForm = document.createElement('div');
    satForm.className = 'satisfaction-form';

    const satInput = document.createElement('input');
    satInput.type = 'number';
    satInput.min = '1'; satInput.max = '10'; satInput.step = '0.1';
    satInput.className = 'satisfaction-input';
    satInput.placeholder = '—';
    satInput.setAttribute('aria-label', 'Satisfaction score out of 10');
    const lsKey = `pilot-sat-${id}`;
    const saved = localStorage.getItem(lsKey);
    if (saved) satInput.value = saved;

    const satSaved = document.createElement('span');
    satSaved.className = 'satisfaction-saved';
    satSaved.hidden = true;
    satSaved.textContent = '✓ Saved locally';
    satSaved.setAttribute('aria-live', 'polite');

    const satScaleLabel = document.createElement('span');
    satScaleLabel.className = 'satisfaction-note';
    satScaleLabel.textContent = 'Scale 1–10';

    satInput.addEventListener('change', () => {
      const v = parseFloat(satInput.value);
      if (!isNaN(v) && v >= 1 && v <= 10) {
        localStorage.setItem(lsKey, String(v));
        satSaved.hidden = false;
        setTimeout(() => { satSaved.hidden = true; }, 2000);
      }
    });

    satForm.appendChild(satInput);
    satForm.appendChild(satScaleLabel);
    satForm.appendChild(satSaved);
    satCard.appendChild(satH);
    satCard.appendChild(satNote);
    satCard.appendChild(satForm);
    $detailView.appendChild(satCard);

    // ── Word cloud ──────────────────────────────────────────────────
    const cloudCard = document.createElement('div');
    cloudCard.className = 'card';
    const cloudH = document.createElement('h2');
    cloudH.className = 'section-heading';
    cloudH.textContent = 'Feedback Word Cloud';
    const cloudNote = document.createElement('p');
    cloudNote.style.fontSize = '12px';
    cloudNote.style.color = 'var(--muted)';
    cloudNote.style.marginBottom = '16px';
    cloudNote.textContent = 'Top 30 words from participant feedback, sized by frequency.';
    cloudCard.appendChild(cloudH);
    cloudCard.appendChild(cloudNote);
    cloudCard.appendChild(buildWordCloud((feedback.words || []).slice(0, 30)));
    $detailView.appendChild(cloudCard);

    // ── Status poll ─────────────────────────────────────────────────
    function pollStatus() {
      const pollAC = new AbortController();
      apiFetch(`${API_BASE}/${id}/status`, pollAC.signal).then(data => {
        if (!data) return;
        // Update health dot in nav/header if present
        const liveRegion = document.getElementById('pilot-live-region');
        if (liveRegion) liveRegion.textContent = 'Status refreshed';
      }).catch(() => { /* silent */ });
    }

    pollTimer = setInterval(pollStatus, POLL_INTERVAL);
  }

  /* ── Router ─────────────────────────────────────────────────────── */
  function route() {
    const hash = location.hash || '';
    const m = hash.match(/^#pilot-(\d+)$/);
    if (m) {
      renderDetail(parseInt(m[1], 10));
    } else {
      renderList();
    }
  }

  /* ── Init ────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('hashchange', route);
    route();
  });

})();
