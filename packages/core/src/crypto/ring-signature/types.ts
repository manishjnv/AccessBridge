/**
 * Shared types for the Session 16 ZK attestation pipeline.
 *
 * The SAG linkable ring signature scheme is implemented over Ristretto255
 * (a prime-order group built on the ed25519 curve, see RFC 9496). Ristretto
 * is used instead of raw ExtendedPoint to sidestep the cofactor-8 malleability
 * issues that bite naive ed25519 ring signatures.
 */

export interface KeyPair {
  /** 32-byte Ristretto255 compressed public-key encoding. */
  pubKey: Uint8Array;
  /** 32-byte secret seed. Keep strictly local; never transmit. */
  secKey: Uint8Array;
}

export interface SAGSignature {
  /** 32-byte initial challenge scalar, little-endian. */
  c0: Uint8Array;
  /** Response scalars s_0 .. s_{n-1}, one per ring member, each 32 bytes LE. */
  s: Uint8Array[];
  /** 32-byte Ristretto255 encoding of the key image I = x * H_p(domain). */
  keyImage: Uint8Array;
}

export interface SAGSignatureHex {
  c0: string;
  s: string[];
  keyImage: string;
}

export interface Attestation {
  format: 1;
  /** YYYY-MM-DD (local to the signing device). */
  date: string;
  /** Monotonic counter; bumps when the server ring membership changes. */
  ringVersion: number;
  /** sha256 hex of the canonical ring encoding (ring[0]||ring[1]||...). */
  ringHash: string;
  /** Hex-encoded Merkle commitment over the canonical counter lines. */
  merkleRoot: string;
  /** Opaque counter payload. Integrity is enforced via merkleRoot + an
   *  out-of-band recomputation helper, not by re-parsing here. */
  counters: Record<string, unknown>;
  /** Ring signature binding (date, ringHash, merkleRoot, ringVersion). */
  signature: SAGSignatureHex;
}

export interface VerifyResult {
  valid: boolean;
  /** One of: 'ring-mismatch' | 'ring-size-mismatch' | 'merkle-mismatch'
   *  | 'signature-invalid' | 'malformed' — set only when valid is false. */
  reason?: string;
  warnings: string[];
  date: string;
  merkleRoot: string;
  /** Hex encoding of the signature's key image — auditors use this to detect
   *  double-attestation by the same device on the same (date, ring). */
  keyImageHex: string;
}
