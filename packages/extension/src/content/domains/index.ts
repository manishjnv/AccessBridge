/**
 * AccessBridge — Domain Connector Registry
 *
 * Manages domain-specific accessibility connectors (banking, insurance, etc.).
 * Detects the current domain and activates the appropriate connector.
 */

import { BankingConnector } from './banking.js';
import { HealthcareConnector } from './healthcare.js';
import { InsuranceConnector } from './insurance.js';
import { RetailConnector } from './retail.js';
import { TelecomConnector } from './telecom.js';
import { ManufacturingConnector } from './manufacturing.js';

// ---------------------------------------------------------------------------
// DomainConnector interface
// ---------------------------------------------------------------------------

export interface DomainConnector {
  /** Unique identifier for this connector. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Return true if the current page belongs to this domain. */
  detect(): boolean;
  /** Start the connector — inject enhancements. */
  activate(): void;
  /** Stop the connector — remove all injected elements and listeners. */
  deactivate(): void;
}

// ---------------------------------------------------------------------------
// DomainConnectorRegistry
// ---------------------------------------------------------------------------

export class DomainConnectorRegistry {
  private connectors: DomainConnector[] = [];
  private activeConnector: DomainConnector | null = null;

  constructor() {
    // Register all available domain connectors
    this.connectors.push(new BankingConnector());
    this.connectors.push(new HealthcareConnector());
    this.connectors.push(new InsuranceConnector());
    this.connectors.push(new RetailConnector());
    this.connectors.push(new TelecomConnector());
    this.connectors.push(new ManufacturingConnector());
  }

  /**
   * Check all registered connectors and activate the first matching one.
   * Returns the activated connector or null if none matched.
   */
  detectAndActivate(): DomainConnector | null {
    // Deactivate any previously active connector
    this.deactivateAll();

    for (const connector of this.connectors) {
      try {
        if (connector.detect()) {
          console.log(`[AccessBridge] Domain detected: ${connector.label}`);
          connector.activate();
          this.activeConnector = connector;
          return connector;
        }
      } catch (err) {
        console.warn(`[AccessBridge] Error detecting domain "${connector.id}":`, err);
      }
    }

    console.log('[AccessBridge] No domain-specific connector matched');
    return null;
  }

  /**
   * Return the currently active connector, or null.
   */
  getActiveConnector(): DomainConnector | null {
    return this.activeConnector;
  }

  /**
   * Deactivate all connectors and clean up.
   */
  deactivateAll(): void {
    if (this.activeConnector) {
      try {
        this.activeConnector.deactivate();
      } catch (err) {
        console.warn('[AccessBridge] Error deactivating domain connector:', err);
      }
      this.activeConnector = null;
    }
  }
}
