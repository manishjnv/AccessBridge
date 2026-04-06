/**
 * AccessBridge — Retail / E-Commerce Domain Connector v0
 *
 * Detects e-commerce/retail websites and provides accessibility adaptations:
 *   - Jargon decoder (tooltips for retail/e-commerce terms)
 *   - Price simplifier (Indian-words price reader, discount badges)
 *   - Product comparison helper (simplified feature comparison overlays)
 *   - Form assistance (address forms, pincode/phone/email validation)
 *   - Delivery estimator (human-readable "X days from now" badges)
 */

import type { DomainConnector } from './index.js';

// ---------------------------------------------------------------------------
// Retail jargon glossary
// ---------------------------------------------------------------------------

const RETAIL_JARGON: Record<string, string> = {
  'COD': 'Cash on Delivery — pay in cash when the product is delivered to your doorstep.',
  'EMI': 'Equated Monthly Instalment — split the total price into smaller monthly payments.',
  'GST': 'Goods and Services Tax — a unified indirect tax applied on the sale of goods and services in India.',
  'MRP': 'Maximum Retail Price — the highest price at which a product can legally be sold in India.',
  'SKU': 'Stock Keeping Unit — a unique code assigned to each product for inventory tracking.',
  'Wishlist': 'A saved list of products you want to buy later.',
  'Cart': 'Your shopping cart — items you have selected to purchase.',
  'Checkout': 'The final step where you confirm your order, enter delivery details, and make payment.',
  'RMA': 'Return Merchandise Authorization — a process to return a defective or unwanted product for refund or replacement.',
  'Fulfillment': 'The process of receiving, packing, and shipping an order to the customer.',
  'Pincode': 'A 6-digit postal code used to determine delivery availability and estimated delivery time.',
  'Coupon Code': 'A promotional code you enter at checkout to get a discount on your order.',
  'BOGO': 'Buy One Get One — a promotion where you get a free item when you buy one.',
  'Flash Sale': 'A limited-time sale with steep discounts, usually lasting a few hours.',
  'Pre-order': 'Ordering a product before it is officially available or in stock.',
  'Backorder': 'An order for a product that is currently out of stock but will be shipped when available.',
  'Dropship': 'A fulfillment method where the seller does not keep products in stock but ships directly from the manufacturer.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for retail site detection
// ---------------------------------------------------------------------------

const RETAIL_HOSTNAMES = [
  'amazon.in', 'amazon.com',
  'flipkart.com',
  'myntra.com',
  'ajio.com',
  'snapdeal.com',
  'meesho.com',
  'nykaa.com',
  'tatacliq.com',
  'bigbasket.com',
  'jiomart.com',
  'croma.com',
  'reliancedigital',
  'shopclues',
  'paytmmall',
  'firstcry.com',
  'lenskart.com',
  'pepperfry.com',
  'urbanladder.com',
  'swiggy.com',
  'zomato.com',
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

/** Compute number of days between today and a future date string. */
function daysFromNow(dateStr: string): number | null {
  const parsed = Date.parse(dateStr);
  if (isNaN(parsed)) return null;
  const diff = parsed - Date.now();
  if (diff < 0) return null;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// RetailConnector
// ---------------------------------------------------------------------------

export class RetailConnector implements DomainConnector {
  readonly id = 'retail';
  readonly label = 'E-Commerce';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    // Hostname check
    if (RETAIL_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic: e-commerce-specific elements
    const domSignals = document.querySelectorAll(
      'button[class*="add-to-cart"], button[class*="addtocart"], button[class*="add_to_cart"], ' +
      '[data-action="add-to-cart"], [id*="add-to-cart"], [id*="addToCart"], ' +
      '.product-price, .price, [class*="price"], [class*="product-listing"], ' +
      '[class*="product-card"], [class*="product-grid"], [data-product-id]',
    );
    if (domSignals.length >= 3) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const retailKeywords = ['add to cart', 'buy now', 'price', 'delivery', 'pincode', 'checkout', 'wishlist', 'emi available'];
    const matchCount = retailKeywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Retail domain connector activated');

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

    console.log('[AccessBridge] Retail domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.enhancePrices();
    this.enhanceProductComparisons();
    this.enhanceRetailForms();
    this.addDeliveryEstimates();
  }

  // ---- 1. Jargon decoder ---------------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(RETAIL_JARGON).join('|') + ')\\b',
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
        span.setAttribute('aria-label', `${term}: ${RETAIL_JARGON[term]}`);
        span.setAttribute('data-ab-tooltip', RETAIL_JARGON[term]);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = RETAIL_JARGON[term];
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

  // ---- 2. Price simplifier -------------------------------------------------

  private enhancePrices(): void {
    // Find price elements via common selectors
    const priceSelectors = [
      '.price', '.product-price', '[class*="price"]', '[class*="Price"]',
      '[data-price]', '.a-price', '.a-offscreen',
      '[class*="selling-price"]', '[class*="special-price"]',
      '[class*="offer-price"]', '[class*="discounted"]',
    ];
    const priceElements = document.querySelectorAll(priceSelectors.join(', '));

    for (const el of priceElements) {
      if ((el as HTMLElement).classList.contains('ab-domain-processed')) continue;

      const text = (el.textContent || '').trim();
      const amount = parseIndianCurrency(text);
      if (amount === null || amount <= 0) continue;

      (el as HTMLElement).classList.add('ab-domain-processed');

      // Add Indian-words price reader
      const words = amountToIndianWords(amount);
      const badge = document.createElement('span');
      badge.className = 'ab-domain-price-words';
      badge.setAttribute('role', 'note');
      badge.setAttribute('aria-label', `${text} — ${words}`);
      badge.setAttribute('tabindex', '0');
      badge.textContent = ` (${words})`;
      el.appendChild(badge);
      this.overlayElements.push(badge);
    }

    // Detect discount savings: look for original + discounted price pairs
    this.addDiscountBadges();
  }

  private addDiscountBadges(): void {
    // Common patterns: strikethrough price next to current price
    const strikethroughSelectors = [
      'del', 's', 'strike', '[class*="original-price"]', '[class*="mrp"]',
      '[class*="was-price"]', '[class*="list-price"]', '[class*="old-price"]',
      '[class*="strike"]', '[class*="crossed"]',
    ];
    const strikethroughs = document.querySelectorAll(strikethroughSelectors.join(', '));

    for (const strikeEl of strikethroughs) {
      if ((strikeEl as HTMLElement).classList.contains('ab-domain-discount-processed')) continue;

      const originalAmount = parseIndianCurrency(strikeEl.textContent || '');
      if (originalAmount === null || originalAmount <= 0) continue;

      // Find the sibling or nearby current price
      const parent = strikeEl.parentElement;
      if (!parent) continue;

      const siblingPriceEls = parent.querySelectorAll(
        '.price, [class*="price"], [class*="Price"], [class*="selling"], [class*="offer"]',
      );

      for (const sibEl of siblingPriceEls) {
        if (sibEl === strikeEl || sibEl.contains(strikeEl) || strikeEl.contains(sibEl)) continue;
        const currentAmount = parseIndianCurrency(sibEl.textContent || '');
        if (currentAmount === null || currentAmount <= 0 || currentAmount >= originalAmount) continue;

        const savings = originalAmount - currentAmount;
        const percentOff = Math.round((savings / originalAmount) * 100);

        // Add "You save" badge
        if (!parent.querySelector('.ab-domain-savings-badge')) {
          const savingsBadge = document.createElement('span');
          savingsBadge.className = 'ab-domain-savings-badge';
          savingsBadge.setAttribute('role', 'note');
          const savingsWords = amountToIndianWords(savings);
          savingsBadge.setAttribute('aria-label', `You save ${savingsWords} — ${percentOff}% off`);
          savingsBadge.textContent = `You save ₹${savings.toLocaleString('en-IN')} (${percentOff}% off)`;
          parent.appendChild(savingsBadge);
          this.overlayElements.push(savingsBadge);
        }

        break;
      }

      (strikeEl as HTMLElement).classList.add('ab-domain-discount-processed');
    }
  }

  // ---- 3. Product comparison helper ----------------------------------------

  private enhanceProductComparisons(): void {
    // Look for product listing tables or grids
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-processed')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isComparison = ['feature', 'specification', 'spec', 'product', 'model', 'compare']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isComparison) continue;
      table.classList.add('ab-domain-processed');

      // Add simplified comparison overlay
      const overlay = document.createElement('div');
      overlay.className = 'ab-domain-comparison-overlay';
      overlay.setAttribute('role', 'region');
      overlay.setAttribute('aria-label', 'Simplified product comparison');
      overlay.setAttribute('tabindex', '0');

      const title = document.createElement('div');
      title.className = 'ab-domain-comparison-title';
      title.textContent = 'Simplified Comparison';
      overlay.appendChild(title);

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 2) continue;

        const featureName = (cells[0].textContent || '').trim();
        const values = cells.slice(1).map(c => (c.textContent || '').trim());

        if (!featureName) continue;

        const item = document.createElement('div');
        item.className = 'ab-domain-comparison-item';
        item.setAttribute('role', 'listitem');
        item.textContent = `${featureName}: ${values.join(' vs ')}`;
        overlay.appendChild(item);
      }

      table.parentElement?.insertBefore(overlay, table);
      this.overlayElements.push(overlay);
    }

    // Also look for product card grids
    const gridSelectors = [
      '[class*="product-grid"]', '[class*="product-list"]',
      '[class*="search-results"]', '[class*="product-container"]',
    ];
    const grids = document.querySelectorAll(gridSelectors.join(', '));

    for (const grid of grids) {
      if ((grid as HTMLElement).classList.contains('ab-domain-processed')) continue;

      const cards = grid.querySelectorAll(
        '[class*="product-card"], [class*="product-item"], [class*="product-tile"], [data-product-id]',
      );
      if (cards.length < 2) continue;

      (grid as HTMLElement).classList.add('ab-domain-processed');

      const summaryOverlay = document.createElement('div');
      summaryOverlay.className = 'ab-domain-comparison-overlay';
      summaryOverlay.setAttribute('role', 'region');
      summaryOverlay.setAttribute('aria-label', `${cards.length} products listed — use arrow keys to navigate`);
      summaryOverlay.setAttribute('tabindex', '0');

      const countNote = document.createElement('div');
      countNote.className = 'ab-domain-comparison-title';
      countNote.textContent = `${cards.length} products found on this page`;
      summaryOverlay.appendChild(countNote);

      grid.parentElement?.insertBefore(summaryOverlay, grid);
      this.overlayElements.push(summaryOverlay);
    }
  }

  // ---- 4. Form assistance --------------------------------------------------

  private enhanceRetailForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let retailFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label}`;

        const fieldInfo = this.identifyRetailField(combined);
        if (fieldInfo) {
          retailFieldCount++;
          this.enhanceField(el, fieldInfo);
        }
      }

      if (retailFieldCount >= 2) {
        form.classList.add('ab-domain-processed');
        this.addFormStepGuide(form);
      }
    }
  }

  private identifyRetailField(text: string): { label: string; hint: string; pattern?: RegExp } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string; pattern?: RegExp }> = [
      {
        keywords: ['pincode', 'pin code', 'zip', 'postal'],
        label: 'Pincode',
        hint: 'Enter your 6-digit delivery pincode (e.g. 110001)',
        pattern: /^\d{6}$/,
      },
      {
        keywords: ['phone', 'mobile', 'contact number'],
        label: 'Phone Number',
        hint: '10-digit Indian mobile number starting with 6-9',
        pattern: /^[6-9]\d{9}$/,
      },
      {
        keywords: ['email', 'e-mail'],
        label: 'Email Address',
        hint: 'Your email address (e.g. name@example.com)',
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      },
      {
        keywords: ['address', 'addr', 'street', 'locality', 'flat', 'house'],
        label: 'Delivery Address',
        hint: 'Enter your full delivery address including flat/house number, street, and locality',
      },
      {
        keywords: ['city', 'town'],
        label: 'City',
        hint: 'Enter your city or town name',
      },
      {
        keywords: ['state', 'province'],
        label: 'State',
        hint: 'Select or enter your state',
      },
      {
        keywords: ['name', 'full name', 'recipient'],
        label: 'Recipient Name',
        hint: 'Full name of the person receiving the delivery',
      },
      {
        keywords: ['coupon', 'promo', 'discount code', 'voucher'],
        label: 'Coupon / Promo Code',
        hint: 'Enter a coupon or promotional code to get a discount on your order',
      },
      {
        keywords: ['card number', 'card no'],
        label: 'Card Number',
        hint: 'Enter your 16-digit debit or credit card number',
        pattern: /^\d{16}$/,
      },
      {
        keywords: ['cvv', 'cvc', 'security code'],
        label: 'CVV',
        hint: 'The 3-digit security code on the back of your card',
        pattern: /^\d{3}$/,
      },
      {
        keywords: ['expiry', 'exp date', 'valid thru'],
        label: 'Card Expiry',
        hint: 'Card expiry date in MM/YY format',
        pattern: /^(0[1-9]|1[0-2])\/\d{2}$/,
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

  // ---- 5. Delivery estimator -----------------------------------------------

  private addDeliveryEstimates(): void {
    // Look for delivery date displays via common selectors and text patterns
    const deliverySelectors = [
      '[class*="delivery"]', '[class*="Delivery"]',
      '[class*="shipping"]', '[class*="Shipping"]',
      '[class*="dispatch"]', '[class*="arrive"]',
      '[class*="estimated"]', '[id*="delivery"]',
    ];
    const deliveryElements = document.querySelectorAll(deliverySelectors.join(', '));

    for (const el of deliveryElements) {
      if ((el as HTMLElement).classList.contains('ab-domain-delivery-processed')) continue;

      const text = (el.textContent || '').trim();
      if (!text) continue;

      // Try to extract a date from the text
      // Common patterns: "Delivery by Mon, 14 Apr", "Estimated delivery: 14 April 2026",
      //                  "Arrives by Apr 14", "Get it by 14/04/2026"
      const datePatterns = [
        // "14 Apr 2026", "14 April 2026"
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i,
        // "Apr 14, 2026", "April 14, 2026"
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
        // "14/04/2026", "14-04-2026"
        /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
        // "Mon, 14 Apr" (no year — assume current year)
        /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*/i,
        // "Apr 14" (no year)
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?!\d)/i,
      ];

      let days: number | null = null;
      for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) {
          // Reconstruct a parseable date string
          let dateStr = match[0];
          // If no year found, append current year
          if (!/\d{4}/.test(dateStr)) {
            dateStr += ` ${new Date().getFullYear()}`;
          }
          days = daysFromNow(dateStr);
          if (days !== null) break;
        }
      }

      // Also check for "X days" or "X-Y business days" patterns
      if (days === null) {
        const daysMatch = text.match(/(\d+)\s*(?:-\s*(\d+)\s*)?(?:business\s+)?days?/i);
        if (daysMatch) {
          days = parseInt(daysMatch[daysMatch[2] ? '2' : '1'], 10);
        }
      }

      if (days === null) continue;

      (el as HTMLElement).classList.add('ab-domain-delivery-processed');

      const badge = document.createElement('span');
      badge.className = 'ab-domain-delivery-badge';
      badge.setAttribute('role', 'note');

      let humanText: string;
      if (days === 0) {
        humanText = 'Arriving today';
      } else if (days === 1) {
        humanText = 'Arriving tomorrow';
      } else {
        humanText = `${days} days from now`;
      }

      badge.setAttribute('aria-label', humanText);
      badge.textContent = ` (${humanText})`;
      el.appendChild(badge);
      this.overlayElements.push(badge);
    }
  }
}
