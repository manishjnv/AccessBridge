/**
 * Builds an Attestation bundle: a Merkle commitment over the daily counters
 * plus a SAG ring signature binding (date, ringHash, merkleRoot, ringVersion).
 *
 * The caller is responsible for computing the Merkle root over the counters —
 * it's an opaque input here. This keeps the cryptography package free of any
 * bundle-specific schema; `@accessbridge/extension`'s observatory-publisher
 * owns the canonical counter-line layout.
 */

import { sign, sigToHex, hashRing } from './ed25519-ring.js';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { Attestation } from './types.js';

export interface BuildAttestationArgs {
  date: string;
  counters: Record<string, unknown>;
  merkleRoot: string;
  ring: Uint8Array[];
  ringVersion: number;
  signerIndex: number;
  secKey: Uint8Array;
}

/** Stable byte encoding of the signed message. Any change to this is a
 *  wire-incompatible break — bump the attestation `format` field at the
 *  same time. */
export function attestationMessageBytes(a: {
  date: string;
  ringHash: string;
  merkleRoot: string;
  ringVersion: number;
}): Uint8Array {
  const s = `accessbridge-attest-v1:${a.date}:${a.ringVersion}:${a.ringHash}:${a.merkleRoot}`;
  return utf8ToBytes(s);
}

/** Domain label for key-image derivation. Scoped by date ONLY so that
 *  same device + same day -> same keyImage regardless of which ring the
 *  client happens to have cached. The server enforces UNIQUE(date,
 *  key_image) which depends on this invariant: if a ring rotation lands
 *  mid-day, a device must not be able to publish twice by signing once
 *  against each valid ring. The signature still binds to ringHash (via
 *  attestationMessageBytes), so signer-hiding works as before.
 *
 *  NOTE: the second arg is ignored. It is kept for source-compat with
 *  earlier Session 16 drafts and the verifier web tool's import signature.
 *  Do not remove without syncing every caller. */
export function attestationKeyImageDomain(
  date: string,
  _ringHash?: string,
): string {
  return `accessbridge-obs-v1:${date}`;
}

export function buildAttestation(args: BuildAttestationArgs): Attestation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error('buildAttestation: date must be YYYY-MM-DD');
  }
  if (typeof args.merkleRoot !== 'string' || args.merkleRoot.length === 0) {
    throw new Error('buildAttestation: merkleRoot required');
  }
  if (!Array.isArray(args.ring) || args.ring.length < 2) {
    throw new Error('buildAttestation: ring must have at least 2 members');
  }
  if (
    !Number.isInteger(args.signerIndex) ||
    args.signerIndex < 0 ||
    args.signerIndex >= args.ring.length
  ) {
    throw new Error('buildAttestation: signerIndex out of range');
  }

  const ringHash = hashRing(args.ring);
  const domain = attestationKeyImageDomain(args.date, ringHash);
  const message = attestationMessageBytes({
    date: args.date,
    ringHash,
    merkleRoot: args.merkleRoot,
    ringVersion: args.ringVersion,
  });
  const sig = sign(message, args.ring, args.signerIndex, args.secKey, domain);

  return {
    format: 1,
    date: args.date,
    ringVersion: args.ringVersion,
    ringHash,
    merkleRoot: args.merkleRoot,
    counters: args.counters,
    signature: sigToHex(sig),
  };
}
