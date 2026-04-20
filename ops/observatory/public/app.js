(function () {
  'use strict';

  // ---- Routing ----
  function currentTab() {
    var h = (location.hash || '#overview').slice(1);
    return ['overview', 'trends', 'compliance'].indexOf(h) >= 0 ? h : 'overview';
  }

  function switchTab(name) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) {
      pages[i].hidden = pages[i].id !== 'page-' + name;
    }
    var tabs = document.querySelectorAll('.nav-tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.toggle('active', tabs[j].dataset.tab === name);
    }
    if (name === 'overview') loadOverview();
    else if (name === 'trends') loadTrends();
    else if (name === 'compliance') loadCompliance();
  }

  window.addEventListener('hashchange', function () { switchTab(currentTab()); });

  // ---- Fetch ----
  async function fetchJson(url) {
    try {
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.error('[observatory]', url, e);
      return null;
    }
  }

  // ---- Escaping ----
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ---- Overview ----
  async function loadOverview() {
    var data = await fetchJson('./api/summary?days=30');
    if (!data) { renderEmpty(); return; }
    renderKpis(data);

    function coerce(list, labelKey, valueKey) {
      return (list || []).map(function (r) { return { label: r[labelKey], value: r[valueKey] }; });
    }
    renderBars('top-langs', coerce(data.top_languages, 'lang', 'devices'), 'devices');
    renderBars('top-domains', coerce(data.top_domains, 'domain', 'devices'), 'devices');
    renderBars('top-adaptations', coerce(data.top_adaptations, 'type', 'count'), '');
    renderBars('top-features', coerce(data.top_features, 'feature', 'count'), '');
  }

  function renderKpis(d) {
    var grid = document.querySelector('.kpi-grid');
    if (!grid) return;
    grid.innerHTML =
      '<div class="kpi"><div class="kpi-value">' + (d.total_devices || 0) +
        '</div><div class="kpi-label">Contributing Devices (' + (d.window_days || 30) + 'd)</div></div>' +
      '<div class="kpi"><div class="kpi-value">' + Math.round(d.total_adaptations || 0) +
        '</div><div class="kpi-label">Adaptations Applied</div></div>' +
      '<div class="kpi"><div class="kpi-value">' + Math.round(d.total_struggle_events || 0) +
        '</div><div class="kpi-label">Struggle Events Triggered</div></div>' +
      '<div class="kpi"><div class="kpi-value">' + (d.window_days || 30) +
        'd</div><div class="kpi-label">Window</div></div>';
  }

  function renderBars(containerId, rows, unitLabel) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="loading">No data yet</div>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    el.innerHTML = rows.map(function (r) {
      var width = (r.value / max * 100).toFixed(1);
      return '<div class="bar-row">' +
        '<div class="bar-label">' + escapeHtml(r.label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div>' +
        '<div class="bar-value">' + Math.round(r.value) + (unitLabel ? ' ' + unitLabel : '') + '</div>' +
      '</div>';
    }).join('');
  }

  function renderEmpty() {
    var grid = document.querySelector('.kpi-grid');
    if (grid) grid.innerHTML = '<div class="loading">No data yet. Waiting for first submissions…</div>';
  }

  // ---- Trends ----
  async function loadTrends() {
    var days = 30;
    var results = await Promise.all([
      fetchJson('./api/trends?metric=struggle_events_triggered&days=' + days),
      fetchJson('./api/trends?metric=estimated_accessibility_score_improvement&days=' + days),
      fetchJson('./api/trends?metric=adaptations_applied:FONT_SCALE&days=' + days),
    ]);
    renderLineChart('chart-struggle', (results[0] && results[0].points) || []);
    renderLineChart('chart-score', (results[1] && results[1].points) || []);
    renderLineChart('chart-adaptations', (results[2] && results[2].points) || []);
  }

  function renderLineChart(svgId, points) {
    var svg = document.getElementById(svgId);
    if (!svg) return;
    if (!points.length) {
      svg.innerHTML = '<text x="400" y="120" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="Inter,sans-serif">No data</text>';
      return;
    }
    var W = 800, H = 240, padL = 50, padR = 20, padT = 20, padB = 40;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxY = Math.max.apply(null, points.map(function (p) { return Number(p.total) || 0; }).concat([1]));
    var n = points.length;
    var stepX = plotW / Math.max(n - 1, 1);

    function xy(i, v) {
      return [padL + i * stepX, padT + plotH - (v / maxY) * plotH];
    }

    var linePath = points.map(function (p, i) {
      var c = xy(i, Number(p.total) || 0);
      return (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1);
    }).join(' ');
    var areaPath = linePath +
      ' L' + (padL + (n - 1) * stepX).toFixed(1) + ',' + (padT + plotH).toFixed(1) +
      ' L' + padL.toFixed(1) + ',' + (padT + plotH).toFixed(1) + ' Z';

    var grid = '';
    for (var p = 0; p <= 4; p++) {
      var y = padT + plotH * (1 - p / 4);
      var val = Math.round((maxY * p) / 4 * 100) / 100;
      grid += '<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" />';
      grid += '<text class="label" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + val + '</text>';
    }

    var xLabels = '';
    var picks = [0, Math.floor(n / 2), n - 1];
    for (var pi = 0; pi < picks.length; pi++) {
      var idx = picks[pi];
      var x = padL + idx * stepX;
      var d = (points[idx] && points[idx].date) || '';
      xLabels += '<text class="label" x="' + x + '" y="' + (H - 12) + '" text-anchor="middle">' + escapeHtml(d.slice(5)) + '</text>';
    }

    var dots = points.map(function (pt, i) {
      var c = xy(i, Number(pt.total) || 0);
      return '<circle class="dot" cx="' + c[0].toFixed(1) + '" cy="' + c[1].toFixed(1) + '" r="3" />';
    }).join('');

    svg.innerHTML =
      '<defs>' +
        '<linearGradient id="grad-' + svgId + '" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#7b68ee" />' +
          '<stop offset="100%" stop-color="#bb86fc" />' +
        '</linearGradient>' +
        '<linearGradient id="fillgrad-' + svgId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#7b68ee" stop-opacity="0.6" />' +
          '<stop offset="100%" stop-color="#7b68ee" stop-opacity="0" />' +
        '</linearGradient>' +
      '</defs>' +
      grid + xLabels +
      '<path class="area" d="' + areaPath + '" fill="url(#fillgrad-' + svgId + ')" opacity="0.25" />' +
      '<path class="line" d="' + linePath + '" stroke="url(#grad-' + svgId + ')" />' +
      dots;
  }

  // ---- Compliance ----
  async function loadCompliance() {
    var data = await fetchJson('./api/compliance-report');
    var body = document.getElementById('compliance-body');
    if (!body) return;
    if (!data) { body.innerHTML = '<div class="loading">Failed to load report</div>'; return; }

    var blocks = (data.mappings || []).map(function (m) {
      var bullets = (m.accessbridge_evidence || []).map(function (e) {
        return '<li>' + escapeHtml(e) + '</li>';
      }).join('');
      return '<div class="compliance-card">' +
        '<h3>' + escapeHtml(m.regulation) + '</h3>' +
        '<p>' + escapeHtml(m.summary) + '</p>' +
        '<ul>' + bullets + '</ul>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="card" style="border-left: 4px solid var(--warning);">' +
        '<strong>Disclaimer:</strong> ' + escapeHtml(data.disclaimer || '') +
      '</div>' +
      blocks +
      '<div class="card" style="font-size: 12px; color: var(--muted);">' +
        'Generated at ' + escapeHtml(data.generated_at || '') +
        ' — window ' + (data.window_days || 30) + ' days.' +
      '</div>';
  }

  // ---- Print button ----
  var btn = document.getElementById('btn-print');
  if (btn) {
    btn.addEventListener('click', function () {
      document.body.classList.add('print-mode');
      window.print();
      setTimeout(function () { document.body.classList.remove('print-mode'); }, 500);
    });
  }

  // ---- Boot ----
  switchTab(currentTab());
})();
