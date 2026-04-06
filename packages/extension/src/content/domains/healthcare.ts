/**
 * AccessBridge — Healthcare Domain Connector v0
 *
 * Detects healthcare/hospital/pharmacy websites and provides accessibility adaptations:
 *   - Medical jargon decoder (tooltips for healthcare terms)
 *   - Appointment form assistant (hints, step guidance)
 *   - Medicine information simplifier (dosage info, generic alternatives)
 *   - Lab report reader (normal-range indicators)
 *   - Emergency contact highlight (click-to-call styling)
 */

import type { DomainConnector } from './index.js';

// ---------------------------------------------------------------------------
// Healthcare jargon glossary
// ---------------------------------------------------------------------------

const HEALTHCARE_JARGON: Record<string, string> = {
  'OPD': 'Outpatient Department — where patients visit for consultation without being admitted to the hospital.',
  'IPD': 'Inpatient Department — where patients are admitted and stay in the hospital for treatment.',
  'ICU': 'Intensive Care Unit — a specialized ward for critically ill patients requiring close monitoring.',
  'EMR': 'Electronic Medical Record — a digital version of your paper medical chart maintained by a healthcare provider.',
  'ABHA': 'Ayushman Bharat Health Account — a 14-digit unique health ID for every Indian citizen under the National Digital Health Mission.',
  'PMJAY': 'Pradhan Mantri Jan Arogya Yojana — government health insurance scheme providing ₹5 lakh cover per family per year for secondary and tertiary care.',
  'CGHS': 'Central Government Health Scheme — healthcare scheme for central government employees, pensioners, and their dependents.',
  'ECHS': 'Ex-Servicemen Contributory Health Scheme — healthcare scheme for ex-servicemen and their dependents.',
  'TPA': 'Third Party Administrator — an intermediary between the insurance company and the hospital that processes your health insurance claims.',
  'Co-pay': 'Co-pay — the fixed percentage of a medical bill you must pay out of pocket even when insured.',
  'Deductible': 'Deductible — the amount you pay for healthcare services before your insurance starts covering costs.',
  'Pre-authorization': 'Pre-authorization — approval required from your insurance company before a planned hospital admission or procedure.',
  'Discharge Summary': 'Discharge Summary — a document given at the time of leaving the hospital summarizing your diagnosis, treatment, and follow-up instructions.',
  'Referral': 'Referral — a recommendation from one doctor to see a specialist or visit another healthcare facility.',
  'Triage': 'Triage — the process of sorting patients based on urgency of their medical condition to decide who gets treated first.',
  'Diagnosis': 'Diagnosis — the identification of a disease or condition based on symptoms, tests, and medical history.',
  'Prognosis': 'Prognosis — the likely course and expected outcome of a disease or condition.',
  'Generic Drug': 'Generic Drug — a medicine with the same active ingredient as a brand-name drug but sold at a lower cost.',
  'Brand Drug': 'Brand Drug — a medicine sold under a specific trade name by a pharmaceutical company, usually more expensive than its generic equivalent.',
  'Dosage': 'Dosage — the prescribed amount and frequency of a medicine to be taken (e.g. 500mg twice daily).',
  'Contraindication': 'Contraindication — a condition or factor that makes a particular treatment or medicine inadvisable.',
  'Adverse Reaction': 'Adverse Reaction — an unwanted or harmful effect experienced after taking a medicine or undergoing a treatment.',
  'Lab Report': 'Lab Report — a document showing results of laboratory tests performed on blood, urine, or other samples.',
  'Pathology': 'Pathology — the branch of medicine that examines tissues, organs, and body fluids to diagnose disease.',
  'Radiology': 'Radiology — the branch of medicine using imaging techniques like X-ray, CT scan, MRI, and ultrasound for diagnosis.',
};

// ---------------------------------------------------------------------------
// Hostname patterns for healthcare site detection
// ---------------------------------------------------------------------------

const HEALTHCARE_HOSTNAMES = [
  'practo.com', '1mg.com', 'pharmeasy.com', 'netmeds.com',
  'apollopharmacy', 'medplusmart', 'healthkart', 'lybrate.com',
  'credihealth.com', 'nhp.gov.in', 'cowin.gov.in', 'abha.abdm.gov.in',
  'pmjay.gov.in', 'aiims', 'apollo', 'fortis', 'maxhealthcare',
  'manipalhospitals', 'medanta', 'narayanahealth',
];

// ---------------------------------------------------------------------------
// Lab value reference ranges
// ---------------------------------------------------------------------------

interface LabRange {
  unit: string;
  low: number;
  high: number;
  label: string;
}

const LAB_REFERENCE_RANGES: Record<string, LabRange> = {
  'hemoglobin': { unit: 'g/dL', low: 12.0, high: 17.5, label: 'Hemoglobin' },
  'haemoglobin': { unit: 'g/dL', low: 12.0, high: 17.5, label: 'Haemoglobin' },
  'hb': { unit: 'g/dL', low: 12.0, high: 17.5, label: 'Hemoglobin' },
  'blood sugar': { unit: 'mg/dL', low: 70, high: 140, label: 'Blood Sugar' },
  'fasting glucose': { unit: 'mg/dL', low: 70, high: 100, label: 'Fasting Glucose' },
  'fasting blood sugar': { unit: 'mg/dL', low: 70, high: 100, label: 'Fasting Blood Sugar' },
  'random blood sugar': { unit: 'mg/dL', low: 70, high: 140, label: 'Random Blood Sugar' },
  'cholesterol': { unit: 'mg/dL', low: 0, high: 200, label: 'Total Cholesterol' },
  'total cholesterol': { unit: 'mg/dL', low: 0, high: 200, label: 'Total Cholesterol' },
  'hdl': { unit: 'mg/dL', low: 40, high: 60, label: 'HDL Cholesterol' },
  'ldl': { unit: 'mg/dL', low: 0, high: 100, label: 'LDL Cholesterol' },
  'triglycerides': { unit: 'mg/dL', low: 0, high: 150, label: 'Triglycerides' },
  'creatinine': { unit: 'mg/dL', low: 0.6, high: 1.2, label: 'Creatinine' },
  'urea': { unit: 'mg/dL', low: 7, high: 20, label: 'Blood Urea' },
  'bilirubin': { unit: 'mg/dL', low: 0.1, high: 1.2, label: 'Bilirubin' },
  'sgpt': { unit: 'U/L', low: 7, high: 56, label: 'SGPT (ALT)' },
  'sgot': { unit: 'U/L', low: 10, high: 40, label: 'SGOT (AST)' },
  'platelet': { unit: 'lakh/μL', low: 1.5, high: 4.0, label: 'Platelet Count' },
  'wbc': { unit: 'cells/μL', low: 4000, high: 11000, label: 'White Blood Cells' },
  'rbc': { unit: 'million/μL', low: 4.2, high: 5.9, label: 'Red Blood Cells' },
  'tsh': { unit: 'mIU/L', low: 0.4, high: 4.0, label: 'TSH (Thyroid)' },
  'hba1c': { unit: '%', low: 4.0, high: 5.7, label: 'HbA1c' },
  'vitamin d': { unit: 'ng/mL', low: 30, high: 100, label: 'Vitamin D' },
  'vitamin b12': { unit: 'pg/mL', low: 200, high: 900, label: 'Vitamin B12' },
  'iron': { unit: 'μg/dL', low: 60, high: 170, label: 'Serum Iron' },
  'calcium': { unit: 'mg/dL', low: 8.5, high: 10.5, label: 'Calcium' },
  'uric acid': { unit: 'mg/dL', low: 2.4, high: 7.0, label: 'Uric Acid' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function classifyLabValue(value: number, range: LabRange): 'Low' | 'Normal' | 'High' {
  if (value < range.low) return 'Low';
  if (value > range.high) return 'High';
  return 'Normal';
}

// ---------------------------------------------------------------------------
// HealthcareConnector
// ---------------------------------------------------------------------------

export class HealthcareConnector implements DomainConnector {
  readonly id = 'healthcare';
  readonly label = 'Healthcare';

  private active = false;
  private observer: MutationObserver | null = null;
  private tooltipElements: HTMLElement[] = [];
  private overlayElements: HTMLElement[] = [];
  private formListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  // ---- Detection -----------------------------------------------------------

  detect(): boolean {
    const { hostname, href } = window.location;

    // Hostname check
    if (HEALTHCARE_HOSTNAMES.some(h => hostname.includes(h) || href.includes(h))) {
      return true;
    }

    // DOM heuristic: healthcare-specific form fields and elements
    const formSignals = document.querySelectorAll(
      'input[name*="appointment"], input[name*="patient"], input[name*="doctor"], ' +
      'input[name*="prescription"], input[name*="medicine"], input[name*="dosage"], ' +
      'input[placeholder*="Patient"], input[placeholder*="Doctor"], ' +
      'input[type="file"][accept*="image"], input[type="file"][accept*="pdf"], ' +
      '[data-field*="appointment"], [data-field*="patient"], [data-field*="doctor"]',
    );
    if (formSignals.length >= 2) return true;

    // Text heuristic
    const bodyText = (document.body?.textContent || '').slice(0, 5000).toLowerCase();
    const healthKeywords = [
      'appointment', 'prescription', 'doctor', 'patient',
      'medicine', 'dosage', 'diagnosis', 'hospital',
      'pharmacy', 'lab report', 'opd', 'ipd',
    ];
    const matchCount = healthKeywords.filter(kw => bodyText.includes(kw)).length;
    if (matchCount >= 3) return true;

    return false;
  }

  // ---- Lifecycle -----------------------------------------------------------

  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[AccessBridge] Healthcare domain connector activated');

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

    console.log('[AccessBridge] Healthcare domain connector deactivated');
  }

  // ---- Core scan -----------------------------------------------------------

  private scanAndEnhance(): void {
    this.addJargonTooltips();
    this.enhanceAppointmentForms();
    this.simplifyMedicineInfo();
    this.enhanceLabReports();
    this.highlightEmergencyContacts();
  }

  // ---- 1. Medical jargon decoder -------------------------------------------

  private addJargonTooltips(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const termsPattern = new RegExp(
      '\\b(' + Object.keys(HEALTHCARE_JARGON).join('|').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\b/g, '') + ')\\b',
      'gi',
    );

    // Build a simpler pattern: escape special regex chars in keys, then join
    const escapedKeys = Object.keys(HEALTHCARE_JARGON).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp('\\b(' + escapedKeys.join('|') + ')\\b', 'gi');

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, script, style, .ab-domain-processed') ||
        node.parentElement?.classList.contains('ab-domain-jargon')
      ) continue;
      if (pattern.test(node.textContent || '')) {
        textNodes.push(node);
      }
      pattern.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-jargon')) continue;

      const text = textNode.textContent || '';
      pattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        // Text before match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const term = match[1];
        // Look up the jargon definition (case-insensitive key match)
        const jargonKey = Object.keys(HEALTHCARE_JARGON).find(
          k => k.toLowerCase() === term.toLowerCase(),
        );
        const definition = jargonKey ? HEALTHCARE_JARGON[jargonKey] : term;

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

  // ---- 2. Appointment form assistant ---------------------------------------

  private enhanceAppointmentForms(): void {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.classList.contains('ab-domain-processed')) continue;

      const inputs = form.querySelectorAll('input, select, textarea');
      let appointmentFieldCount = 0;

      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name = (el.name || '').toLowerCase();
        const placeholder = (el.placeholder || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const type = (el.type || '').toLowerCase();
        const combined = `${name} ${placeholder} ${label} ${type}`;

        const fieldInfo = this.identifyAppointmentField(combined);
        if (fieldInfo) {
          appointmentFieldCount++;
          this.enhanceField(el, fieldInfo);
        }
      }

      if (appointmentFieldCount >= 2) {
        form.classList.add('ab-domain-processed');
        this.addFormStepGuide(form);
      }
    }
  }

  private identifyAppointmentField(text: string): { label: string; hint: string; pattern?: RegExp } | null {
    const fields: Array<{ keywords: string[]; label: string; hint: string; pattern?: RegExp }> = [
      {
        keywords: ['patient', 'name', 'full name'],
        label: 'Patient Name',
        hint: 'Enter the full name of the patient as on their ID',
      },
      {
        keywords: ['date', 'appointment date', 'preferred date'],
        label: 'Appointment Date',
        hint: 'Select the preferred date for your appointment',
      },
      {
        keywords: ['time', 'slot', 'appointment time', 'preferred time'],
        label: 'Appointment Time',
        hint: 'Select a convenient time slot for your visit',
      },
      {
        keywords: ['department', 'speciality', 'specialty', 'dept'],
        label: 'Department / Speciality',
        hint: 'Choose the department or speciality (e.g. Cardiology, Orthopaedics, General Medicine)',
      },
      {
        keywords: ['doctor', 'physician', 'consultant'],
        label: 'Doctor / Consultant',
        hint: 'Select or enter the name of the doctor you wish to consult',
      },
      {
        keywords: ['phone', 'mobile', 'contact'],
        label: 'Contact Number',
        hint: '10-digit mobile number for appointment confirmation',
        pattern: /^[6-9]\d{9}$/,
      },
      {
        keywords: ['email'],
        label: 'Email Address',
        hint: 'Email address for appointment confirmation and reports',
      },
      {
        keywords: ['age'],
        label: 'Patient Age',
        hint: 'Age of the patient in years',
        pattern: /^\d{1,3}$/,
      },
      {
        keywords: ['gender', 'sex'],
        label: 'Gender',
        hint: 'Select the gender of the patient',
      },
      {
        keywords: ['abha', 'health id', 'healthid'],
        label: 'ABHA Number',
        hint: 'Your 14-digit Ayushman Bharat Health Account number (if available)',
        pattern: /^\d{14}$/,
      },
      {
        keywords: ['symptom', 'complaint', 'reason', 'problem'],
        label: 'Symptoms / Reason for Visit',
        hint: 'Briefly describe your symptoms or the reason for your appointment',
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
    guide.setAttribute('aria-label', 'Appointment form step indicator');

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

  // ---- 3. Medicine information simplifier ----------------------------------

  private simplifyMedicineInfo(): void {
    // Find medicine listing cards/containers
    const medicineContainers = document.querySelectorAll(
      '[class*="medicine"], [class*="drug"], [class*="product-card"], ' +
      '[data-type*="medicine"], [data-type*="drug"], [class*="pharma"], ' +
      '[class*="med-card"], [class*="med-info"]',
    );

    for (const container of medicineContainers) {
      if ((container as HTMLElement).classList.contains('ab-domain-processed')) continue;
      (container as HTMLElement).classList.add('ab-domain-processed');
      this.addMedicineEnhancements(container as HTMLElement);
    }

    // Also scan tables that may contain medicine/prescription info
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.classList.contains('ab-domain-processed')) continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isMedicine = ['medicine', 'drug', 'tablet', 'dosage', 'dose', 'frequency', 'prescription']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isMedicine) continue;
      table.classList.add('ab-domain-processed');

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        if (row.querySelector('.ab-domain-med-summary')) continue;
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        const rowText = (row.textContent || '').toLowerCase();
        const summary = this.buildMedicineSummary(rowText, cells);
        if (summary) {
          const badge = document.createElement('div');
          badge.className = 'ab-domain-med-summary';
          badge.setAttribute('role', 'note');
          badge.setAttribute('aria-label', summary);
          badge.textContent = summary;
          cells[0].appendChild(badge);
          this.overlayElements.push(badge);
        }
      }
    }

    // Scan for generic vs brand drug info in text
    this.addGenericAlternativeBadges();
  }

  private addMedicineEnhancements(container: HTMLElement): void {
    const text = (container.textContent || '').toLowerCase();

    // Look for dosage information and simplify
    const dosagePattern = /(\d+\s*(?:mg|ml|mcg|g|iu))/gi;
    const frequencyPattern = /(?:once|twice|thrice|(\d+)\s*times?)\s*(?:a|per)\s*day/gi;

    const hasDosage = dosagePattern.test(text);
    const hasFrequency = frequencyPattern.test(text);

    if (hasDosage || hasFrequency) {
      if (!container.querySelector('.ab-domain-med-helper')) {
        const helper = document.createElement('div');
        helper.className = 'ab-domain-med-helper';
        helper.setAttribute('role', 'note');

        let helperText = 'Dosage info: ';
        dosagePattern.lastIndex = 0;
        const dosageMatch = dosagePattern.exec(text);
        if (dosageMatch) helperText += dosageMatch[1] + ' ';

        frequencyPattern.lastIndex = 0;
        const freqMatch = frequencyPattern.exec(text);
        if (freqMatch) helperText += freqMatch[0];

        helper.textContent = helperText.trim();
        helper.setAttribute('aria-label', helperText.trim());
        container.appendChild(helper);
        this.overlayElements.push(helper);
      }
    }
  }

  private buildMedicineSummary(rowText: string, cells: NodeListOf<HTMLTableCellElement>): string | null {
    const dosagePattern = /(\d+\s*(?:mg|ml|mcg|g|iu))/i;
    const dosageMatch = dosagePattern.exec(rowText);
    if (!dosageMatch) return null;

    const medName = (cells[0].textContent || '').trim();
    const dosage = dosageMatch[1];

    let frequency = '';
    const freqPattern = /(?:once|twice|thrice|(\d+)\s*times?)\s*(?:a|per)\s*day/i;
    const freqMatch = freqPattern.exec(rowText);
    if (freqMatch) frequency = ` — ${freqMatch[0]}`;

    return `${medName}: ${dosage}${frequency}`;
  }

  private addGenericAlternativeBadges(): void {
    // Find elements that mention "brand" or specific drug brand indicators
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const brandPattern = /\b(brand\s*:?\s*|branded|brand\s+name)\b/gi;

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, script, style, .ab-domain-processed') ||
        node.parentElement?.classList.contains('ab-domain-generic-badge')
      ) continue;

      const text = node.textContent || '';
      brandPattern.lastIndex = 0;
      if (brandPattern.test(text)) {
        const parent = node.parentElement;
        if (!parent || parent.querySelector('.ab-domain-generic-badge')) continue;

        const badge = document.createElement('span');
        badge.className = 'ab-domain-generic-badge';
        badge.textContent = 'Ask for Generic Alternative';
        badge.setAttribute('role', 'note');
        badge.setAttribute('aria-label', 'Tip: Ask your doctor or pharmacist about a lower-cost generic alternative to this brand medicine.');
        badge.setAttribute('tabindex', '0');

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = 'Tip: Ask your doctor or pharmacist about a lower-cost generic alternative to this brand medicine.';
        badge.appendChild(tooltip);

        parent.appendChild(badge);
        parent.classList.add('ab-domain-processed');
        this.tooltipElements.push(badge);
      }
    }
  }

  // ---- 4. Lab report reader ------------------------------------------------

  private enhanceLabReports(): void {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.getAttribute('data-ab-lab') === 'true') continue;

      const headers = Array.from(table.querySelectorAll('th, thead td')).map(
        th => (th.textContent || '').toLowerCase(),
      );

      const isLabReport = ['test', 'parameter', 'result', 'value', 'reference', 'range', 'unit']
        .some(kw => headers.some(h => h.includes(kw)));

      if (!isLabReport) continue;
      table.setAttribute('data-ab-lab', 'true');

      // Find column indices
      const testIdx = headers.findIndex(h =>
        h.includes('test') || h.includes('parameter') || h.includes('investigation'),
      );
      const valueIdx = headers.findIndex(h =>
        h.includes('result') || h.includes('value') || h.includes('observed'),
      );

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      for (const row of rows) {
        if (row.querySelector('.ab-domain-lab-badge')) continue;
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        const testName = (testIdx >= 0 && cells[testIdx]
          ? cells[testIdx].textContent || ''
          : cells[0].textContent || ''
        ).trim().toLowerCase();

        const valueText = (valueIdx >= 0 && cells[valueIdx]
          ? cells[valueIdx].textContent || ''
          : cells[1]?.textContent || ''
        ).trim();

        const numericValue = parseFloat(valueText.replace(/[^0-9.]/g, ''));
        if (isNaN(numericValue)) continue;

        // Match against known lab ranges
        const rangeKey = Object.keys(LAB_REFERENCE_RANGES).find(k => testName.includes(k));
        if (!rangeKey) continue;

        const range = LAB_REFERENCE_RANGES[rangeKey];
        const classification = classifyLabValue(numericValue, range);

        const badge = document.createElement('span');
        badge.className = `ab-domain-lab-badge ab-domain-lab-${classification.toLowerCase()}`;
        badge.textContent = classification;
        badge.setAttribute('role', 'note');
        badge.setAttribute('tabindex', '0');
        badge.setAttribute(
          'aria-label',
          `${range.label}: ${numericValue} ${range.unit} — ${classification}. Normal range: ${range.low}–${range.high} ${range.unit}`,
        );

        const tooltip = document.createElement('span');
        tooltip.className = 'ab-domain-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = `Normal range: ${range.low}–${range.high} ${range.unit}`;
        badge.appendChild(tooltip);

        const targetCell = cells[valueIdx >= 0 ? valueIdx : 1] || cells[0];
        targetCell.appendChild(badge);
        this.tooltipElements.push(badge);
      }
    }

    // Also scan non-table lab results (div-based layouts)
    this.scanDivBasedLabResults();
  }

  private scanDivBasedLabResults(): void {
    const labContainers = document.querySelectorAll(
      '[class*="lab-result"], [class*="test-result"], [class*="report-value"], ' +
      '[data-type*="lab"], [data-type*="report"]',
    );

    for (const container of labContainers) {
      if ((container as HTMLElement).getAttribute('data-ab-lab') === 'true') continue;
      (container as HTMLElement).setAttribute('data-ab-lab', 'true');

      const text = (container.textContent || '').toLowerCase();

      for (const [key, range] of Object.entries(LAB_REFERENCE_RANGES)) {
        if (!text.includes(key)) continue;

        // Try to find numeric value near the test name
        const valuePattern = new RegExp(key + '[^0-9]*([0-9]+\\.?[0-9]*)', 'i');
        const match = valuePattern.exec(text);
        if (!match) continue;

        const value = parseFloat(match[1]);
        if (isNaN(value)) continue;

        const classification = classifyLabValue(value, range);
        const badge = document.createElement('span');
        badge.className = `ab-domain-lab-badge ab-domain-lab-${classification.toLowerCase()}`;
        badge.textContent = `${range.label}: ${classification}`;
        badge.setAttribute('role', 'note');
        badge.setAttribute('tabindex', '0');
        badge.setAttribute(
          'aria-label',
          `${range.label}: ${value} ${range.unit} — ${classification}. Normal range: ${range.low}–${range.high} ${range.unit}`,
        );

        (container as HTMLElement).appendChild(badge);
        this.overlayElements.push(badge);
      }
    }
  }

  // ---- 5. Emergency contact highlight --------------------------------------

  private highlightEmergencyContacts(): void {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    // Patterns for emergency numbers and helplines
    const emergencyPatterns = [
      // Indian emergency numbers
      /\b(112|100|101|102|108|1066|1075|1098|1800[- ]?\d{3}[- ]?\d{4})\b/g,
      // Phone numbers near emergency keywords
      /(?:emergency|ambulance|helpline|toll[- ]?free|distress)[^0-9]{0,30}(\+?91[- ]?\d{10}|\d{10,11})/gi,
      // Phone numbers before emergency keywords
      /(\+?91[- ]?\d{10}|\d{10,11})[^a-zA-Z]{0,30}(?:emergency|ambulance|helpline|toll[- ]?free)/gi,
    ];

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.parentElement?.closest('.ab-domain-tooltip, .ab-domain-overlay, script, style, .ab-domain-processed, .ab-domain-emergency') ||
        node.parentElement?.classList.contains('ab-domain-emergency')
      ) continue;

      const text = node.textContent || '';
      const hasEmergency = emergencyPatterns.some(p => {
        p.lastIndex = 0;
        return p.test(text);
      });

      if (hasEmergency) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.classList.contains('ab-domain-emergency')) continue;

      const text = textNode.textContent || '';
      // Find all phone numbers in the text
      const phonePattern = /\b(\+?91[- ]?\d{10}|\d{10,11}|112|100|101|102|108|1066|1075|1098|1800[- ]?\d{3}[- ]?\d{4})\b/g;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let replaced = false;

      while ((match = phonePattern.exec(text)) !== null) {
        replaced = true;

        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const phone = match[1].replace(/[- ]/g, '');
        const displayPhone = match[1];

        const link = document.createElement('a');
        link.className = 'ab-domain-emergency';
        link.href = `tel:${phone}`;
        link.textContent = displayPhone;
        link.setAttribute('role', 'link');
        link.setAttribute('tabindex', '0');
        link.setAttribute('aria-label', `Emergency contact: ${displayPhone}. Click or press Enter to call.`);
        link.title = `Call ${displayPhone}`;

        // Add a visual emergency indicator
        const icon = document.createElement('span');
        icon.className = 'ab-domain-emergency-icon';
        icon.textContent = '\u260E'; // ☎ telephone sign
        icon.setAttribute('aria-hidden', 'true');
        link.insertBefore(icon, link.firstChild);

        fragment.appendChild(link);
        this.overlayElements.push(link);

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
