/**
 * AccessBridge — Manufacturing Domain Connector v0
 *
 * Detects manufacturing/ERP/supply-chain websites and provides accessibility adaptations:
 *   - ERP jargon decoder (tooltips for manufacturing terms)
 *   - Data table enhancer (row highlighting, sorting indicators, summary badges)
 *   - Form assistance (part number, quantity validation, date pickers)
 *   - Status indicator simplifier (color-coded accessible status badges)
 *   - Quantity unit reader (human-readable unit conversions)
 */

import type { DomainConnector } from './index.js';
import { detectHazardKeywords } from './deepenings.js';

// ---------------------------------------------------------------------------
// Manufacturing / ERP jargon glossary
// ---------------------------------------------------------------------------

const MANUFACTURING_JARGON: Record<string, string> = {
  'ERP': 'Enterprise Resource Planning — integrated software to manage core business processes like inventory, procurement, and production.',
  'MRP': 'Material Requirements Planning — a system for calculating the materials and components needed to manufacture a product.',
  'BOM': 'Bill of Materials — a comprehensive list of raw materials, components, and assemblies required to build a product.',
  'WIP': 'Work in Progress — partially finished goods that are still in the production process.',
  'QC': 'Quality Control — the process of inspecting products to ensure they meet defined standards before shipment.',
  'QA': 'Quality Assurance — systematic activities to ensure that quality requirements for a product or service are fulfilled.',
  'OEE': 'Overall Equipment Effectiveness — a metric measuring manufacturing productivity as availability × performance × quality.',
  'TPM': 'Total Productive Maintenance — a holistic approach to equipment maintenance that aims for zero breakdowns and zero defects.',
  'JIT': 'Just in Time — a manufacturing strategy where materials are ordered and received only as needed in the production process.',
  'Kanban': 'A visual scheduling system for lean manufacturing that controls the flow of materials and work through production stages.',
  'Kaizen': 'A Japanese philosophy of continuous improvement in manufacturing processes, efficiency, and quality.',
  'Six Sigma': 'A data-driven methodology to eliminate defects and reduce variability, targeting 3.4 defects per million opportunities.',
  'FIFO': 'First In, First Out — an inventory valuation method where the oldest stock is used or sold first.',
  'LIFO': 'Last In, First Out — an inventory valuation method where the most recently produced or acquired items are used first.',
  'SKU': 'Stock Keeping Unit — a unique identifier assigned to each distinct product for inventory tracking purposes.',
  'Lead Time': 'The total time from placing an order to receiving the finished product, including procurement and production time.',
  'Cycle Time': 'The total time taken to complete one cycle of a manufacturing process from start to finish.',
  'Throughput': 'The rate at which a manufacturing system produces goods, typically measured in units per time period.',
  'Bottleneck': 'A stage in the production process that limits the overall capacity and slows down the entire manufacturing flow.',
  'SOP': 'Standard Operating Procedure — a documented set of step-by-step instructions for carrying out routine operations.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for manufacturing / ERP site detection
// ---------------------------------------------------------------------------

const MANUFACTURING_HOSTNAMES = [
  'sap.com', 'oracle.com/erp', 'netsuite',
  'zoho.com/inventory', 'zoho.com/books',
  'tally', 'epicor', 'infor',
  'siemens/mindsphere', 'gecapital',
  'indiamart.com', 'tradeindia.com',
  'justdial.com/manufacturers',
  'alibaba.com', 'made-in-india',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Status label to accessible color-coded information. */
const STATUS_MAP: Record<string, { color: string; icon: string; ariaLabel: string }> = {
  'pending': { color: '#e69500', icon: '⏳', ariaLabel: 'Status: Pending — awaiting action' },
  'approved': { color: '#2e7d32', icon: '✅', ariaLabel: 'Status: Approved — item has been approved' },
  'rejected': { color: '#c62828', icon: '❌', ariaLabel: 'Status: Rejected — item was not approved' },
  'in transit': { color: '#1565c0', icon: '🚚', ariaLabel: 'Status: In Transit — shipment is on the way' },
  'in-transit': { color: '#1565c0', icon: '🚚', ariaLabel: 'Status: In Transit — shipment is on the way' },
  'delivered': { color: '#2e7d32', icon: '📦', ariaLabel: 'Status: Delivered — shipment has arrived' },
  'cancelled': { color: '#c62828', icon: '🚫', ariaLabel: 'Status: Cancelled — order has been cancelled' },
  'on hold': { color: '#e69500', icon: '⏸️', ariaLabel: 'Status: On Hold — processing is paused' },
  'completed': { color: '#2e7d32', icon: '✔️', ariaLabel: 'Status: Completed — process is finished' },
  'processing': { color: '#1565c0', icon: '⚙️', ariaLabel: 'Status: Processing — currently being worked on' },
  'draft': { color: '#757575', icon: '📝', ariaLabel: 'Status: Draft — not yet submitted' },
  'open': { color: '#1565c0', icon: '📂', ariaLabel: 'Status: Open — active and in progress' },
  'closed': { color: '#757575', icon: '📁', ariaLabel: 'Status: Closed — no longer active' },
};

/** Quantity unit conversions for human-readable display. */
const UNIT_CONVERSIONS: Record<string, { display: string; conversions: Array<{ factor: number; unit: string; display: string }> }> = {
  'kg': {
    display: 'kilograms',
    conversions: [
      { factor: 0.001, unit: 'tons', display: 'metric tons' },
      { factor: 1000, unit: 'g', display: 'grams' },
      { factor: 2.20462, unit: 'lbs', display: 'pounds' },
    ],
  },
  'ton': {
    display: 'metric tons',
    conversions: [
      { factor: 1000, unit: 'kg', display: 'kilograms' },
      { factor: 2204.62, unit: 'lbs', display: 'pounds' },
    ],
  },
  'tons': {
    display: 'metric tons',
    conversions: [
      { factor: 1000, unit: 'kg', display: 'kilograms' },
      { factor: 2204.62, unit: 'lbs', display: 'pounds' },
    ],
  },
  'pcs': {
    display: 'pieces',
    conversions: [
      { factor: 1 / 12, unit: 'dozen', display: 'dozens' },
      { factor: 1 / 144, unit: 'gross', display: 'gross (144 pcs)' },
    ],
  },
  'pieces': {
    display: 'pieces',
    conversions: [
      { factor: 1 / 12, unit: 'dozen', display: 'dozens' },
      { factor: 1 / 144, unit: 'gross', display: 'gross (144 pcs)' },
    ],
  },
  'm': {
    display: 'meters',
    conversions: [
      { factor: 100, unit: 'cm', display: 'centimeters' },
      { factor: 3.28084, unit: 'ft', display: 'feet' },
      { factor: 0.001, unit: 'km', display: 'kilometers' },
    ],
  },
  'meters': {
    display: 'meters',
    conversions: [
      { factor: 100, unit: 'cm', display: 'centimeters' },
      { factor: 3.28084, unit: 'ft', display: 'feet' },
    ],
  },
  'l': {
    display: 'liters',
    conversions: [
      { factor: 1000, unit: 'ml', display: 'milliliters' },
      { factor: 0.264172, unit: 'gal', display: 'US gallons' },
    ],
  },
  'liters': {
    display: 'liters',
    conversions: [
      { factor: 1000, unit: 'ml', display: 'milliliters' },
      { factor: 0.264172, unit: 'gal', display: 'US gallons' },
    ],
  },
  'litres': {
    display: 'litres',
    conversions: [
      { factor: 1000, unit: 'ml', display: 'millilitres' },
      { factor: 0.264172, unit: 'gal', display: 'US gallons' },
    ],
  },
};

// ---------------------------------------------------------------------------
// ManufacturingConnector
// ---------------------------------------------------------------------------

export class ManufacturingConnector implements DomainConnector {
  readonly id = 'manufacturing';
  readonly label = 'Manufacturing';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    // Hostname check
    if (MANUFACTURING_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic: manufacturing/ERP-specific form fields
    const formSignals = document.querySelectorAll(
      'input[name*="part_number"], input[name*="partno"], input[name*="partnumber"], ' +
      'input[name*="quantity"], input[name*="qty"], input[name*="warehouse"], ' +
      'input[name*="sku"], input[name*="batch"], input[name*="lot_number"], ' +
      'input[placeholder*="Part Number"], input[placeholder*="Quantity"], ' +
      'input[placeholder*="Warehouse"], input[placeholder*="SKU"], ' +
      '[data-field*="part"], [data-field*="quantity"], [data-field*="warehouse"]',
    );
    if (formSignals.length >= 2) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const mfgKeywords = [
      'purchase order', 'bill of materials', 'work order', 'inventory',
      'warehouse', 'supplier', 'vendor', 'material requisition',
      'goods receipt', 'production order',
    ];
    const matchCount = mfgKeywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Manufacturing domain connector activated');

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

    console.log('[AccessBridge] Manufacturing domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.enhanceDataTables();
    this.enhanceManufacturingForms();
    this.simplifyStatusIndicators();
    this.addQuantityUnitReaders();
    // --- Priority 4: Manufacturing deepening ---
    this.highlightHazards();
  }

  // --- Priority 4: Safety-hazard highlighter --------------------------------

  private highlightHazards(): void {
    if (document.querySelector('.ab-domain-hazard-banner')) return;

    const bodyText = (document.body?.textContent || '').slice(0, 20_000);
    const findings = detectHazardKeywords(bodyText);
    if (findings.length === 0) return;

    const hasDanger = findings.some((f) => f.level === 'danger');
    const banner = document.createElement('aside');
    banner.className = hasDanger
      ? 'ab-domain-hazard-banner ab-domain-hazard-banner-danger'
      : 'ab-domain-hazard-banner';
    banner.setAttribute('role', hasDanger ? 'alert' : 'status');
    banner.setAttribute('aria-label', 'Safety hazard keywords detected on this page');

    const title = document.createElement('div');
    title.className = 'ab-domain-hazard-title';
    title.textContent = hasDanger
      ? 'Danger-level safety keywords detected'
      : 'Safety / caution language on this page';
    banner.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'ab-domain-hazard-list';
    for (const f of findings.slice(0, 10)) {
      const li = document.createElement('li');
      li.dataset.level = f.level;
      li.textContent = f.keyword.toUpperCase();
      list.appendChild(li);
    }
    banner.appendChild(list);

    document.body.insertBefore(banner, document.body.firstChild);
    this.overlayElements.push(banner);
  }

  // ---- 1. ERP jargon decoder -----------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(MANUFACTURING_JARGON).join('|') + ')\\b',
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
        span.setAttribute('aria-label', `${term}: ${MANUFACTURING_JARGON[term]}`);
        span.setAttribute('data-ab-tooltip', MANUFACTURING_JARGON[term]);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = MANUFACTURING_JARGON[term];
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

  // ---- 2. Data table enhancer -----------------------------------------------

  private enhanceDataTables(): void {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-processed')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      // Detect manufacturing tables: inventory, orders, BOM, etc.
      const mfgTableKeywords = [
        'part', 'item', 'sku', 'quantity', 'qty', 'warehouse', 'location',
        'bom', 'material', 'supplier', 'vendor', 'order', 'status',
        'unit', 'price', 'cost', 'stock', 'batch', 'lot',
      ];
      const isManufacturingTable = mfgTableKeywords.some(kw => headers.some(h => h.includes(kw)));

      if (!isManufacturingTable || headers.length < 3) continue;
      table.classList.add('ab-domain-processed');

      // Add role for accessibility
      if (!table.getAttribute('role')) {
        table.setAttribute('role', 'grid');
      }

      // Add row highlighting on hover
      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        const htmlRow = row as HTMLElement;
        if (htmlRow.classList.contains('ab-domain-table-row')) continue;
        htmlRow.classList.add('ab-domain-table-row');
        htmlRow.setAttribute('tabindex', '0');

        const mouseEnterFn = (() => {
          htmlRow.style.backgroundColor = 'rgba(25, 118, 210, 0.08)';
          htmlRow.style.outline = '2px solid rgba(25, 118, 210, 0.3)';
        }) as EventListener;
        const mouseLeaveFn = (() => {
          htmlRow.style.backgroundColor = '';
          htmlRow.style.outline = '';
        }) as EventListener;

        htmlRow.addEventListener('mouseenter', mouseEnterFn);
        htmlRow.addEventListener('mouseleave', mouseLeaveFn);
        this.formListeners.push({ el: htmlRow, type: 'mouseenter', fn: mouseEnterFn });
        this.formListeners.push({ el: htmlRow, type: 'mouseleave', fn: mouseLeaveFn });
      }

      // Add column sorting indicators to headers
      const headerCells = table.querySelectorAll('th');
      for (const th of headerCells) {
        const htmlTh = th as HTMLElement;
        if (htmlTh.querySelector('.ab-domain-sort-indicator')) continue;

        const sortIndicator = document.createElement('span');
        sortIndicator.className = 'ab-domain-sort-indicator';
        sortIndicator.textContent = ' ⇅';
        sortIndicator.setAttribute('aria-hidden', 'true');
        sortIndicator.style.opacity = '0.4';
        sortIndicator.style.fontSize = '0.8em';
        htmlTh.appendChild(sortIndicator);
        htmlTh.setAttribute('aria-sort', 'none');
        htmlTh.style.cursor = 'pointer';
        this.overlayElements.push(sortIndicator);
      }

      // Add summary row badge with row count
      const tbody = table.querySelector('tbody') || table;
      const dataRows = tbody.querySelectorAll('tr');
      const rowCount = dataRows.length;
      if (rowCount > 0) {
        const badge = document.createElement('div');
        badge.className = 'ab-domain-table-summary';
        badge.setAttribute('role', 'status');
        badge.setAttribute('aria-live', 'polite');
        badge.textContent = `${rowCount} row${rowCount !== 1 ? 's' : ''} in table`;
        badge.style.padding = '4px 8px';
        badge.style.fontSize = '0.85em';
        badge.style.color = '#555';
        badge.style.borderTop = '1px solid #ddd';
        badge.style.backgroundColor = '#f9f9f9';

        // Calculate numeric column summaries
        const qtyIdx = headers.findIndex(h => h.includes('quantity') || h.includes('qty') || h.includes('stock'));
        if (qtyIdx >= 0) {
          let total = 0;
          for (const row of dataRows) {
            const cells = row.querySelectorAll('td');
            if (cells[qtyIdx]) {
              const val = parseFloat((cells[qtyIdx].textContent || '').replace(/[^0-9.-]/g, ''));
              if (!isNaN(val)) total += val;
            }
          }
          if (total > 0) {
            badge.textContent += ` | Total quantity: ${total.toLocaleString('en-IN')}`;
          }
        }

        table.parentElement?.insertBefore(badge, table.nextSibling);
        this.overlayElements.push(badge);
      }
    }
  }

  // ---- 3. Form assistance ---------------------------------------------------

  private enhanceManufacturingForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let mfgFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label}`;

        const fieldInfo = this.identifyManufacturingField(combined);
        if (fieldInfo) {
          mfgFieldCount++;
          this.enhanceField(el, fieldInfo);
        }
      }

      if (mfgFieldCount >= 2) {
        form.classList.add('ab-domain-processed');
        this.addFormStepGuide(form);
      }
    }
  }

  private identifyManufacturingField(text: string): { label: string; hint: string; pattern?: RegExp } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string; pattern?: RegExp }> = [
      {
        keywords: ['part_number', 'partno', 'partnumber', 'part number', 'part no'],
        label: 'Part Number',
        hint: 'Enter the unique part number or item code (e.g. PN-2024-0001)',
        pattern: /^[A-Za-z0-9\-_/.]+$/,
      },
      {
        keywords: ['sku'],
        label: 'SKU',
        hint: 'Stock Keeping Unit — unique product identifier for inventory tracking',
        pattern: /^[A-Za-z0-9\-_]+$/,
      },
      {
        keywords: ['quantity', 'qty'],
        label: 'Quantity',
        hint: 'Enter the number of units (must be a positive number)',
        pattern: /^\d+(\.\d{1,3})?$/,
      },
      {
        keywords: ['warehouse', 'location', 'store'],
        label: 'Warehouse / Location',
        hint: 'Select or enter the warehouse or storage location code',
      },
      {
        keywords: ['batch', 'lot_number', 'lot no', 'lotno'],
        label: 'Batch / Lot Number',
        hint: 'Enter the production batch or lot number for traceability',
        pattern: /^[A-Za-z0-9\-_/.]+$/,
      },
      {
        keywords: ['supplier', 'vendor'],
        label: 'Supplier / Vendor',
        hint: 'Name or code of the supplier or vendor',
      },
      {
        keywords: ['unit', 'uom', 'unit of measure'],
        label: 'Unit of Measure',
        hint: 'Measurement unit — e.g. kg, pcs, meters, liters, tons',
      },
      {
        keywords: ['delivery_date', 'delivery date', 'due_date', 'due date', 'expected_date'],
        label: 'Delivery / Due Date',
        hint: 'Enter the expected delivery or due date (DD/MM/YYYY)',
        pattern: /^\d{2}\/\d{2}\/\d{4}$/,
      },
      {
        keywords: ['po_number', 'purchase_order', 'purchase order', 'po no'],
        label: 'Purchase Order Number',
        hint: 'Enter the purchase order reference number',
        pattern: /^[A-Za-z0-9\-_/.]+$/,
      },
      {
        keywords: ['description', 'item_desc', 'material_desc'],
        label: 'Item Description',
        hint: 'Brief description of the material, component, or product',
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

    // Quantity field: add live unit conversion
    if (info.label === 'Quantity') {
      const qtyReadFn = (() => {
        const val = parseFloat(el.value);
        const existing = el.parentElement?.querySelector('.ab-domain-qty-words');
        if (isNaN(val) || val === 0) {
          existing?.remove();
          return;
        }
        const readable = `${val.toLocaleString('en-IN')} units`;
        if (existing) {
          existing.textContent = readable;
        } else {
          const wordEl = document.createElement('div');
          wordEl.className = 'ab-domain-qty-words';
          wordEl.setAttribute('aria-live', 'polite');
          wordEl.textContent = readable;
          el.parentElement?.appendChild(wordEl);
          this.overlayElements.push(wordEl);
        }
      }) as EventListener;

      el.addEventListener('input', qtyReadFn);
      this.formListeners.push({ el, type: 'input', fn: qtyReadFn });
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

  // ---- 4. Status indicator simplifier ----------------------------------------

  private simplifyStatusIndicators(): void {
    // Find status badges and cells across the page
    const statusSelectors = [
      '[class*="status"]', '[class*="badge"]', '[class*="tag"]',
      '[data-status]', '[data-state]',
      'td:nth-child(1)', // will be filtered by content
    ];

    const candidates = document.querySelectorAll(statusSelectors.slice(0, 5).join(', '));
    for (const el of candidates) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.classList.contains('ab-domain-processed')) continue;

      const text = (htmlEl.textContent || '').trim().toLowerCase();
      const statusInfo = STATUS_MAP[text];
      if (!statusInfo) continue;

      htmlEl.classList.add('ab-domain-processed');

      // Add accessible color-coded indicator
      const indicator = document.createElement('span');
      indicator.className = 'ab-domain-status-indicator';
      indicator.setAttribute('role', 'img');
      indicator.setAttribute('aria-label', statusInfo.ariaLabel);
      indicator.textContent = ` ${statusInfo.icon}`;
      indicator.style.marginLeft = '4px';

      // Add color hint border
      htmlEl.style.borderLeft = `3px solid ${statusInfo.color}`;
      htmlEl.style.paddingLeft = '6px';

      htmlEl.appendChild(indicator);
      this.overlayElements.push(indicator);
    }

    // Also scan table cells for status columns
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const statusIdx = headers.findIndex(h => h.includes('status') || h.includes('state') || h.includes('stage'));
      if (statusIdx < 0) continue;

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (!cells[statusIdx]) continue;

        const cell = cells[statusIdx] as HTMLElement;
        if (cell.classList.contains('ab-domain-status-processed')) continue;

        const text = (cell.textContent || '').trim().toLowerCase();
        const statusInfo = STATUS_MAP[text];
        if (!statusInfo) continue;

        cell.classList.add('ab-domain-status-processed');

        const indicator = document.createElement('span');
        indicator.className = 'ab-domain-status-indicator';
        indicator.setAttribute('role', 'img');
        indicator.setAttribute('aria-label', statusInfo.ariaLabel);
        indicator.textContent = ` ${statusInfo.icon}`;
        indicator.style.marginLeft = '4px';

        cell.style.borderLeft = `3px solid ${statusInfo.color}`;
        cell.style.paddingLeft = '6px';

        cell.appendChild(indicator);
        this.overlayElements.push(indicator);
      }
    }
  }

  // ---- 5. Quantity unit reader -----------------------------------------------

  private addQuantityUnitReaders(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    // Match patterns like "500 kg", "1,200 pcs", "25.5 meters", "100 liters"
    const qtyPattern = /(\d[\d,]*(?:\.\d+)?)\s*(kg|tons?|pcs|pieces|m|meters?|l|liters?|litres?)\b/gi;

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, .ab-domain-qty-tag, script, style') ||
        node.parentElement?.classList.contains('ab-domain-qty-tag')
      ) continue;
      if (qtyPattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      qtyPattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-qty-tag') || parent.classList.contains('ab-domain-processed')) continue;

      const text = textNode.textContent || '';
      qtyPattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let replaced = false;

      while ((match = qtyPattern.exec(text)) !== null) {
        const numStr = match[1].replace(/,/g, '');
        const value = parseFloat(numStr);
        const unitKey = match[2].toLowerCase();
        const unitInfo = UNIT_CONVERSIONS[unitKey];
        if (isNaN(value) || !unitInfo) continue;

        replaced = true;

        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        // Build human-readable conversion string
        const conversionParts = unitInfo.conversions
          .map(c => {
            const converted = value * c.factor;
            // Only show meaningful conversions (avoid very small or very large numbers)
            if (converted < 0.001 || converted > 1_000_000_000) return null;
            return `${converted.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${c.display}`;
          })
          .filter(Boolean);

        const readableValue = `${value.toLocaleString('en-IN')} ${unitInfo.display}`;
        const conversionText = conversionParts.length > 0
          ? `${readableValue} (${conversionParts.join(', ')})`
          : readableValue;

        const span = document.createElement('span');
        span.className = 'ab-domain-qty-tag';
        span.textContent = match[0];
        span.setAttribute('tabindex', '0');
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `${match[0]} — ${conversionText}`);
        span.setAttribute('data-ab-tooltip', conversionText);

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = conversionText;
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
