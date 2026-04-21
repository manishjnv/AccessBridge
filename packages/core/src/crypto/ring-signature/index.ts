export type {
  KeyPair,
  SAGSignature,
  SAGSignatureHex,
  Attestation,
  VerifyResult,
} from './types.js';

export {
  generateKeypair,
  deriveKeyImage,
  sign,
  verify,
  hashRing,
  sigToHex,
  sigFromHex,
  hex,
  unhex,
} from './ed25519-ring.js';

export type { BuildAttestationArgs } from './commitment.js';
export {
  buildAttestation,
  attestationMessageBytes,
  attestationKeyImageDomain,
} from './commitment.js';

export type { VerifyAttestationArgs } from './verifier.js';
export { verifyAttestation } from './verifier.js';
