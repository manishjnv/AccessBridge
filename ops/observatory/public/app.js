(function () {
  'use strict';

  // ---- Chart palette ----
  var PALETTE = [
    '#7b68ee', '#bb86fc', '#4fd1c5', '#f6ad55', '#fc8181',
    '#63b3ed', '#b794f4', '#9ae6b4', '#faf089', '#fbb6ce'
  ];

  // ---- Native script map ----
  var NATIVE_SCRIPTS = {
    hi:'हिन्दी', bn:'বাংলা', ta:'தமிழ்', te:'తెలుగు', mr:'मराठी',
    gu:'ગુજરાતી', kn:'ಕನ್ನಡ', ml:'മലയാളം', pa:'ਪੰਜਾਬੀ', ur:'اردو',
    as:'অসমীয়া', sa:'संस्कृतम्', ne:'नेपाली', or:'ଓଡ଼ିଆ', si:'සිංහල',
    en:'English', zh:'中文', es:'Español', fr:'Français', de:'Deutsch',
    ja:'日本語', ar:'العربية', ko:'한국어', ru:'Русский', pt:'Português',
    id:'Indonesia', tl:'Tagalog', th:'ไทย', tr:'Türkçe', fa:'فارسی'
  };

  // ---- Routing ----
  var ALL_TABS = ['overview', 'funnel', 'features', 'languages', 'domains', 'trends', 'compliance'];

  function currentTab() {
    var h = (location.hash || '#overview').slice(1);
    return ALL_TABS.indexOf(h) >= 0 ? h : 'overview';
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
    else if (name === 'funnel') loadFunnel();
    else if (name === 'features') loadFeatures('day');
    else if (name === 'languages') loadLanguages();
    else if (name === 'domains') loadDomains();
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

  // ---- Funnel ----
  async function loadFunnel() {
    var data = await fetchJson('./api/observatory/funnel?days=30');
    var svg = document.getElementById('chart-funnel');
    if (!svg) return;

    var stages = data && data.stages ? data.stages : [
      { label: 'Devices Enrolled',   key: 'devices_enrolled',   value: 0 },
      { label: 'Devices Active',      key: 'devices_active',     value: 0 },
      { label: 'Features Used',       key: 'features_used',      value: 0 },
      { label: 'Sustained 7d',        key: 'sustained_use_7d',   value: 0 },
      { label: 'Sustained 30d',       key: 'sustained_use_30d',  value: 0 }
    ];

    var W = 800, H = 360;
    var padL = 20, padR = 20, padT = 30, padB = 20;
    var plotW = W - padL - padR;
    var rowH = (H - padT - padB) / stages.length;
    var maxVal = Math.max.apply(null, stages.map(function(s) { return s.value || 0; }).concat([1]));

    var rects = stages.map(function(stage, i) {
      var val = stage.value || 0;
      var ratio = val / maxVal;
      var shrink = i * 0.06;
      var barW = Math.max(plotW * ratio * (1 - shrink * 0.5), 40);
      var barX = padL + (plotW - barW) / 2;
      var barY = padT + i * rowH + 4;
      var bH = rowH - 10;
      var prev = i === 0 ? null : (stages[i - 1].value || 0);
      var pct = (prev && prev > 0) ? Math.round(val / prev * 100) + '%' : (i === 0 ? '100%' : '—');
      return '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + bH + '"' +
        ' rx="8" fill="' + PALETTE[i % PALETTE.length] + '" opacity="' + (0.85 - i * 0.05) + '" />' +
        '<text x="' + (W / 2) + '" y="' + (barY + bH / 2 + 5) + '"' +
        ' text-anchor="middle" fill="#fff" font-size="13" font-weight="600" font-family="Inter,sans-serif">' +
        escapeHtml(stage.label) + ': ' + Math.round(val) + ' (' + pct + ')</text>';
    }).join('');

    svg.innerHTML = rects;
  }

  // ---- Features ----
  var _featureHidden = {};

  async function loadFeatures(bucket) {
    var data = await fetchJson('./api/observatory/feature-usage?days=30&bucket=' + (bucket || 'day'));
    var svg = document.getElementById('chart-features');
    var legend = document.getElementById('features-legend');
    if (!svg) return;

    var series = data && Array.isArray(data.series) ? data.series.slice(0, 10) : [];

    if (!series.length) {
      svg.innerHTML = '<text x="400" y="150" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="Inter,sans-serif">No data</text>';
      if (legend) legend.innerHTML = '';
      return;
    }

    var W = 800, H = 300, padL = 50, padR = 20, padT = 20, padB = 40;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    // collect all dates
    var allDates = [];
    series.forEach(function(s) {
      (s.points || []).forEach(function(p) {
        if (allDates.indexOf(p.date) < 0) allDates.push(p.date);
      });
    });
    allDates.sort();
    var n = allDates.length || 1;

    var maxY = 1;
    series.forEach(function(s) {
      (s.points || []).forEach(function(p) {
        if ((p.total || 0) > maxY) maxY = p.total;
      });
    });

    var stepX = plotW / Math.max(n - 1, 1);

    function xOf(dateStr) { return padL + allDates.indexOf(dateStr) * stepX; }
    function yOf(v) { return padT + plotH - (v / maxY) * plotH; }

    var grid = '';
    for (var p = 0; p <= 4; p++) {
      var gy = padT + plotH * (1 - p / 4);
      var gv = Math.round((maxY * p) / 4);
      grid += '<line class="grid" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" />';
      grid += '<text class="label" x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + gv + '</text>';
    }

    var xLabels = '';
    var picks = [0, Math.floor(n / 2), n - 1];
    picks.forEach(function(idx) {
      if (idx >= 0 && idx < allDates.length) {
        xLabels += '<text class="label" x="' + xOf(allDates[idx]) + '" y="' + (H - 8) + '" text-anchor="middle">' +
          escapeHtml(allDates[idx].slice(5)) + '</text>';
      }
    });

    var lines = '';
    series.forEach(function(s, i) {
      if (_featureHidden[s.feature]) return;
      var pts = (s.points || []).filter(function(p) { return allDates.indexOf(p.date) >= 0; });
      if (!pts.length) return;
      var d = pts.map(function(p, j) {
        return (j === 0 ? 'M' : 'L') + xOf(p.date).toFixed(1) + ',' + yOf(p.total || 0).toFixed(1);
      }).join(' ');
      lines += '<path d="' + d + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />';
    });

    svg.innerHTML = grid + xLabels + lines;

    if (legend) {
      legend.innerHTML = series.map(function(s, i) {
        var hidden = _featureHidden[s.feature];
        return '<button class="legend-chip' + (hidden ? ' hidden-chip' : '') + '" data-feature="' + escapeHtml(s.feature) + '" style="border-color:' + PALETTE[i % PALETTE.length] + '">' +
          '<span class="legend-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
          escapeHtml(s.feature) + '</button>';
      }).join('');
      legend.querySelectorAll('.legend-chip').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var f = btn.dataset.feature;
          _featureHidden[f] = !_featureHidden[f];
          loadFeatures(bucket || 'day');
        });
      });
    }
  }

  // ---- Languages ----
  async function loadLanguages() {
    var data = await fetchJson('./api/observatory/language-breakdown?days=30');
    var langs = (data && data.languages) ? data.languages : [];

    var tableWrap = document.getElementById('lang-table-wrap');
    if (tableWrap) {
      if (!langs.length) {
        tableWrap.innerHTML = '<div class="loading">No data yet</div>';
      } else {
        var total = langs.reduce(function(sum, l) { return sum + (l.devices || 0); }, 0) || 1;
        var rows = langs.map(function(l) {
          var pct = ((l.devices || 0) / total * 100).toFixed(1);
          var native = NATIVE_SCRIPTS[l.lang] || l.lang;
          return '<tr><td class="lang-code">' + escapeHtml(l.lang) + '</td>' +
            '<td class="lang-native">' + escapeHtml(native) + '</td>' +
            '<td class="lang-devices">' + Math.round(l.devices || 0) + '</td>' +
            '<td class="lang-pct">' + pct + '%</td></tr>';
        }).join('');
        tableWrap.innerHTML = '<table class="lang-table"><thead><tr>' +
          '<th>BCP-47</th><th>Native Script</th><th>Devices</th><th>% Total</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }

    // Script family bars
    var families = {};
    langs.forEach(function(l) {
      var family = scriptFamily(l.lang);
      families[family] = (families[family] || 0) + (l.devices || 0);
    });
    var familyRows = Object.keys(families).map(function(f) {
      return { label: f, value: families[f] };
    }).sort(function(a, b) { return b.value - a.value; });
    renderBars('script-family-bars', familyRows, 'devices');
  }

  function scriptFamily(lang) {
    var LATIN = ['en','es','fr','de','pt','id','tl','tr'];
    var CJK = ['zh','ja','ko'];
    var ARABIC = ['ar','ur','fa'];
    var INDIC = ['hi','bn','ta','te','mr','gu','kn','ml','pa','as','sa','ne','or','si'];
    var CYRILLIC = ['ru'];
    if (LATIN.indexOf(lang) >= 0) return 'Latin';
    if (CJK.indexOf(lang) >= 0) return 'CJK';
    if (ARABIC.indexOf(lang) >= 0) return 'Arabic / Perso-Arabic';
    if (INDIC.indexOf(lang) >= 0) return 'Indic';
    if (CYRILLIC.indexOf(lang) >= 0) return 'Cyrillic';
    if (lang === 'th') return 'Thai';
    return 'Other';
  }

  // ---- Domains ----
  var DOMAIN_RANKS = ['banking','insurance','healthcare','telecom','retail','manufacturing'];

  async function loadDomains() {
    var data = await fetchJson('./api/observatory/domain-penetration?days=30');
    var domains = (data && data.domains) ? data.domains : DOMAIN_RANKS.map(function(d) {
      return { domain: d, devices: 0, usage_score: 0 };
    });

    var el = document.getElementById('domain-bars');
    if (!el) return;
    if (!domains.length) { el.innerHTML = '<div class="loading">No data yet</div>'; return; }

    var max = Math.max.apply(null, domains.map(function(d) { return d.devices || 0; }).concat([1]));
    var sorted = domains.slice().sort(function(a, b) { return (b.devices || 0) - (a.devices || 0); });

    el.innerHTML = sorted.map(function(d, i) {
      var width = ((d.devices || 0) / max * 100).toFixed(1);
      var score = typeof d.usage_score === 'number' ? d.usage_score.toFixed(1) : '—';
      return '<div class="bar-row">' +
        '<div class="bar-label">' +
          '<span class="rank-badge">#' + (i + 1) + '</span>' + escapeHtml(d.domain) +
        '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + width + '%;background:' + PALETTE[i % PALETTE.length] + '"></div></div>' +
        '<div class="bar-value">' + Math.round(d.devices || 0) + ' · ' + score + '</div>' +
      '</div>';
    }).join('');
  }

  // ---- Compliance (extended tri-column) ----
  async function loadCompliance() {
    var results = await Promise.all([
      fetchJson('./api/observatory/compliance/rpwd'),
      fetchJson('./api/observatory/compliance/ada'),
      fetchJson('./api/observatory/compliance/eaa'),
    ]);

    var tri = document.getElementById('compliance-tri');
    if (tri) {
      var cols = ['RPWD', 'ADA', 'EAA'];
      var links = [
        'Rights of Persons with Disabilities Act (India)',
        'Americans with Disabilities Act (USA)',
        'European Accessibility Act (EU)'
      ];
      var summaries = [
        'Mandates accessible ICT products and services for persons with disabilities under Indian law.',
        'Prohibits discrimination in employment, public accommodations, and more across the US.',
        'EU directive harmonising accessibility requirements for products and services in Europe.'
      ];
      var CATS = ['Visual','Auditory','Motor','Cognitive'];
      tri.innerHTML = '<div class="compliance-tri-grid">' + cols.map(function(col, ci) {
        var d = results[ci];
        var categories = (d && d.categories) ? d.categories : CATS.map(function(c) {
          return { name: c, percent: 0 };
        });
        var overall = d && typeof d.overall === 'number' ? d.overall : 0;
        var catBars = categories.map(function(cat) {
          var pct = typeof cat.percent === 'number' ? cat.percent : 0;
          var dotClass = pct === 0 ? 'gap-dot red' : pct < 50 ? 'gap-dot yellow' : 'gap-dot green';
          return '<div class="tri-cat-row">' +
            '<span class="' + dotClass + '"></span>' +
            '<span class="tri-cat-name">' + escapeHtml(cat.name) + '</span>' +
            '<div class="bar-track" style="flex:1"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
            '<span class="tri-cat-pct">' + Math.round(pct) + '%</span>' +
          '</div>';
        }).join('');
        return '<div class="tri-col">' +
          '<h3 class="tri-col-title">' + escapeHtml(col) + '</h3>' +
          '<p class="tri-col-sub">' + escapeHtml(links[ci]) + '</p>' +
          '<p class="tri-col-summary">' + escapeHtml(summaries[ci]) + '</p>' +
          catBars +
          '<div class="tri-overall">Overall: <strong>' + Math.round(overall) + '%</strong></div>' +
        '</div>';
      }).join('') + '</div>';
    }

    // Legacy compliance cards
    var legacyData = await fetchJson('./api/compliance-report');
    var body = document.getElementById('compliance-body');
    if (!body) return;
    if (!legacyData) { body.innerHTML = ''; return; }

    var blocks = (legacyData.mappings || []).map(function (m) {
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
        '<strong>Disclaimer:</strong> ' + escapeHtml(legacyData.disclaimer || '') +
      '</div>' +
      blocks +
      '<div class="card" style="font-size: 12px; color: var(--muted);">' +
        'Generated at ' + escapeHtml(legacyData.generated_at || '') +
        ' — window ' + (legacyData.window_days || 30) + ' days.' +
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

  // ---- Bucket switcher (features tab) ----
  document.addEventListener('click', function(e) {
    var btn2 = e.target && e.target.closest ? e.target.closest('.bucket-btn') : null;
    if (!btn2) return;
    var switcher = document.getElementById('bucket-switcher');
    if (!switcher) return;
    switcher.querySelectorAll('.bucket-btn').forEach(function(b) { b.classList.remove('active'); });
    btn2.classList.add('active');
    loadFeatures(btn2.dataset.bucket || 'day');
  });

  // ---- Compliance Report download button ----
  var btnReport = document.getElementById('btn-compliance-report');
  if (btnReport) {
    btnReport.addEventListener('click', async function() {
      var data = await fetchJson('./api/compliance-report');
      if (!data) { alert('Failed to fetch compliance report.'); return; }
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'accessbridge-compliance-report.json';
      a.click();
      URL.revokeObjectURL(url);
      setTimeout(function() {
        document.body.classList.add('print-mode');
        window.print();
        setTimeout(function() { document.body.classList.remove('print-mode'); }, 500);
      }, 200);
    });
  }

  // ---- Boot ----
  switchTab(currentTab());
})();
