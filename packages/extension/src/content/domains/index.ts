/**
 * Domain Connectors — specialized accessibility adapters for specific
 * application domains (banking, healthcare, etc.)
 */

export interface DomainConnector {
  readonly id: string;
  readonly label: string;
  /** Returns true if this connector should activate on the current page. */
  detect(): boolean;
  /** Activate domain-specific enhancements. */
  activate(): void;
  /** Deactivate and clean up all injected elements. */
  deactivate(): void;
}

export { BankingConnector } from './banking.js';
