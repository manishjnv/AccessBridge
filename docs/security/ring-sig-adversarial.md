# Ring-Signature Adversarial Review — Session 26

**Methodology:** Opus-solo adversarial read (codex:rescue quota-exhausted per `feedback_rescue_fallback` memory; recovers 2026-04-26).
**Scope:** `packages/core/src/crypto/ring-signature/{ed25519-ring.ts,verifier.ts,commitment.ts,types.ts,index.ts}`, `ops/observatory/crypto-verify.js`, `ops/observatory/public/verifier.js`.
**Date:** 2026-04-22.
**Prior art consulted:** RCA BUG-014 (keyImage domain regression), `docs/features/zero-knowledge-attestation.md` (design intent).

---

## Threat 1 — Small-subgroup / low-order points

Every point that enters the arithmetic passes through `RistrettoPoint.fromHex` before multiplication: ring members at `ed25519-ring.ts:150` (`decodeRing`), key image at `ed25519-ring.ts:275` and `crypto-verify.js:161`, hash-to-point candidates at `ed25519-ring.ts:122`. Ristretto255 is a prime-order group (RFC 9496) — the encoding itself rejects any non-canonical or cofactor-tainted point, so low-order attacks that plague raw ExtendedPoint (the very reason `@noble/curves` flags it per the header comment at `ed25519-ring.ts:4-12`) cannot apply. No `ExtendedPoint`, `edwardsPoint`, or raw curve APIs are referenced anywhere in the three code paths. `hashToPoint` additionally rejects `RistrettoPoint.ZERO` (line 124) — identity can never be returned even from a pathological domain.

**Verdict:** SAFE

## Threat 2 — Nonce reuse / biased random sampling

`randomNonzeroScalar` (`ed25519-ring.ts:99-106`) draws each alpha/s_i via `ed25519.utils.randomPrivateKey()`, which in `@noble/curves` wraps `crypto.getRandomValues` (a CSPRNG). Rejection-sampling over nonzero scalars is unbiased: `bytesToScalar` reduces mod L, but the acceptance region `[1, L-1]` out of `[0, 2^256)` has probability > (1 - 2^-252), so the modular bias is cryptographically negligible. No state is shared across calls — each `sign()` invocation allocates fresh `c[]`, `s[]`, and alpha. The `for attempt = 0; attempt < 16` retry loop guards against the astronomically unlikely case of repeated zero draws (throws, never silently uses zero). No seeded PRNG, no `Math.random`, no cross-sign state.

**Verdict:** SAFE

## Threat 3 — keyImage forgery / linkability attack (RCA BUG-014 regression check)

The post-fix invariant from BUG-014: `attestationKeyImageDomain(date, _ringHash)` must return `"accessbridge-obs-v1:" + date` with `ringHash` ignored. Verified byte-identical in all three call-sites: `commitment.ts:49-54`, `crypto-verify.js:118-123`, `verifier.js:167-170`. The domain literal is a hardcoded template string with no configuration hook — no env var, no server-supplied prefix, no attestation-field substitution. `deriveKeyImage(secKey, domain)` at `ed25519-ring.ts:186-191` computes `I = x * H_p(domain)` where x is the signer's secret scalar; the only way to change I for a given (secret, date) is to change the secret, so a ring rotation mid-day produces the same I and the server's UNIQUE(date, key_image) constraint fires as designed. The second arg to `attestationKeyImageDomain` (the ringHash) is kept only for source-compat with the verifier web tool's import signature and is explicitly ignored — no regression.

**Verdict:** SAFE

## Threat 4 — Signature malleability

All scalars re-enter the verify loop through `bytesToScalar` at `ed25519-ring.ts:282, 284` which unconditionally reduces mod L (`((x % CURVE_L) + CURVE_L) % CURVE_L`, line 79). An attacker submitting `s_i' = s_i + L` (a "high-S" variant) would therefore be reduced to the canonical s_i and accepted — meaning the verifier accepts multiple byte-level encodings of logically equivalent scalars. **This IS a form of signature malleability** but it is benign here: the `keyImage` is the server's UNIQUE key, not the signature blob. Two malleable copies of the same signature produce identical (date, keyImage) and are rejected by the DB constraint regardless of s-byte variation. If in future code a signature-hash itself became a uniqueness key, this would need tightening (explicit rejection of non-canonical scalar encodings via `b >= L` check before reduction). Flagged as a defensive gap rather than a vulnerability because the current server schema does not depend on signature-byte uniqueness.

**Verdict:** DEFENSIVE-GAP

## Threat 5 — Timing side-channels on verify

`verify()` at `ed25519-ring.ts:257-295` does size checks (`s.length !== n`, `c0.length !== SCALAR_BYTES`, `keyImage.length !== SCALAR_BYTES`, lines 266-268) that early-exit on malformed input. This leaks **which** length was wrong to a network observer but not any secret — the ring and the signature blob are both public. The final equality `c[n] === c[0]` (line 291) is a BigInt `===` comparison, not a loop-early-exit over bytes — `===` on two reduced-mod-L scalars is a single-step check with no early exit. The main loop iterates i=0..n always, regardless of correctness. BigInt arithmetic is documented as non-constant-time (header comment lines 18-22) — but the signer's secret x leaves the timing-sensitive path only during `sign()`; `verify()` operates on purely public scalars. No secret-dependent branch in verify.

**Verdict:** SAFE

## Threat 6 — Ring-of-one / tiny-ring attacks

`sign()` at `ed25519-ring.ts:203` rejects `n < 2`; `verify()` at `ed25519-ring.ts:265` mirrors it; `buildAttestation` at `commitment.ts:63-64` rejects `ring.length < 2`. Ring size 2 is technically allowed but provides only ln(2) bits of anonymity — the design comment in `zero-knowledge-attestation.md` (per task brief) and the Session-16 k-anonymity floor of 5 suggest 5+ is the intended operational minimum. The ring-sig library does NOT enforce `n >= 5`; that floor lives in the observatory's enrollment policy. **This is a defensive gap**: a caller that forgets to enforce the k-anonymity floor could produce a 2-member ring signature that verifies but provides weak anonymity. Recommendation: add a configurable minimum-ring-size parameter (default 5) to `sign()` / `buildAttestation` so the crypto layer enforces the anonymity floor, not policy-layer code. Not a direct exploit — signer-hiding is still mathematically sound at n=2, just weak.

**Verdict:** DEFENSIVE-GAP

## Threat 7 — Cross-origin / modified-bundle replay

`attestationMessageBytes` at `commitment.ts:28-36` concatenates `date:ringVersion:ringHash:merkleRoot` — every signed byte is bound into the hash input. Tampering with any of those fields (including merkleRoot, which commits to the counters) breaks `c[n] === c[0]`. Counter-modification attacks are caught by the Merkle recomputation in `verifier.ts:67-77` / `crypto-verify.js:270-277`: the attestation's merkleRoot is re-derived from the published counters, mismatch → `merkle-mismatch`. Pure-replay (same bundle, same signature, same keyImage) is caught by the server's UNIQUE(date, keyImage) constraint, which is the whole point of the linkable-ring construction. Cross-device replay (device Y submits device X's bundle) would pass the signature check (rings are public and the signature is valid) — but the keyImage belongs to X, so it lands in the SAME uniqueness bucket X would use; device Y therefore cannot publish their own attestation for that date after replaying X's. This is *defeat-by-design*: replay simply fills X's slot with X's data.

**Verdict:** SAFE

## Threat 8 — Hash-function domain separation

Three distinct hash domains are used:
1. `DOMAIN_SCALAR_PREFIX = "accessbridge-scalar-v1:"` for challenge scalars (`ed25519-ring.ts:47`, mirrored in `crypto-verify.js:31`, `verifier.js:29`).
2. `DOMAIN_HTP_PREFIX = "accessbridge-htp-v1:"` for hash-to-point (`ed25519-ring.ts:48`, mirrored).
3. `"accessbridge-obs-v1:" + date` for key-image domain (`commitment.ts:53`, mirrored).
4. `"accessbridge-attest-v1:"` as the attestation message prefix (`commitment.ts:34`, mirrored).

All four are distinct literal prefixes with version tags. Distinct algorithms (sha256 for scalar, sha512 for htp) add further separation even if prefixes collided. The ring-sig challenge's input at `ed25519-ring.ts:231, 240` (`message || Li || Ri || Ibytes`) reuses the scalar-hash domain — correct, since every challenge step is the same protocol step. No cross-protocol attack surface visible.

**Verdict:** SAFE

## Threat 9 — Server-side verify byte-identity with TS

Line-by-line comparison:
- `scalarToBytes` / `bytesToScalar`: `crypto-verify.js:34-54` is a literal rewrite of `ed25519-ring.ts:60-80`, identical loop bounds, identical LE endianness, identical reduction.
- `hashToScalar`, `hashToPoint`, `safeMultiply`, `hashRing`, `decodeRing`: identical algorithms, identical domain strings, identical `MAX_HTP_COUNTER = 256`, identical `RistrettoPoint.ZERO` rejection.
- `verifySAG` at `crypto-verify.js:148-181`: same input layout `concatBytes(message, Li.toRawBytes(), Ri.toRawBytes(), Ibytes)`, same `c[n] === c[0]` check.
- `attestationMessageBytes` and `attestationKeyImageDomain`: byte-identical literal formats.

The only divergence is that `crypto-verify.js` (Node) also recomputes the Merkle root from `counters` using `recomputeCounterMerkleRoot`, while the TS `verifier.ts` accepts it as an optional injected helper (line 25) — this is structurally correct: the server always recomputes (deterministic audit), TS callers can opt in. The client-side `verifier.js` mirrors both (line 198-222) using `crypto.subtle.digest('SHA-256', ...)` — correct since Node's `sha256` and WebCrypto SHA-256 produce identical output. No ASN.1, no BigInt-endianness mismatch. `concatBytes` and `utf8ToBytes` come from the same `@noble/hashes/utils` in all three files. Version pinning: `crypto-verify.js` uses whatever Node's `node_modules` resolves (workspace pnpm), `verifier.js` pins esm.sh to `@noble/curves@1.9.7` + `@noble/hashes@1.5.0` — **this is a version-skew risk**: if the TS side updates `@noble/curves` to a version with a different Ristretto internal encoding (unlikely but possible), the esm.sh pin could diverge. Document-level risk, not a code-level defect today.

**Verdict:** SAFE (with a note on esm.sh version pinning — maintenance discipline required)

## Threat 10 — Auditor verifier trust model

`verifier.js:419-460` (`verifyByDate`) fetches `/observatory/api/verify/${date}` which returns `{attestations, ring: {pubKeys, ringHash, version}}`. The client recomputes `hashRing(ring.pubKeys)` at line 245 and checks it equals `attestation.ringHash` at line 249 — so a server that supplies a *tampered* ring (e.g., a ring consisting only of the target device's pubkey, to deanonymize) would produce a DIFFERENT ringHash than the one embedded in the signed attestation, failing the check with `ring-mismatch`. The signed attestation commits to the ring by hash (via `attestationMessageBytes`), so the server cannot supply a deanonymizing 1-key ring that would verify. HTTPS is used for all fetches (`/observatory/api/...` paths). The `verifyPasted` path at line 466-523 fetches `/observatory/api/ring` (current ring only) and warns if `attestation.ringVersion !== ringVersion` — this is the documented failure mode for historical attestations against a rotated ring, handled gracefully. Date-substitution attack: a signature for date X cannot be tricked into verifying as date Y because `date` enters both `attestationMessageBytes` (bound into the signed hash) and `attestationKeyImageDomain` (bound into the keyImage via H_p). Both would have to be substituted consistently, and then the signature is semantically unchanged — the attestation is simply labeled with the other date, which is caught by DB UNIQUE(date, keyImage) collision or by the auditor spotting an obvious timestamp mismatch.

**Verdict:** SAFE

## Threat 11 — Key-compromise impersonation

Linkable ring-sig's standard property: if attacker obtains secret key x, they can sign arbitrary messages. For past dates D where the victim DID sign, the attacker's keyImage `I = x * H_p(date=D)` collides with the victim's — server's UNIQUE(date, keyImage) rejects the duplicate. For past dates D where the victim did NOT sign, the attacker freely signs — **this is expected by the threat model**. The code cannot defend against stolen-secret signing because the signing authority *is* the secret. Recommendation out of scope for this review: rotate secrets periodically and use enrollment epochs so a leaked 2026-04-22 secret cannot sign for 2026-04-21 without a plausible same-day compromise story. Current code permits post-compromise back-signing; the architectural defense (temporal fencing) is a product decision, not a crypto one.

**Verdict:** SAFE (within the documented threat model)

## Threat 12 — Session 17/18/22 related regressions (desktop-agent crypto confusion)

The desktop-agent IPC crypto (`packages/desktop-agent/src-tauri/src/crypto.rs`) uses a PSK for the loopback WS handshake — entirely separate key material, separate encoding, separate derivation. No path in the ring-sig module reads agent-side keys: the attestation secret key is generated via `generateKeypair` in `ed25519-ring.ts:173-182` and stored by the extension (not the agent). The agent's `pair-psk` is 32 random bytes base64-encoded for a hash-based handshake, never interpreted as a Ristretto scalar. Cross-domain confusion would require feeding a PSK (base64-decoded) into `seedToScalar` — no code path does this. `seedToScalar` (line 84-95) also rejects zero-scalars, so even an accidental all-zero PSK wouldn't silently sign. The separation is enforced by type (Uint8Array vs String in Rust) and by code locality (different packages, no shared interface). BUG-017/018/019 all concern file-permission handling in the desktop agent, unrelated to ring-sig.

**Verdict:** SAFE

---

## Summary

- Threats evaluated: 12
- Vulnerabilities: 0
- Defensive gaps: 2 (Threat 4 scalar-canonicalization, Threat 6 minimum ring size)
- SAFE verdicts: 10

## New findings

### FINDING-RING-001 [LOW]
- **File:** `packages/core/src/crypto/ring-signature/ed25519-ring.ts:282-284` (plus mirrored `crypto-verify.js:168-170`, `verifier.js:139-142`)
- **Description:** `bytesToScalar` silently reduces non-canonical scalars (values >= L) mod L instead of rejecting them. An attacker can therefore produce multiple byte-distinct signatures `(c0, s[], keyImage)` that all verify for the same signer call, by adding multiples of L to any `s_i` byte encoding. This is classical signature malleability.
- **Exploit:** Only exploitable in a context where the signature bytes themselves (rather than the keyImage) serve as a uniqueness/dedup key. Current DB schema uses `UNIQUE(date, key_image)` so the exploit does not land; a future change that keys on `signature_hash` would.
- **Remediation:** In `bytesToScalar`, reject `x >= CURVE_L` before the reduction (throw on non-canonical input). Apply in all three files byte-identically. Add a regression test with a `s_i + L`-encoded signature that verify() currently accepts.
- **Status:** Open

### FINDING-RING-002 [LOW]
- **File:** `packages/core/src/crypto/ring-signature/ed25519-ring.ts:203`, `packages/core/src/crypto/ring-signature/commitment.ts:63-64`
- **Description:** Ring-signature `sign()` accepts any `n >= 2`. A 2-member ring provides 1 bit of anonymity (signer is one of two, verifiable by elimination). The k-anonymity floor of 5 exists in observatory enrollment policy (per task brief) but is not enforced at the crypto layer. A caller bug that bypasses the policy layer (e.g., a new internal tool) could produce low-anonymity signatures that verify cleanly.
- **Exploit:** Not directly an exploit — signer-hiding math is sound at n=2. Risk is operational: a 2-member ring leaks signer identity by inspection if one ring member is known to the observer.
- **Remediation:** Add `MIN_RING_SIZE = 5` constant to `ed25519-ring.ts` and enforce in `sign()` (throw on `n < MIN_RING_SIZE`). Mirror the floor in `crypto-verify.js` verify path (reject at parse, not just at math). Allow an override parameter for tests only.
- **Status:** Open

Report back: 10 SAFE / 2 DEFENSIVE-GAP / 0 VULNERABILITY. BUG-014 fix verified in place across all three sites. Both findings are LOW severity; neither blocks push. Remediation is recommended before the schema ever changes to key on signature bytes (FINDING-RING-001) or before ring-construction moves out of the enrollment service to a client with no policy enforcement (FINDING-RING-002).
