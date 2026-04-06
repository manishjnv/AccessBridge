/**
 * Base adapter class for application-specific accessibility adaptations.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';

export abstract class BaseAdapter {
  protected appliedAdaptations: Map<string, Adaptation> = new Map();

  /** Detect whether this adapter matches the current page. */
  abstract detect(): boolean;

  /** Apply an accessibility adaptation to the page. */
  abstract apply(adaptation: Adaptation): void;

  /** Revert a specific adaptation by its ID. */
  abstract revert(adaptationId: string): void;

  /** Collect behaviour signals specific to this application. */
  abstract collectSignals(): BehaviorSignal[];

  // ---------- Common DOM helpers ----------

  /** Inject a <style> element into the page head. */
  protected injectStyle(id: string, css: string): void {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  /** Remove an injected style element. */
  protected removeStyle(id: string): void {
    document.getElementById(id)?.remove();
  }

  /** Add a CSS class to the document body. */
  protected addBodyClass(className: string): void {
    document.body.classList.add(className);
  }

  /** Remove a CSS class from the document body. */
  protected removeBodyClass(className: string): void {
    document.body.classList.remove(className);
  }

  /** Set a CSS custom property on :root. */
  protected setCssVar(name: string, value: string): void {
    document.documentElement.style.setProperty(name, value);
  }

  /** Remove a CSS custom property from :root. */
  protected removeCssVar(name: string): void {
    document.documentElement.style.removeProperty(name);
  }

  /** Query elements safely. */
  protected queryAll(selector: string): Element[] {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  /** Get the main content region of the page. */
  protected getMainContent(): Element | null {
    return (
      document.querySelector('main') ??
      document.querySelector('[role="main"]') ??
      document.querySelector('#content') ??
      document.querySelector('.content') ??
      document.body
    );
  }

  /** Track an applied adaptation. */
  protected trackAdaptation(adaptation: Adaptation): void {
    this.appliedAdaptations.set(adaptation.id, adaptation);
  }

  /** Remove tracking for an adaptation. */
  protected untrackAdaptation(adaptationId: string): void {
    this.appliedAdaptations.delete(adaptationId);
  }
}
