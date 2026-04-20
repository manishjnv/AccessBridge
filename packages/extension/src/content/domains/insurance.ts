/**
 * AccessBridge — Insurance Domain Connector v0
 *
 * Detects insurance websites and provides accessibility adaptations:
 *   - Policy simplifier (plain-language clause summaries)
 *   - Jargon decoder (tooltips for insurance terms)
 *   - Comparison helper (simplified plan comparison table)
 *   - Claim form assistant (step-by-step guidance)
 *   - Premium calculator helper (explanatory tooltips)
 */

import type { DomainConnector } from './index.js';
import { analyzeCoverageGaps } from './deepenings.js';

// ---------------------------------------------------------------------------
// Insurance jargon glossary
// ---------------------------------------------------------------------------

const INSURANCE_JARGON: Record<string, string> = {
  'Premium': 'The amount you pay regularly (monthly, quarterly, or yearly) to keep your insurance policy active.',
  'Deductible': 'The amount you must pay out of your own pocket before the insurance company starts paying.',
  'Copay': 'A fixed percentage of medical costs you share with the insurer after the deductible is met.',
  'Sum Assured': 'The guaranteed maximum amount the insurance company will pay upon a valid claim.',
  'Sum Insured': 'The maximum amount your health insurance will cover in a policy year.',
  'Claim': 'A formal request to the insurance company to pay for a covered loss or expense.',
  'Rider': 'An optional add-on to your base policy that provides extra coverage (e.g. critical illness rider).',
  'Exclusion': 'Specific conditions, treatments, or situations that the policy does NOT cover.',
  'Waiting Period': 'The initial time after buying a policy during which certain claims are not allowed.',
  'TPA': 'Third Party Administrator — a company that processes claims and manages cashless services on behalf of the insurer.',
  'Cashless': 'A facility where the insurance company directly pays the hospital, so you do not pay upfront.',
  'Reimbursement': 'You pay the hospital first, then submit bills to the insurer to get your money back.',
  'Maturity Benefit': 'The amount you receive when your life insurance policy completes its full term.',
  'Surrender Value': 'The amount you get if you cancel your life insurance policy before it matures.',
  'Grace Period': 'Extra time (usually 15-30 days) after the premium due date during which you can still pay without losing coverage.',
  'Lapse': 'When a policy becomes inactive because premiums were not paid within the grace period.',
  'Revival': 'Reactivating a lapsed policy by paying overdue premiums, often with a medical check-up.',
  'Nominee': 'The person you designate to receive the insurance payout in case of your death.',
  'Underwriting': 'The process where the insurer evaluates your risk (health, age, habits) to decide your premium.',
  'Moratorium': 'A period (usually 8 years) after which the insurer cannot reject claims on grounds of non-disclosure.',
  'No Claim Bonus': 'A discount on your premium for every year you do not make a claim — reward for staying healthy.',
  'NCB': 'No Claim Bonus — a premium discount for claim-free years.',
  'IDV': 'Insured Declared Value — the current market value of your vehicle, used as the maximum claim amount.',
  'Endorsement': 'An official change or addition to your existing policy (e.g. adding a family member).',
  'Portability': 'The right to switch your health insurance from one company to another without losing benefits.',
  'Free Look Period': 'A 15-30 day window after receiving your policy during which you can cancel for a full refund.',
  'IRDAI': 'Insurance Regulatory and Development Authority of India — the body that regulates all insurance in India.',
  'Annuity': 'A regular income (pension) you receive after retirement from your insurance investment.',
  'Term Insurance': 'Pure life insurance that pays only on death within the policy term — no maturity benefit.',
  'Endowment': 'A life insurance policy that pays on death OR on surviving the term — combines insurance with savings.',
  'ULIP': 'Unit Linked Insurance Plan — combines life insurance with market-linked investment.',
  'Floater': 'A single health policy that covers the entire family under one sum insured.',
  'Sub-limit': 'A cap on specific expenses (e.g. room rent) within the overall sum insured.',
  'Day Care': 'Medical procedures that require less than 24 hours of hospitalisation.',
  'Pre-existing Disease': 'A health condition you already had before buying the policy — usually has a waiting period.',
  'PED': 'Pre-Existing Disease — a condition diagnosed before the policy start date.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for insurance site detection
// ---------------------------------------------------------------------------

const INSURANCE_HOSTNAMES = [
  'licindia.in', 'lic',
  'policybazaar.com',
  'coverfox.com',
  'insurancedekho.com',
  'turtlemint.com',
  'digit.in', 'godigit',
  'acko.com',
  'hdfclife.com', 'hdfcergo',
  'icicilombard.com', 'icicipruli',
  'maxlifeinsurance.com',
  'sbilife.co.in', 'sbigeneral',
  'bajajallianz.com', 'bajajfinserv',
  'starhealth.in',
  'careinsurance.com', 'religare',
  'newindia.co.in',
  'orientalinsurance.org.in',
  'nationalinsurance',
  'uiic.co.in',
  'tataaig.com', 'tataaia',
  'adityabirlahealth',
  'niva', 'nivabupa',
  'manipalcigna',
  'kotak', 'kotaklife',
  'pnbmetlife',
  'aegonlife',
  'bhartiaxagi',
  'futuregenerali',
  'edelweisstokio',
  'insurance',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// InsuranceConnector
// ---------------------------------------------------------------------------

export class InsuranceConnector implements DomainConnector {
  readonly id = 'insurance';
  readonly label = 'Insurance';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    if (INSURANCE_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic
    const formSignals = document.querySelectorAll(
      'input[name*="policy"], input[name*="premium"], input[name*="claim"], ' +
      'input[name*="nominee"], input[placeholder*="Policy"], input[placeholder*="Sum Assured"], ' +
      '[data-field*="policy"], [data-field*="premium"]',
    );
    if (formSignals.length >= 2) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const keywords = ['sum assured', 'premium', 'policy term', 'claim', 'nominee', 'rider', 'exclusion', 'waiting period', 'cashless'];
    const matchCount = keywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Insurance domain connector activated');

    this.scanAndEnhance();

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

    for (const el of this.tooltipElements) el.remove();
    this.tooltipElements = [];
    for (const el of this.overlayElements) el.remove();
    this.overlayElements = [];
    for (const { el, type, fn } of this.formListeners) {
      el.removeEventListener(type, fn);
    }
    this.formListeners = [];

    console.log('[AccessBridge] Insurance domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.simplifyPolicyDocuments();
    this.addComparisonHelper();
    this.enhanceClaimForms();
    this.enhancePremiumCalculators();
    // --- Priority 4: Insurance deepening ---
    this.addCoverageGapReport();
  }

  // --- Priority 4: Coverage gap analyzer ------------------------------------

  private addCoverageGapReport(): void {
    if (document.querySelector('.ab-domain-coverage-gap')) return;
    const policySection =
      document.querySelector<HTMLElement>(
        '[class*="policy" i], [class*="coverage" i], [class*="benefits" i], [id*="policy" i], [id*="benefits" i]',
      ) ?? document.querySelector<HTMLElement>('main, article');
    if (!policySection) return;

    const text = (policySection.textContent || '').slice(0, 20_000);
    if (text.length < 400) return;
    const report = analyzeCoverageGaps(text);
    if (report.missing.length === 0 || report.covered.length === 0) return;

    const panel = document.createElement('aside');
    panel.className = 'ab-domain-coverage-gap';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Potential coverage gaps');

    const title = document.createElement('div');
    title.className = 'ab-domain-coverage-gap-title';
    title.textContent = `Coverage check: ${report.covered.length}/${report.covered.length + report.missing.length} common items detected`;
    panel.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'ab-domain-coverage-gap-list';
    for (const item of report.missing.slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = `Not mentioned: ${item}`;
      list.appendChild(li);
    }
    panel.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'ab-domain-coverage-gap-hint';
    hint.textContent = 'Missing items may still be covered — check the full policy document or ask the insurer.';
    panel.appendChild(hint);

    policySection.insertBefore(panel, policySection.firstChild);
    this.overlayElements.push(panel);
  }

  // ---- 1. Jargon decoder ---------------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(INSURANCE_JARGON).join('|') + ')\\b',
      'gi',
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
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const term = match[1];
        // Look up case-insensitively
        const jargonKey = Object.keys(INSURANCE_JARGON).find(k => k.toLowerCase() === term.toLowerCase()) || term;
        const definition = INSURANCE_JARGON[jargonKey];
        if (!definition) {
          fragment.appendChild(document.createTextNode(term));
          lastIndex = match.index + match[0].length;
          continue;
        }

        const span = document.createElement('span');
        span.className = 'ab-domain-jargon';
        span.textContent = term;
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `${term}: ${definition}`);
        span.setAttribute('data-ab-tooltip', definition);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = definition;
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

  // ---- 2. Policy simplifier ------------------------------------------------

  private simplifyPolicyDocuments(): void {
    // Detect long-form policy text blocks
    const policySelectors = [
      '.policy-document', '.policy-terms', '.terms-conditions',
      '.policy-details', '[data-section="policy"]',
      '.terms-and-conditions', '.policy-wording',
    ];

    for (const sel of policySelectors) {
      const sections = document.querySelectorAll(sel);
      for (const section of sections) {
        if (section.classList.contains('ab-domain-processed')) continue;
        section.classList.add('ab-domain-processed');
        this.addPolicySummaryBanner(section as HTMLElement);
      }
    }

    // Also scan for long text blocks that look like policy documents
    const paragraphs = document.querySelectorAll('p, div.text, .content-block');
    for (const p of paragraphs) {
      const text = (p.textContent || '').toLowerCase();
      if (text.length < 300) continue;
      if (p.classList.contains('ab-domain-processed')) continue;

      const policyKeywords = ['whereas', 'hereinafter', 'subject to', 'notwithstanding',
        'indemnify', 'liability', 'insured', 'policy holder', 'coverage', 'exclusion'];
      const kwCount = policyKeywords.filter(kw => text.includes(kw)).length;

      if (kwCount >= 3) {
        p.classList.add('ab-domain-processed');
        this.addPolicySummaryBanner(p as HTMLElement);
      }
    }
  }

  private addPolicySummaryBanner(section: HTMLElement): void {
    const banner = document.createElement('div');
    banner.className = 'ab-domain-policy-banner';
    banner.setAttribute('role', 'note');

    const text = (section.textContent || '').slice(0, 2000);
    const keyPoints = this.extractKeyPolicyPoints(text);

    banner.innerHTML = `
      <div class="ab-domain-policy-banner-header">
        <span class="ab-domain-policy-banner-icon" aria-hidden="true">&#9432;</span>
        <strong>Plain-Language Summary</strong>
        <button class="ab-domain-policy-banner-toggle" aria-label="Toggle summary" aria-expanded="false">&#9660;</button>
      </div>
      <div class="ab-domain-policy-banner-body" style="display:none;">
        <ul>
          ${keyPoints.map(pt => `<li>${escapeHtml(pt)}</li>`).join('')}
        </ul>
      </div>
    `;

    const toggle = banner.querySelector('.ab-domain-policy-banner-toggle');
    const body = banner.querySelector('.ab-domain-policy-banner-body') as HTMLElement;
    toggle?.addEventListener('click', () => {
      const expanded = body.style.display !== 'none';
      body.style.display = expanded ? 'none' : 'block';
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.textContent = expanded ? '\u25BC' : '\u25B2';
    });

    section.insertBefore(banner, section.firstChild);
    this.overlayElements.push(banner);
  }

  private extractKeyPolicyPoints(text: string): string[] {
    const points: string[] = [];
    const lower = text.toLowerCase();

    if (lower.includes('exclusion')) {
      points.push('This section mentions exclusions — conditions or situations that are NOT covered by the policy.');
    }
    if (lower.includes('waiting period')) {
      points.push('There is a waiting period — you may need to wait before certain benefits become available.');
    }
    if (lower.includes('deductible') || lower.includes('copay')) {
      points.push('You may have to pay a portion of costs (deductible/copay) before the insurer covers the rest.');
    }
    if (lower.includes('pre-existing') || lower.includes('pre existing')) {
      points.push('Pre-existing conditions may have special terms — check the waiting period and coverage limits.');
    }
    if (lower.includes('claim') && lower.includes('time') || lower.includes('claim') && lower.includes('period')) {
      points.push('There are time limits for filing claims — submit your claim within the specified period.');
    }
    if (lower.includes('renewal') || lower.includes('renew')) {
      points.push('Policy renewal terms apply — check if your policy renews automatically or requires manual renewal.');
    }
    if (lower.includes('nominee') || lower.includes('beneficiary')) {
      points.push('A nominee/beneficiary should be designated to receive benefits in case of a claim.');
    }
    if (lower.includes('grace period')) {
      points.push('A grace period is available — you have extra days to pay your premium before the policy lapses.');
    }

    if (points.length === 0) {
      points.push('This appears to be a policy document. Review carefully and ask your insurer to explain any unclear terms.');
    }

    return points;
  }

  // ---- 3. Comparison helper ------------------------------------------------

  private addComparisonHelper(): void {
    // Look for plan comparison tables or card layouts
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-compared')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isComparison = ['plan', 'premium', 'coverage', 'sum', 'benefit', 'feature']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isComparison || headers.length < 3) continue;
      table.classList.add('ab-domain-compared');

      this.addSimplifiedComparison(table);
    }

    // Also detect card-based comparison layouts
    const cards = document.querySelectorAll('.plan-card, .policy-card, [data-plan], [class*="plan-compare"]');
    if (cards.length >= 2 && !document.querySelector('.ab-domain-comparison-table')) {
      this.buildComparisonFromCards(Array.from(cards) as HTMLElement[]);
    }
  }

  private addSimplifiedComparison(table: HTMLElement): void {
    const summary = document.createElement('div');
    summary.className = 'ab-domain-comparison-summary';
    summary.setAttribute('role', 'note');

    const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
    const highlights: string[] = [];
    let maxCoverage = '';
    let minPremium = '';

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      const label = (cells[0]?.textContent || '').toLowerCase();

      if (label.includes('premium') || label.includes('price') || label.includes('cost')) {
        const values = cells.slice(1).map(c => (c.textContent || '').trim());
        if (values.length > 0) {
          minPremium = `Lowest premium: ${values.sort()[0]}`;
        }
      }
      if (label.includes('coverage') || label.includes('sum') || label.includes('cover')) {
        const values = cells.slice(1).map(c => (c.textContent || '').trim());
        if (values.length > 0) {
          maxCoverage = `Highest coverage: ${values.sort().reverse()[0]}`;
        }
      }
    }

    if (minPremium) highlights.push(minPremium);
    if (maxCoverage) highlights.push(maxCoverage);
    if (highlights.length === 0) highlights.push('Compare the plans below to find the best fit for your needs.');

    summary.innerHTML = `
      <div class="ab-domain-comparison-header">
        <span aria-hidden="true">&#128269;</span>
        <strong>Quick Comparison</strong>
      </div>
      <ul class="ab-domain-comparison-list">
        ${highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
      </ul>
    `;

    table.parentElement?.insertBefore(summary, table);
    this.overlayElements.push(summary);
  }

  private buildComparisonFromCards(cards: HTMLElement[]): void {
    if (cards.length < 2 || cards.length > 10) return;

    const compTable = document.createElement('div');
    compTable.className = 'ab-domain-comparison-table';
    compTable.setAttribute('role', 'table');
    compTable.setAttribute('aria-label', 'Simplified plan comparison');

    let html = '<div class="ab-domain-comparison-header"><strong>Simplified Plan Comparison</strong></div>';
    html += '<div class="ab-domain-comparison-grid" style="display:grid;grid-template-columns:repeat(' + cards.length + ',1fr);gap:8px;">';

    for (const card of cards) {
      const title = (card.querySelector('h2, h3, h4, .plan-name, .title') as HTMLElement)?.textContent || 'Plan';
      const price = (card.querySelector('[class*="price"], [class*="premium"], .amount') as HTMLElement)?.textContent || '—';
      html += `
        <div class="ab-domain-comparison-cell">
          <div class="ab-domain-comparison-plan-name">${escapeHtml(title.trim())}</div>
          <div class="ab-domain-comparison-plan-price">${escapeHtml(price.trim())}</div>
        </div>
      `;
    }

    html += '</div>';
    compTable.innerHTML = html;

    // Insert before the first card
    cards[0].parentElement?.insertBefore(compTable, cards[0]);
    this.overlayElements.push(compTable);
  }

  // ---- 4. Claim form assistant ---------------------------------------------

  private enhanceClaimForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-claim-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let claimFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label}`;

        const fieldInfo = this.identifyClaimField(combined);
        if (fieldInfo) {
          claimFieldCount++;
          this.enhanceClaimField(el, fieldInfo);
        }
      }

      if (claimFieldCount >= 2) {
        form.classList.add('ab-domain-claim-processed');
        this.addClaimStepGuide(form);
      }
    }
  }

  private identifyClaimField(text: string): { label: string; hint: string } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string }> = [
      {
        keywords: ['policy', 'policy number', 'policy no'],
        label: 'Policy Number',
        hint: 'Your unique policy number — found on your policy document or insurance card.',
      },
      {
        keywords: ['claim', 'claim number'],
        label: 'Claim Number',
        hint: 'Reference number assigned when you first reported the claim.',
      },
      {
        keywords: ['hospital', 'provider'],
        label: 'Hospital / Provider',
        hint: 'Name of the hospital or healthcare provider where treatment was received.',
      },
      {
        keywords: ['diagnosis', 'ailment', 'condition'],
        label: 'Diagnosis / Condition',
        hint: 'The medical condition or reason for the claim as stated by your doctor.',
      },
      {
        keywords: ['admission', 'date of admission'],
        label: 'Date of Admission',
        hint: 'The date you were admitted to the hospital.',
      },
      {
        keywords: ['discharge', 'date of discharge'],
        label: 'Date of Discharge',
        hint: 'The date you were discharged from the hospital.',
      },
      {
        keywords: ['amount', 'bill', 'total'],
        label: 'Claim Amount',
        hint: 'Total amount of the medical bills you are claiming.',
      },
      {
        keywords: ['document', 'upload', 'file', 'attachment'],
        label: 'Supporting Documents',
        hint: 'Upload bills, prescriptions, discharge summary, and diagnostic reports.',
      },
      {
        keywords: ['bank', 'account', 'ifsc'],
        label: 'Bank Details',
        hint: 'Your bank account details for receiving the claim reimbursement.',
      },
      {
        keywords: ['nominee', 'beneficiary'],
        label: 'Nominee / Beneficiary',
        hint: 'Person designated to receive the claim payout.',
      },
    ];

    for (const field of fields) {
      if (field.keywords.some(kw => text.includes(kw))) {
        return { label: field.label, hint: field.hint };
      }
    }
    return null;
  }

  private enhanceClaimField(el: HTMLInputElement, info: { label: string; hint: string }): void {
    if (!el.getAttribute('aria-label') && !el.labels?.length) {
      el.setAttribute('aria-label', info.label);
    }

    const wrapper = el.parentElement;
    if (wrapper && !wrapper.querySelector('.ab-domain-field-hint')) {
      const hint = document.createElement('div');
      hint.className = 'ab-domain-field-hint';
      hint.setAttribute('role', 'note');
      hint.textContent = info.hint;
      wrapper.appendChild(hint);
      this.overlayElements.push(hint);
    }
  }

  private addClaimStepGuide(form: HTMLFormElement): void {
    const steps = Array.from(form.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    if (steps.length < 2) return;

    const guide = document.createElement('div');
    guide.className = 'ab-domain-step-guide';
    guide.setAttribute('role', 'navigation');
    guide.setAttribute('aria-label', 'Claim form step indicator');

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

  // ---- 5. Premium calculator helper ----------------------------------------

  private enhancePremiumCalculators(): void {
    // Detect premium calculator forms
    const calcSelectors = [
      '.premium-calculator', '#premium-calculator', '[data-section="calculator"]',
      'form[action*="premium"]', 'form[action*="quote"]',
      '.quote-form', '#quote-form', '.calculator-form',
    ];

    for (const sel of calcSelectors) {
      const calcs = document.querySelectorAll(sel);
      for (const calc of calcs) {
        if (calc.classList.contains('ab-domain-calc-processed')) continue;
        calc.classList.add('ab-domain-calc-processed');
        this.enhanceCalculatorFields(calc as HTMLElement);
      }
    }

    // Also detect by field patterns
    const forms = document.querySelectorAll('form:not(.ab-domain-calc-processed)');
    for (const form of forms) {
      const inputs = form.querySelectorAll('input, select');
      let calcFieldCount = 0;

      for (const input of inputs) {
        const name = ((input as HTMLInputElement).name || '').toLowerCase();
        const label = ((input as HTMLInputElement).getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${label}`;
        if (['age', 'dob', 'sum assured', 'sum insured', 'cover', 'tenure', 'term', 'smoker', 'tobacco']
          .some(kw => combined.includes(kw))) {
          calcFieldCount++;
        }
      }

      if (calcFieldCount >= 2) {
        form.classList.add('ab-domain-calc-processed');
        this.enhanceCalculatorFields(form as HTMLElement);
      }
    }
  }

  private enhanceCalculatorFields(container: HTMLElement): void {
    const calcFieldInfo: Array<{ keywords: string[]; tooltip: string }> = [
      {
        keywords: ['age', 'dob', 'date of birth'],
        tooltip: 'Your age affects the premium — younger applicants generally get lower premiums.',
      },
      {
        keywords: ['sum assured', 'sum insured', 'cover amount', 'coverage'],
        tooltip: 'The maximum amount the insurer will pay on a claim. Higher coverage means higher premium.',
      },
      {
        keywords: ['term', 'tenure', 'policy period', 'duration'],
        tooltip: 'How long the policy will be active. Longer terms may cost more per year but offer extended protection.',
      },
      {
        keywords: ['smoker', 'tobacco', 'smoking'],
        tooltip: 'Tobacco use significantly increases premiums due to higher health risks.',
      },
      {
        keywords: ['gender', 'sex'],
        tooltip: 'Gender may affect premium calculations as life expectancy and health risks vary.',
      },
      {
        keywords: ['income', 'salary', 'annual income'],
        tooltip: 'Your income helps determine appropriate coverage amount — typically 10-15 times annual income is recommended.',
      },
      {
        keywords: ['rider', 'add-on', 'addon'],
        tooltip: 'Optional extras that increase coverage (e.g. critical illness, accidental death) for an additional premium.',
      },
      {
        keywords: ['deductible', 'copay'],
        tooltip: 'A higher deductible/copay means a lower premium, but you pay more out-of-pocket during a claim.',
      },
      {
        keywords: ['frequency', 'payment', 'mode'],
        tooltip: 'How often you pay: yearly payments are usually cheaper than monthly; monthly is easier to budget.',
      },
    ];

    const inputs = container.querySelectorAll('input, select, textarea');
    for (const input of inputs) {
      const el = input as HTMLInputElement;
      const name = (el.name || '').toLowerCase();
      const placeholder = (el.placeholder || '').toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const combined = `${name} ${placeholder} ${label} ${id}`;

      for (const info of calcFieldInfo) {
        if (info.keywords.some(kw => combined.includes(kw))) {
          const wrapper = el.parentElement;
          if (wrapper && !wrapper.querySelector('.ab-domain-calc-tooltip')) {
            const tip = document.createElement('div');
            tip.className = 'ab-domain-calc-tooltip ab-domain-field-hint';
            tip.setAttribute('role', 'note');
            tip.textContent = info.tooltip;
            wrapper.appendChild(tip);
            this.overlayElements.push(tip);
          }
          break;
        }
      }
    }
  }
}
