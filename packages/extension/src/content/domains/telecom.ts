/**
 * AccessBridge — Telecom Domain Connector v0
 *
 * Detects telecom / mobile operator websites and provides accessibility adaptations:
 *   - Jargon decoder (tooltips for telecom terms)
 *   - Plan comparator (simplified price-per-GB / price-per-day badges)
 *   - Recharge form assistance (mobile number validation, hints)
 *   - Data usage reader (human-readable equivalents)
 *   - FUP / validity alerts (countdown badges for expiry dates)
 */

import type { DomainConnector } from './index.js';
import { detectBillShockLanguage } from './deepenings.js';

// ---------------------------------------------------------------------------
// Telecom jargon glossary
// ---------------------------------------------------------------------------

const TELECOM_JARGON: Record<string, string> = {
  'VoLTE': 'Voice over LTE — allows voice calls over a 4G LTE network for better quality and faster call setup.',
  '5G': 'Fifth-generation mobile network — offers much faster speeds, lower latency, and more capacity than 4G.',
  'SIM': 'Subscriber Identity Module — a small card that identifies your mobile account on the network.',
  'eSIM': 'Embedded SIM — a digital SIM built into your phone that can be activated without a physical card.',
  'IMEI': 'International Mobile Equipment Identity — a unique 15-digit number identifying your phone hardware.',
  'MNP': 'Mobile Number Portability — lets you switch your mobile operator while keeping the same phone number.',
  'TRAI': 'Telecom Regulatory Authority of India — the government body that regulates telecom services in India.',
  'DND': 'Do Not Disturb — a service that blocks unwanted promotional calls and messages.',
  'ISD': 'International Subscriber Dialling — used for making phone calls to numbers in other countries.',
  'STD': 'Subscriber Trunk Dialling — used for making long-distance calls within India.',
  'Roaming': 'Using your mobile service outside your home network area, often with additional charges.',
  'FUP': 'Fair Usage Policy — a limit after which your internet speed is reduced for the rest of the billing cycle.',
  'APN': 'Access Point Name — a gateway setting that connects your phone to the mobile internet.',
  'OTT': 'Over The Top — content or services (like streaming apps) delivered over the internet instead of traditional channels.',
  'MVNO': 'Mobile Virtual Network Operator — a carrier that does not own network infrastructure but resells another operator\'s service.',
  'Bandwidth': 'The maximum data transfer rate of a network connection, usually measured in Mbps or Gbps.',
  'Latency': 'The time delay between sending and receiving data over a network, measured in milliseconds.',
  'Data Cap': 'A limit set by your operator on the total amount of data you can use in a billing period.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for telecom site detection
// ---------------------------------------------------------------------------

const TELECOM_HOSTNAMES = [
  'jio.com', 'reliancejio',
  'airtel.in', 'airtel.com', 'myairtel',
  'vi.com', 'vodafone', 'idea',
  'bsnl.co.in', 'mtnl.in',
  'tatasky', 'dishtv',
  'hathway', 'actcorp',
  'excitel', 'spectranet',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Convert bytes / MB / GB to a human-readable equivalent. */
function dataToHumanReadable(megabytes: number): string {
  if (megabytes <= 0) return '';

  const equivalents: string[] = [];

  // Songs (approx 5 MB each)
  if (megabytes >= 5) {
    const songs = Math.floor(megabytes / 5);
    equivalents.push(`About ${songs.toLocaleString('en-IN')} songs`);
  }

  // Hours of HD video (approx 1500 MB per hour)
  if (megabytes >= 1500) {
    const hours = (megabytes / 1500).toFixed(1);
    equivalents.push(`About ${hours} hours of HD video`);
  }

  // Hours of SD video (approx 700 MB per hour)
  if (megabytes >= 700 && megabytes < 1500) {
    const hours = (megabytes / 700).toFixed(1);
    equivalents.push(`About ${hours} hours of SD video`);
  }

  // Web pages (approx 2 MB each)
  if (megabytes >= 2) {
    const pages = Math.floor(megabytes / 2);
    equivalents.push(`About ${pages.toLocaleString('en-IN')} web pages`);
  }

  return equivalents.slice(0, 2).join(' or ');
}

/** Parse data values like "1.5 GB", "500 MB", "2GB/day" and return megabytes. */
function parseDataValue(text: string): number | null {
  const match = text.match(/([\d,.]+)\s*(GB|MB|TB)/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(value)) return null;
  const unit = match[2].toUpperCase();
  if (unit === 'TB') return value * 1024 * 1024;
  if (unit === 'GB') return value * 1024;
  return value; // MB
}

/** Parse a price string like "₹299", "Rs. 599", "₹ 1,499" to a number. */
function parsePrice(text: string): number | null {
  const match = text.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const cleaned = match[1].replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/** Parse validity strings like "28 days", "84 days", "365 days" and return days. */
function parseValidity(text: string): number | null {
  const match = text.match(/(\d+)\s*days?/i);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return isNaN(days) ? null : days;
}

/** Calculate days remaining from a date string. */
function daysUntil(dateStr: string): number | null {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// TelecomConnector
// ---------------------------------------------------------------------------

export class TelecomConnector implements DomainConnector {
  readonly id = 'telecom';
  readonly label = 'Telecom';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    // Hostname check
    if (TELECOM_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic: telecom-specific form fields
    const formSignals = document.querySelectorAll(
      'input[name*="mobile"], input[name*="phone"], input[name*="recharge"], ' +
      'input[name*="operator"], input[placeholder*="Mobile"], input[placeholder*="mobile number"], ' +
      'input[placeholder*="Recharge"], [data-field*="mobile"], [data-field*="recharge"], ' +
      'select[name*="operator"], select[name*="circle"]',
    );
    if (formSignals.length >= 2) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const telecomKeywords = ['recharge', 'prepaid', 'postpaid', 'mobile number', 'data pack', 'validity', 'talktime', 'unlimited calls'];
    const matchCount = telecomKeywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Telecom domain connector activated');

    this.scanAndEnhance();

    // Watch for dynamic content
    this.observer = new MutationObserver(() => {
      this.scanAndEnhance();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;

    // Remove all injected elements
    for (const el of this.tooltipElements) el.remove();
    this.tooltipElements = [];
    for (const el of this.overlayElements) el.remove();
    this.overlayElements = [];
    for (const { el, type, fn } of this.formListeners) {
      el.removeEventListener(type, fn);
    }
    this.formListeners = [];

    console.log('[AccessBridge] Telecom domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.enhancePlanTables();
    this.enhanceRechargeForms();
    this.addDataUsageReaders();
    this.addFupValidityAlerts();
    // --- Priority 4: Telecom deepening ---
    this.addBillShockAlerts();
  }

  // --- Priority 4: Bill-shock language detector -----------------------------

  private addBillShockAlerts(): void {
    if (document.querySelector('.ab-domain-bill-shock')) return;
    const host =
      document.querySelector<HTMLElement>('main, article, [class*="bill" i], [class*="plan" i], [class*="charges" i]') ??
      document.body;
    if (!host) return;

    const text = (host.textContent || '').slice(0, 15_000);
    const findings = detectBillShockLanguage(text);
    if (findings.length === 0) return;

    const hasDanger = findings.some((f) => f.severity === 'danger');
    const panel = document.createElement('aside');
    panel.className = hasDanger
      ? 'ab-domain-bill-shock ab-domain-bill-shock-danger'
      : 'ab-domain-bill-shock';
    panel.setAttribute('role', hasDanger ? 'alert' : 'status');
    panel.setAttribute('aria-label', 'Charges worth checking on this page');

    const title = document.createElement('div');
    title.className = 'ab-domain-bill-shock-title';
    title.textContent = hasDanger
      ? 'Extra-charge language with ₹ amount nearby — read the fine print'
      : 'This page mentions extra charges — review before you proceed';
    panel.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'ab-domain-bill-shock-list';
    const seen = new Set<string>();
    for (const finding of findings) {
      if (seen.has(finding.phrase)) continue;
      seen.add(finding.phrase);
      const li = document.createElement('li');
      li.textContent = `“${finding.phrase}”${finding.severity === 'danger' ? ' (with ₹ nearby)' : ''}`;
      list.appendChild(li);
    }
    panel.appendChild(list);

    host.insertBefore(panel, host.firstChild);
    this.overlayElements.push(panel);
  }

  // ---- 1. Jargon decoder ---------------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(TELECOM_JARGON).join('|') + ')\\b',
      'g',
    );

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, script, style, .ab-domain-processed') ||
        node.parentElement?.classList.contains('ab-domain-jargon')
      ) continue;
      if (termsPattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      termsPattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-jargon')) continue;

      const text = textNode.textContent || '';
      termsPattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = termsPattern.exec(text)) !== null) {
        // Text before match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const term = match[1];
        const span = document.createElement('span');
        span.className = 'ab-domain-jargon';
        span.textContent = term;
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `${term}: ${TELECOM_JARGON[term]}`);
        span.setAttribute('data-ab-tooltip', TELECOM_JARGON[term]);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = TELECOM_JARGON[term];
        span.appendChild(tooltip);

        fragment.appendChild(span);
        this.tooltipElements.push(span);

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      if (lastIndex > 0) {
        parent.replaceChild(fragment, textNode);
        parent.classList.add('ab-domain-processed');
      }
    }
  }

  // ---- 2. Plan comparator --------------------------------------------------

  private enhancePlanTables(): void {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-processed')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isPlanTable = ['price', 'data', 'validity', 'plan', 'amount', 'recharge', 'benefit', 'talktime']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isPlanTable) continue;
      table.classList.add('ab-domain-processed');

      // Find column indices
      const priceIdx = headers.findIndex(h => h.includes('price') || h.includes('amount') || h.includes('recharge') || h.includes('₹'));
      const dataIdx = headers.findIndex(h => h.includes('data') || h.includes('gb') || h.includes('mb'));
      const validityIdx = headers.findIndex(h => h.includes('validity') || h.includes('days') || h.includes('expiry'));

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        if (row.querySelector('.ab-domain-plan-badge')) continue;
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        const priceText = priceIdx >= 0 && cells[priceIdx] ? (cells[priceIdx].textContent || '').trim() : '';
        const dataText = dataIdx >= 0 && cells[dataIdx] ? (cells[dataIdx].textContent || '').trim() : '';
        const validityText = validityIdx >= 0 && cells[validityIdx] ? (cells[validityIdx].textContent || '').trim() : '';

        const price = parsePrice(priceText) ?? parseFloat(priceText.replace(/[^\d.]/g, ''));
        const dataMB = parseDataValue(dataText);
        const validityDays = parseValidity(validityText);

        if (isNaN(price) || price <= 0) continue;

        const badges: string[] = [];

        // Price per GB
        if (dataMB && dataMB > 0) {
          const dataGB = dataMB / 1024;
          const pricePerGB = price / dataGB;
          badges.push(`₹${pricePerGB.toFixed(1)}/GB`);
        }

        // Price per day
        if (validityDays && validityDays > 0) {
          const pricePerDay = price / validityDays;
          badges.push(`₹${pricePerDay.toFixed(1)}/day`);
        }

        if (badges.length === 0) continue;

        const badge = document.createElement('div');
        badge.className = 'ab-domain-plan-badge';
        badge.setAttribute('role', 'note');
        badge.setAttribute('aria-label', `Plan value: ${badges.join(', ')}`);
        badge.textContent = badges.join(' | ');

        const targetCell = cells[priceIdx >= 0 ? priceIdx : 0];
        targetCell.appendChild(badge);
        this.overlayElements.push(badge);
      }
    }

    // Also scan card-based plan layouts (common in modern telecom sites)
    this.enhancePlanCards();
  }

  private enhancePlanCards(): void {
    // Detect plan cards by common CSS patterns
    const cards = document.querySelectorAll(
      '[class*="plan"], [class*="recharge"], [class*="offer"], [class*="pack"], ' +
      '[data-plan], [data-recharge], [data-pack]',
    );

    for (const card of cards) {
      if (card.classList.contains('ab-domain-processed')) continue;
      const cardText = (card.textContent || '').trim();

      const price = parsePrice(cardText);
      const dataMB = parseDataValue(cardText);
      const validityDays = parseValidity(cardText);

      if (!price || price <= 0) continue;

      const badges: string[] = [];

      if (dataMB && dataMB > 0) {
        const dataGB = dataMB / 1024;
        const pricePerGB = price / dataGB;
        badges.push(`₹${pricePerGB.toFixed(1)}/GB`);
      }

      if (validityDays && validityDays > 0) {
        const pricePerDay = price / validityDays;
        badges.push(`₹${pricePerDay.toFixed(1)}/day`);
      }

      if (badges.length === 0) continue;

      card.classList.add('ab-domain-processed');
      const badge = document.createElement('div');
      badge.className = 'ab-domain-plan-badge';
      badge.setAttribute('role', 'note');
      badge.setAttribute('aria-label', `Plan value: ${badges.join(', ')}`);
      badge.textContent = badges.join(' | ');

      (card as HTMLElement).appendChild(badge);
      this.overlayElements.push(badge);
    }
  }

  // ---- 3. Recharge form assistance -----------------------------------------

  private enhanceRechargeForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let telecomFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label}`;

        const fieldInfo = this.identifyTelecomField(combined);
        if (fieldInfo) {
          telecomFieldCount++;
          this.enhanceField(el, fieldInfo);
        }
      }

      if (telecomFieldCount >= 1) {
        form.classList.add('ab-domain-processed');
        this.addFormStepGuide(form);
      }
    }
  }

  private identifyTelecomField(text: string): { label: string; hint: string; pattern?: RegExp } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string; pattern?: RegExp }> = [
      {
        keywords: ['mobile', 'phone', 'number', 'msisdn'],
        label: 'Mobile Number',
        hint: '10-digit Indian mobile number starting with 6, 7, 8, or 9',
        pattern: /^[6-9]\d{9}$/,
      },
      {
        keywords: ['amount', 'recharge', 'amt', 'topup'],
        label: 'Recharge Amount',
        hint: 'Enter the recharge amount in rupees (e.g. 299, 599)',
        pattern: /^\d+(\.\d{1,2})?$/,
      },
      {
        keywords: ['operator', 'provider', 'network'],
        label: 'Operator',
        hint: 'Select your mobile operator (e.g. Jio, Airtel, Vi, BSNL)',
      },
      {
        keywords: ['circle', 'state', 'region', 'zone'],
        label: 'Service Circle',
        hint: 'Select your telecom circle or state for the correct plan listing',
      },
      {
        keywords: ['imei'],
        label: 'IMEI Number',
        hint: '15-digit number found by dialling *#06# on your phone',
        pattern: /^\d{15}$/,
      },
      {
        keywords: ['sim', 'iccid'],
        label: 'SIM Number',
        hint: 'The 19-20 digit number printed on your SIM card',
        pattern: /^\d{19,20}$/,
      },
      {
        keywords: ['coupon', 'promo', 'voucher', 'code'],
        label: 'Promo Code',
        hint: 'Enter a coupon or promotional code for discount (optional)',
      },
    ];

    for (const field of fields) {
      if (field.keywords.some(kw => text.includes(kw))) {
        return { label: field.label, hint: field.hint, pattern: field.pattern };
      }
    }
    return null;
  }

  private enhanceField(
    el: HTMLInputElement,
    info: { label: string; hint: string; pattern?: RegExp },
  ): void {
    // Add accessible label if missing
    if (!el.getAttribute('aria-label') && !el.labels?.length) {
      el.setAttribute('aria-label', info.label);
    }

    // Add hint tooltip
    const wrapper = el.parentElement;
    if (wrapper && !wrapper.querySelector('.ab-domain-field-hint')) {
      const hint = document.createElement('div');
      hint.className = 'ab-domain-field-hint';
      hint.setAttribute('role', 'note');
      hint.textContent = info.hint;
      wrapper.appendChild(hint);
      this.overlayElements.push(hint);
    }

    // Real-time validation
    if (info.pattern) {
      const validateFn = (() => {
        const value = el.value.trim();
        const existing = el.parentElement?.querySelector('.ab-domain-field-error');
        if (!value) {
          existing?.remove();
          el.classList.remove('ab-domain-field-invalid');
          return;
        }
        if (info.pattern!.test(value)) {
          existing?.remove();
          el.classList.remove('ab-domain-field-invalid');
          el.classList.add('ab-domain-field-valid');
        } else {
          el.classList.remove('ab-domain-field-valid');
          el.classList.add('ab-domain-field-invalid');
          if (!existing) {
            const err = document.createElement('div');
            err.className = 'ab-domain-field-error';
            err.setAttribute('role', 'alert');
            err.textContent = `Please check the ${info.label} format`;
            el.parentElement?.appendChild(err);
            this.overlayElements.push(err);
          }
        }
      }) as EventListener;

      el.addEventListener('input', validateFn);
      this.formListeners.push({ el, type: 'input', fn: validateFn });
    }
  }

  private addFormStepGuide(form: HTMLFormElement): void {
    const steps = Array.from(form.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    if (steps.length < 2) return;

    const guide = document.createElement('div');
    guide.className = 'ab-domain-step-guide';
    guide.setAttribute('role', 'navigation');
    guide.setAttribute('aria-label', 'Recharge form step indicator');

    const stepIndicators: HTMLElement[] = [];
    steps.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = 'ab-domain-step-dot';
      dot.textContent = String(i + 1);
      dot.setAttribute('aria-label', `Step ${i + 1} of ${steps.length}`);
      guide.appendChild(dot);
      stepIndicators.push(dot);
    });

    form.insertBefore(guide, form.firstChild);
    this.overlayElements.push(guide);

    // Highlight current step on focus
    steps.forEach((step, i) => {
      const focusFn = (() => {
        stepIndicators.forEach((dot, j) => {
          dot.classList.toggle('ab-domain-step-active', j === i);
          dot.classList.toggle('ab-domain-step-done', j < i);
        });
      }) as EventListener;

      (step as HTMLElement).addEventListener('focus', focusFn);
      this.formListeners.push({ el: step as HTMLElement, type: 'focus', fn: focusFn });
    });
  }

  // ---- 4. Data usage reader ------------------------------------------------

  private addDataUsageReaders(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const dataPattern = /\d+(?:\.\d+)?\s*(?:GB|MB|TB)/gi;

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, .ab-domain-data-tag, script, style') ||
        node.parentElement?.classList.contains('ab-domain-data-tag')
      ) continue;
      if (dataPattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      dataPattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-data-tag') || parent.classList.contains('ab-domain-processed')) continue;

      const text = textNode.textContent || '';
      dataPattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let replaced = false;

      while ((match = dataPattern.exec(text)) !== null) {
        const megabytes = parseDataValue(match[0]);
        if (megabytes === null || megabytes <= 0) continue;

        const humanText = dataToHumanReadable(megabytes);
        if (!humanText) continue;
        replaced = true;

        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const span = document.createElement('span');
        span.className = 'ab-domain-data-tag';
        span.textContent = match[0];
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `${match[0]} — ${humanText}`);
        span.setAttribute('data-ab-tooltip', humanText);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = humanText;
        span.appendChild(tooltip);

        fragment.appendChild(span);
        this.tooltipElements.push(span);

        lastIndex = match.index + match[0].length;
      }

      if (replaced) {
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        parent.replaceChild(fragment, textNode);
        parent.classList.add('ab-domain-processed');
      }
    }
  }

  // ---- 5. FUP / validity alerts --------------------------------------------

  private addFupValidityAlerts(): void {
    // Scan for validity/expiry date displays
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const validityPattern = /(?:valid(?:ity)?|expir(?:y|es|ing)|renew(?:al|s)?|ends?)\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{2,4}|\d+\s*days?)/gi;

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, .ab-domain-validity-badge, script, style') ||
        node.parentElement?.classList.contains('ab-domain-validity-badge')
      ) continue;
      if (validityPattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      validityPattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-validity-badge') || parent.classList.contains('ab-domain-processed')) continue;

      const text = textNode.textContent || '';
      validityPattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = validityPattern.exec(text)) !== null) {
        const captured = match[1];
        let daysRemaining: number | null = null;
        let badgeText = '';

        // Check if it is a "X days" format
        const daysMatch = captured.match(/^(\d+)\s*days?$/i);
        if (daysMatch) {
          daysRemaining = parseInt(daysMatch[1], 10);
          badgeText = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`;
        } else {
          // Try parsing as a date
          daysRemaining = daysUntil(captured);
          if (daysRemaining !== null) {
            if (daysRemaining < 0) {
              badgeText = `Expired ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? '' : 's'} ago`;
            } else if (daysRemaining === 0) {
              badgeText = 'Expires today';
            } else {
              badgeText = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`;
            }
          }
        }

        if (!badgeText || daysRemaining === null) continue;

        // Determine urgency level
        let urgencyClass = 'ab-domain-validity-ok';
        if (daysRemaining <= 0) {
          urgencyClass = 'ab-domain-validity-expired';
        } else if (daysRemaining <= 3) {
          urgencyClass = 'ab-domain-validity-critical';
        } else if (daysRemaining <= 7) {
          urgencyClass = 'ab-domain-validity-warning';
        }

        // Check if badge already exists for this parent
        if (parent.querySelector('.ab-domain-validity-badge')) continue;

        const badge = document.createElement('span');
        badge.className = `ab-domain-validity-badge ${urgencyClass}`;
        badge.setAttribute('role', 'alert');
        badge.setAttribute('aria-label', badgeText);
        badge.setAttribute('tabindex', '0');
        badge.textContent = badgeText;

        parent.appendChild(badge);
        parent.classList.add('ab-domain-processed');
        this.overlayElements.push(badge);
        break; // One badge per parent
      }
    }

    // Also scan for FUP limit indicators
    this.scanFupIndicators();
  }

  private scanFupIndicators(): void {
    // Look for elements containing FUP-related text
    const allElements = document.querySelectorAll('*:not(script):not(style)');
    for (const el of allElements) {
      if ((el as HTMLElement).classList?.contains('ab-domain-processed')) continue;
      if (el.children.length > 3) continue; // skip container elements

      const text = (el.textContent || '').trim();
      if (text.length > 200) continue;

      const fupMatch = text.match(/(?:after|post|beyond)\s+(?:FUP|fair usage|limit)[:\s]*(\d+(?:\.\d+)?\s*(?:GB|MB))/i) ||
                        text.match(/FUP\s*[:\-]?\s*(\d+(?:\.\d+)?\s*(?:GB|MB))/i);

      if (!fupMatch) continue;

      const dataMB = parseDataValue(fupMatch[1]);
      if (!dataMB) continue;

      (el as HTMLElement).classList.add('ab-domain-processed');

      const humanText = dataToHumanReadable(dataMB);
      const badge = document.createElement('span');
      badge.className = 'ab-domain-fup-badge';
      badge.setAttribute('role', 'note');
      badge.setAttribute('aria-label', `Fair Usage limit: ${fupMatch[1]}. After this, speed will be reduced. ${humanText}`);
      badge.setAttribute('tabindex', '0');
      badge.textContent = `FUP: ${fupMatch[1]} — speed reduces after this`;

      const tooltip = document.createElement('span');
      tooltip.className = 'ab-domain-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = humanText ? `That is: ${humanText}` : 'After this limit your speed will be reduced.';
      badge.appendChild(tooltip);

      (el as HTMLElement).appendChild(badge);
      this.tooltipElements.push(badge);
    }
  }
}
