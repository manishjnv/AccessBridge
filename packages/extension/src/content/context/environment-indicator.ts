/**
 * Subtle floating indicator that shows when the environment sensor is active.
 * Bottom-left pill with sun/mic/wifi icons; inactive icons fade to 0.3 opacity.
 * Auto-reveals for 3 seconds on start, then fades to opacity 0; reveals again on hover.
 */

import type { EnvironmentSensor } from './environment-sensor.js';

const INITIAL_REVEAL_MS = 3000;

export class EnvironmentIndicator {
  private el: HTMLDivElement | null = null;
  private tooltipEl: HTMLDivElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private sensor: EnvironmentSensor | null = null;

  attach(sensor: EnvironmentSensor): void {
    if (this.el) return;
    this.sensor = sensor;

    const el = document.createElement('div');
    el.className = 'a11y-env-indicator';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'AccessBridge environment sensing active');

    const lightIcon = this.makeIcon(
      'light',
      'M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414M12 7a5 5 0 100 10 5 5 0 000-10z',
      sensor.isLightActive(),
    );
    const micIcon = this.makeIcon(
      'noise',
      'M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zm-7 9a7 7 0 0014 0M12 19v3',
      sensor.isNoiseActive(),
    );
    const netIcon = this.makeIcon(
      'network',
      'M5 12.55a11 11 0 0114 0M1.42 9a16 16 0 0121.17 0M8.53 16.11a6 6 0 016.95 0M12 20h.01',
      true,
    );

    el.appendChild(lightIcon);
    el.appendChild(micIcon);
    el.appendChild(netIcon);

    const tooltip = document.createElement('div');
    tooltip.className = 'a11y-env-tooltip';
    tooltip.textContent =
      'AccessBridge senses ambient light and noise every 15-30 seconds to adapt contrast, text size, and voice reliability. No images or audio are stored.';
    el.appendChild(tooltip);
    this.tooltipEl = tooltip;

    document.body.appendChild(el);
    this.el = el;

    this.reveal();
    this.hideTimer = setTimeout(() => this.fade(), INITIAL_REVEAL_MS);
  }

  private makeIcon(kind: 'light' | 'noise' | 'network', pathD: string, active: boolean): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `a11y-env-icon a11y-env-icon--${kind}${active ? '' : ' inactive'}`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  refresh(): void {
    if (!this.el || !this.sensor) return;
    const lightSvg = this.el.querySelector<SVGElement>('.a11y-env-icon--light');
    const noiseSvg = this.el.querySelector<SVGElement>('.a11y-env-icon--noise');
    if (lightSvg) lightSvg.classList.toggle('inactive', !this.sensor.isLightActive());
    if (noiseSvg) noiseSvg.classList.toggle('inactive', !this.sensor.isNoiseActive());
  }

  detach(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.el && this.el.parentElement) this.el.parentElement.removeChild(this.el);
    this.el = null;
    this.tooltipEl = null;
    this.sensor = null;
  }

  private reveal(): void {
    if (this.el) this.el.classList.add('visible');
  }

  private fade(): void {
    if (this.el) this.el.classList.remove('visible');
  }
}
