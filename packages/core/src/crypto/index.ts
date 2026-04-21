/**
 * Session 16: cryptographic primitives for the Zero-Knowledge Attestation
 * pipeline — SAG linkable ring signatures over Ristretto255 plus an
 * Attestation bundle builder + verifier.
 *
 * Public surface is intentionally narrow: consumers import from
 * `@accessbridge/core/crypto` and get just the ring-signature helpers. See
 * [docs/features/zero-knowledge-attestation.md] for the threat model.
 */

export * from './ring-signature/index.js';
