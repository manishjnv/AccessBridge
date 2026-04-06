/**
 * AccessBridge — Banking Domain Connector v0
 *
 * Detects banking websites and provides accessibility adaptations:
 *   - Transaction simplifier (plain-language summaries)
 *   - Form assistance (labels, step guidance, validation)
 *   - Jargon decoder (tooltips for banking terms)
 *   - Security alerts (confirmation before sensitive submissions)
 *   - Amount reader (Indian numbering → words)
 */

import type { DomainConnector } from './index.js';

// ---------------------------------------------------------------------------
// Banking jargon glossary
// ---------------------------------------------------------------------------

const BANKING_JARGON: Record<string, string> = {
  'APR': 'Annual Percentage Rate — the yearly interest rate charged on loans or earned on deposits.',
  'EMI': 'Equated Monthly Instalment — fixed monthly payment to repay a loan over a set period.',
  'NEFT': 'National Electronic Funds Transfer — a batch-based fund transfer system by RBI, settled in half-hourly batches.',
  'RTGS': 'Real Time Gross Settlement — instant high-value fund transfers (minimum ₹2 lakh) processed in real time.',
  'IMPS': 'Immediate Payment Service — instant 24×7 fund transfer for amounts up to ₹5 lakh.',
  'KYC': 'Know Your Customer — identity verification required by banks to prevent fraud and money laundering.',
  'CIBIL': 'Credit Information Bureau (India) Limited — provides your credit score (300–900) used by lenders.',
  'IFSC': 'Indian Financial System Code — an 11-character code identifying a specific bank branch for fund transfers.',
  'UPI': 'Unified Payments Interface — instant mobile payment system by NPCI.',
  'NACH': 'National Automated Clearing House — used for recurring payments like EMIs and subscriptions.',
  'MICR': 'Magnetic Ink Character Recognition — a 9-digit code on cheques identifying the bank and branch.',
  'CRR': 'Cash Reserve Ratio — the percentage of deposits banks must keep with RBI.',
  'SLR': 'Statutory Liquidity Ratio — the percentage of deposits banks must hold in liquid assets.',
  'NPA': 'Non-Performing Asset — a loan where the borrower has stopped paying interest or principal.',
  'FD': 'Fixed Deposit — a savings scheme where money is deposited for a fixed tenure at a fixed interest rate.',
  'RD': 'Recurring Deposit — a savings scheme where a fixed amount is deposited monthly for a fixed tenure.',
  'TDS': 'Tax Deducted at Source — tax withheld by the bank on interest income above the threshold.',
  'OD': 'Overdraft — a facility allowing you to withdraw more than your account balance, up to a set limit.',
  'CASA': 'Current Account Savings Account — refers to low-cost deposits for banks.',
  'DD': 'Demand Draft — a pre-paid negotiable instrument guaranteed by the issuing bank.',
  'SWIFT': 'Society for Worldwide Interbank Financial Telecommunication — used for international fund transfers.',
  'MCLR': 'Marginal Cost of Funds Based Lending Rate — benchmark interest rate set by banks for loans.',
  'PLR': 'Prime Lending Rate — the interest rate banks charge their most creditworthy customers.',
  'ROI': 'Rate of Interest — the percentage charged on a loan or earned on a deposit.',
  'SI': 'Standing Instruction — automatic recurring payment set up on your account.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for banking site detection
// ---------------------------------------------------------------------------

const BANKING_HOSTNAMES = [
  'netbanking', 'onlinebanking', 'ibanking', 'ebanking',
  'onlinesbi.sbi', 'sbi.co.in',
  'hdfcbank.com', 'netbanking.hdfcbank',
  'icicibank.com', 'infinity.icicibank',
  'axisbank.com', 'omni.axisbank',
  'kotak.com', 'kotaknetbanking',
  'pnbindia.in', 'netpnb',
  'bankofindia.co.in', 'boi',
  'bankofbaroda.in', 'barodaconnect',
  'canarabank.com',
  'unionbankofindia.co.in',
  'idbibank.in', 'idbi',
  'yesbank.in',
  'indusind.com',
  'federalbank.co.in',
  'rbl.bank',
  'paytm.com/bank',
  'phonepe.com',
  'gpay', 'pay.google',
  'citi.com', 'citibank',
  'sc.com', 'standardchartered',
  'hsbc.co.in',
  'dbs.com',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a number to Indian-English words (handles up to ₹99,99,99,99,999). */
function amountToIndianWords(amount: number): string {
  if (amount === 0) return 'Zero Rupees';

  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = [
    '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
  ];

  function twoDigits(n: number): string {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  }

  function threeDigits(n: number): string {
    if (n === 0) return '';
    if (n < 100) return twoDigits(n);
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + twoDigits(n % 100) : '');
  }

  const parts: string[] = [];
  const isNegative = amount < 0;
  let n = Math.abs(Math.floor(amount));

  // Indian system: ones/tens/hundreds, then groups of 2 digits
  const units = [
    { divisor: 1_00_00_00_000, label: 'Arab' },
    { divisor: 1_00_00_000, label: 'Crore' },
    { divisor: 1_00_000, label: 'Lakh' },
    { divisor: 1_000, label: 'Thousand' },
    { divisor: 1, label: '' },
  ];

  for (const { divisor, label } of units) {
    if (divisor === 1) {
      if (n > 0) parts.push(threeDigits(n));
    } else {
      const chunk = Math.floor(n / divisor);
      if (chunk > 0) {
        parts.push(twoDigits(chunk) + ' ' + label);
        n %= divisor;
      }
    }
  }

  const words = parts.join(' ').replace(/\s+/g, ' ').trim();
  return (isNegative ? 'Minus ' : '') + words + ' Rupees';
}

/** Parse an Indian-format currency string like "₹1,50,000.75" to a number. */
function parseIndianCurrency(text: string): number | null {
  const match = text.match(/₹?\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const cleaned = match[1].replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// BankingConnector
// ---------------------------------------------------------------------------

export class BankingConnector implements DomainConnector {
  readonly id = 'banking';
  readonly label = 'Banking';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    // Hostname check
    if (BANKING_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic: banking-specific form fields
    const formSignals = document.querySelectorAll(
      'input[name*="account"], input[name*="ifsc"], input[name*="beneficiary"], ' +
      'input[name*="amt"], input[name*="amount"], input[placeholder*="Account"], ' +
      'input[placeholder*="IFSC"], [data-field*="account"], [data-field*="ifsc"]',
    );
    if (formSignals.length >= 2) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const bankingKeywords = ['account number', 'ifsc code', 'fund transfer', 'net banking', 'mobile banking', 'neft', 'rtgs', 'imps'];
    const matchCount = bankingKeywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Banking domain connector activated');

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

    console.log('[AccessBridge] Banking domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.enhanceTransactionTables();
    this.enhanceBankingForms();
    this.addSecurityAlerts();
    this.addAmountReaders();
  }

  // ---- 1. Jargon decoder ---------------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(BANKING_JARGON).join('|') + ')\\b',
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
        span.setAttribute('aria-label', `${term}: ${BANKING_JARGON[term]}`);
        span.setAttribute('data-ab-tooltip', BANKING_JARGON[term]);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = BANKING_JARGON[term];
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

  // ---- 2. Transaction simplifier -------------------------------------------

  private enhanceTransactionTables(): void {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-processed')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isTransaction = ['amount', 'date', 'description', 'debit', 'credit', 'transaction', 'particulars']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isTransaction) continue;
      table.classList.add('ab-domain-processed');

      // Find column indices
      const amtIdx = headers.findIndex(h => h.includes('amount') || h.includes('debit') || h.includes('credit'));
      const descIdx = headers.findIndex(h => h.includes('description') || h.includes('particulars') || h.includes('narration'));
      const dateIdx = headers.findIndex(h => h.includes('date'));

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        if (row.querySelector('.ab-domain-txn-summary')) continue;
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        const amtText = amtIdx >= 0 && cells[amtIdx] ? (cells[amtIdx].textContent || '').trim() : '';
        const descText = descIdx >= 0 && cells[descIdx] ? (cells[descIdx].textContent || '').trim() : '';
        const dateText = dateIdx >= 0 && cells[dateIdx] ? (cells[dateIdx].textContent || '').trim() : '';

        const amount = parseIndianCurrency(amtText);
        if (amount === null) continue;

        const summary = this.buildTransactionSummary(amount, descText, dateText);
        const badge = document.createElement('div');
        badge.className = 'ab-domain-txn-summary';
        badge.setAttribute('role', 'note');
        badge.setAttribute('aria-label', summary);
        badge.textContent = summary;

        const targetCell = cells[descIdx >= 0 ? descIdx : 0];
        targetCell.appendChild(badge);
        this.overlayElements.push(badge);
      }
    }
  }

  private buildTransactionSummary(amount: number, desc: string, date: string): string {
    const amtWords = amountToIndianWords(amount);
    const shortDesc = desc.length > 50 ? desc.slice(0, 47) + '...' : desc;
    let summary = `₹${amount.toLocaleString('en-IN')} (${amtWords})`;
    if (shortDesc) summary += ` — ${shortDesc}`;
    if (date) summary += ` on ${date}`;
    return summary;
  }

  // ---- 3. Form assistance --------------------------------------------------

  private enhanceBankingForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let bankingFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label}`;

        const fieldInfo = this.identifyBankingField(combined);
        if (fieldInfo) {
          bankingFieldCount++;
          this.enhanceField(el, fieldInfo);
        }
      }

      if (bankingFieldCount >= 2) {
        form.classList.add('ab-domain-processed');
        this.addFormStepGuide(form);
      }
    }
  }

  private identifyBankingField(text: string): { label: string; hint: string; pattern?: RegExp } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string; pattern?: RegExp }> = [
      {
        keywords: ['account', 'acc no', 'acct'],
        label: 'Account Number',
        hint: 'Enter your bank account number (usually 9-18 digits)',
        pattern: /^\d{9,18}$/,
      },
      {
        keywords: ['ifsc'],
        label: 'IFSC Code',
        hint: 'Bank branch code — 11 characters like SBIN0001234',
        pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
      },
      {
        keywords: ['beneficiary', 'payee'],
        label: 'Beneficiary Name',
        hint: 'Full name of the person or company you are paying',
      },
      {
        keywords: ['amount', 'amt'],
        label: 'Transfer Amount',
        hint: 'Enter the amount in rupees (e.g. 5000)',
        pattern: /^\d+(\.\d{1,2})?$/,
      },
      {
        keywords: ['upi', 'vpa'],
        label: 'UPI ID',
        hint: 'UPI address like name@bank (e.g. john@okicici)',
        pattern: /^[\w.-]+@[\w]+$/,
      },
      {
        keywords: ['mobile', 'phone'],
        label: 'Mobile Number',
        hint: '10-digit Indian mobile number',
        pattern: /^[6-9]\d{9}$/,
      },
      {
        keywords: ['pan'],
        label: 'PAN Number',
        hint: 'Permanent Account Number — 10 characters like ABCDE1234F',
        pattern: /^[A-Z]{5}\d{4}[A-Z]$/,
      },
      {
        keywords: ['remark', 'narration', 'note'],
        label: 'Remarks / Note',
        hint: 'Optional description for this transaction',
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

    // Amount reader for amount fields
    if (info.label === 'Transfer Amount') {
      const amountReadFn = (() => {
        const val = parseFloat(el.value);
        const existing = el.parentElement?.querySelector('.ab-domain-amount-words');
        if (isNaN(val) || val === 0) {
          existing?.remove();
          return;
        }
        const words = amountToIndianWords(val);
        if (existing) {
          existing.textContent = words;
        } else {
          const wordEl = document.createElement('div');
          wordEl.className = 'ab-domain-amount-words';
          wordEl.setAttribute('aria-live', 'polite');
          wordEl.textContent = words;
          el.parentElement?.appendChild(wordEl);
          this.overlayElements.push(wordEl);
        }
      }) as EventListener;

      el.addEventListener('input', amountReadFn);
      this.formListeners.push({ el, type: 'input', fn: amountReadFn });
    }
  }

  private addFormStepGuide(form: HTMLFormElement): void {
    const steps = Array.from(form.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    if (steps.length < 2) return;

    const guide = document.createElement('div');
    guide.className = 'ab-domain-step-guide';
    guide.setAttribute('role', 'navigation');
    guide.setAttribute('aria-label', 'Form step indicator');

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

  // ---- 4. Security alerts --------------------------------------------------

  private addSecurityAlerts(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.getAttribute('data-ab-security') === 'true') continue;

      // Check if this form submits sensitive data
      const inputs = form.querySelectorAll('input');
      let hasSensitive = false;
      for (const input of inputs) {
        const type = (input as HTMLInputElement).type.toLowerCase();
        const name = ((input as HTMLInputElement).name || '').toLowerCase();
        if (type === 'password' || name.includes('pin') || name.includes('otp') || name.includes('cvv')) {
          hasSensitive = true;
          break;
        }
      }

      if (!hasSensitive) {
        // Check for amount fields — confirm amount in words
        const amtInput = form.querySelector('input[name*="amount"], input[name*="amt"]') as HTMLInputElement;
        if (amtInput) hasSensitive = true;
      }

      if (!hasSensitive) continue;

      form.setAttribute('data-ab-security', 'true');
      const submitFn = ((e: Event) => {
        const amtInput = form.querySelector('input[name*="amount"], input[name*="amt"]') as HTMLInputElement;
        let confirmMsg = 'You are about to submit sensitive financial information. Please review all fields carefully.';

        if (amtInput && amtInput.value) {
          const val = parseFloat(amtInput.value);
          if (!isNaN(val) && val > 0) {
            confirmMsg = `You are about to transfer ${amountToIndianWords(val)} (₹${val.toLocaleString('en-IN')}). Please confirm this is correct.`;
          }
        }

        // Show accessible confirmation dialog
        const confirmed = window.confirm(confirmMsg);
        if (!confirmed) {
          e.preventDefault();
          e.stopPropagation();
        }
      }) as EventListener;

      form.addEventListener('submit', submitFn);
      this.formListeners.push({ el: form, type: 'submit', fn: submitFn });
    }
  }

  // ---- 5. Amount reader (standalone amounts on page) -----------------------

  private addAmountReaders(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const amountPattern = /₹\s?[\d,]+(?:\.\d{1,2})?/g;

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, .ab-domain-amount-tag, script, style') ||
        node.parentElement?.classList.contains('ab-domain-amount-tag')
      ) continue;
      if (amountPattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      amountPattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-amount-tag') || parent.classList.contains('ab-domain-processed')) continue;

      const text = textNode.textContent || '';
      amountPattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let replaced = false;

      while ((match = amountPattern.exec(text)) !== null) {
        const amount = parseIndianCurrency(match[0]);
        if (amount === null) continue;
        replaced = true;

        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const span = document.createElement('span');
        span.className = 'ab-domain-amount-tag';
        span.textContent = match[0];
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        const words = amountToIndianWords(amount);
        span.setAttribute('aria-label', `${match[0]} — ${words}`);
        span.setAttribute('data-ab-tooltip', words);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = words;
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
}
