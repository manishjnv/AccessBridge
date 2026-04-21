/**
 * Auditor-facing verification for an Attestation bundle.
 *
 * Does five checks, in order:
 *   1. The supplied expectedRing hashes to the ringHash inside the bundle.
 *   2. The signature's response-vector length matches the expected ring size.
 *   3. If a Merkle recomputation helper is provided, the bundle's merkleRoot
 *      matches independently computed root over its counters.
 *   4. The ring signature verifies against expectedRing for
 *      (date, ringVersion, ringHash, merkleRoot).
 *   5. Always returns the keyImage hex so the auditor can detect
 *      double-attestation by diffing key images across a date.
 */

import { verify, sigFromHex, hashRing } from './ed25519-ring.js';
import {
  attestationMessageBytes,
  attestationKeyImageDomain,
} from './commitment.js';
import type { Attestation, VerifyResult } from './types.js';

export interface VerifyAttestationArgs {
  attestation: Attestation;
  expectedRing: Uint8Array[];
  recomputeMerkleRoot?: (counters: Record<string, unknown>) => Promise<string>;
}

function baseResult(a: Attestation): Omit<VerifyResult, 'valid'> {
  return {
    warnings: [],
    date: a.date,
    merkleRoot: a.merkleRoot,
    keyImageHex: a.signature.keyImage,
  };
}

export async function verifyAttestation(
  args: VerifyAttestationArgs,
): Promise<VerifyResult> {
  const { attestation, expectedRing, recomputeMerkleRoot } = args;

  if (attestation.format !== 1) {
    return { valid: false, reason: 'malformed', ...baseResult(attestation) };
  }

  // 1. Ring identity check
  let expectedRingHash: string;
  try {
    expectedRingHash = hashRing(expectedRing);
  } catch {
    return { valid: false, reason: 'malformed', ...baseResult(attestation) };
  }
  if (expectedRingHash !== attestation.ringHash) {
    return { valid: false, reason: 'ring-mismatch', ...baseResult(attestation) };
  }

  // 2. Ring size check (cheap; do before sig verify)
  if (attestation.signature.s.length !== expectedRing.length) {
    return {
      valid: false,
      reason: 'ring-size-mismatch',
      ...baseResult(attestation),
    };
  }

  // 3. Optional Merkle re-verification
  if (recomputeMerkleRoot) {
    let recomputed: string;
    try {
      recomputed = await recomputeMerkleRoot(attestation.counters);
    } catch {
      return { valid: false, reason: 'merkle-mismatch', ...baseResult(attestation) };
    }
    if (recomputed !== attestation.merkleRoot) {
      return { valid: false, reason: 'merkle-mismatch', ...baseResult(attestation) };
    }
  }

  // 4. Signature verification
  const message = attestationMessageBytes({
    date: attestation.date,
    ringHash: attestation.ringHash,
    merkleRoot: attestation.merkleRoot,
    ringVersion: attestation.ringVersion,
  });
  const domain = attestationKeyImageDomain(attestation.date, attestation.ringHash);

  let sig;
  try {
    sig = sigFromHex(attestation.signature);
  } catch {
    return { valid: false, reason: 'malformed', ...baseResult(attestation) };
  }
  const ok = verify(message, expectedRing, sig, domain);
  if (!ok) {
    return { valid: false, reason: 'signature-invalid', ...baseResult(attestation) };
  }

  return { valid: true, ...baseResult(attestation) };
}
