# Zero-Knowledge Attestation (Feature #7)

Session 16 closes the loop on the Compliance Observatory (Feature #10). The original observatory shipped differentially-private noised counters plus a Merkle commitment over the counter bundle — the *what* was committed, but there was no proof of *who committed*. A malicious server administrator (or anyone with write access to the observatory DB) could fabricate attestations indistinguishable from real ones.

Session 16 adds the two primitives that make the observatory trustless:

1. **Device enrollment + SAG linkable ring signatures.** Each opt-in device generates a Ristretto255 keypair at first publish. The public key lives on the observatory server as part of a ring; the secret key never leaves the browser. Daily publishes are signed against the full ring — the server can verify the signature came from *some* enrolled device without learning *which* device.
2. **Standalone auditor verifier tool.** A static page at `/observatory/verifier` that fetches attestations + rings from the server and re-runs every signature check client-side with pinned CDN libraries. A skeptical auditor can unplug the network mid-verification and the math still runs on a pasted JSON.

This feature closes the RPwD Act 2016 §20 / EAA Art. 4 / ADA Title I evidence chain: "this organization is providing accessibility accommodations, and here is a cryptographic proof that the aggregated count is the sum of real-device attestations, not fabricated by the server."

---

## 1. Cryptographic construction

The scheme is the [Abe-Ohkubo-Suzuki](https://www.iacr.org/cryptodb/archive/2004/ASIACRYPT/365/365.pdf) linkable variant of the SAG (Spontaneous Anonymous Group) ring signature, implemented over **Ristretto255** (a prime-order group built on Curve25519, [RFC 9496](https://www.rfc-editor.org/rfc/rfc9496.html)).

### Why Ristretto255, not raw Ed25519

Ed25519 has cofactor 8 — every "real" point has 8 torsion-equivalent encodings, and two different 32-byte strings can decode to the same effective group element. `@noble/curves`' own documentation flags `ExtendedPoint` as "a source of bugs for protocols like ring signatures." Ristretto255 wraps the same curve arithmetic into a prime-order group where every point has a unique 32-byte canonical encoding — eliminating the cofactor-malleability footguns that historically broke naive ring-signature constructions (e.g. the [2017 CryptoNote bug](https://getmonero.org/2017/05/17/disclosure-of-a-major-bug-in-cryptonote-based-currencies.html)).

### Primitives used

- Point group: Ristretto255 via `@noble/curves@1.9.7`.
- Hash-to-scalar: `sha256("accessbridge-scalar-v1:" || x)` LE-decoded + reduced mod `L` (subgroup order).
- Hash-to-point: try-and-increment over `sha512("accessbridge-htp-v1:" + domain + ":" + ctr)` — the first 32 bytes feed into `RistrettoPoint.fromHex`; a failed decode advances the counter. Domain input is always public (date only), so timing depends only on public values.
- Randomness: `ed25519.utils.randomPrivateKey()` (which internally calls `crypto.getRandomValues`). `Math.random` is never used.
- Scalar encoding: 32 bytes little-endian, reduced mod L.
- Point encoding: 32-byte canonical Ristretto255 compressed form.

### Algorithm (signing)

Given a ring of public keys `P_0, …, P_{n-1}`, a secret key `x_π` such that `P_π = x_π · G`, a message `m`, and a domain label `D`:

1. Compute key image `I = x_π · H_p(D)`.
2. Sample random nonzero scalar `α`.
3. Set `L_π = α · G`, `R_π = α · H_p(D)`, and `c_{π+1} = H_s(m ‖ L_π ‖ R_π ‖ I)`.
4. For each `i = π+1, π+2, …, π-1 (mod n)`: sample random nonzero `s_i`, compute `L_i = s_i · G + c_i · P_i`, `R_i = s_i · H_p(D) + c_i · I`, and `c_{(i+1) mod n} = H_s(m ‖ L_i ‖ R_i ‖ I)`.
5. Compute `s_π = α − c_π · x_π (mod L)`.
6. Output signature `σ = (c_0, s_0, …, s_{n-1}, I)`.

Verifying: walk the same loop for all `i`, compute `c_n`, accept iff `c_n == c_0`. Since `s_π` absorbs `α - c_π · x_π`, the chain closes precisely when the signer held the real `x_π` corresponding to `P_π`.

### Domain separation

- **Message bytes** (what the signature commits to): `utf8("accessbridge-attest-v1:" + date + ":" + ringVersion + ":" + ringHash + ":" + merkleRoot)`. Binds the signature to this specific ring + counter commitment.
- **Key-image domain** (what `H_p` hashes): `"accessbridge-obs-v1:" + date`. Scoped by date only — so same device + same day → same key image regardless of which ring snapshot the client had cached. This is what the server's `UNIQUE(date, key_image)` row constraint relies on to prevent mid-day double-publishing.

### Why date-only key-image scoping (Session 16 adversarial-pass finding)

An earlier draft included `ringHash` in the key-image domain. That was unsafe: when the ring rotates mid-day (device N+1 joins), a malicious client could submit one attestation against ring v1 and another against ring v2, the same day, under the same secret key. Two different `ringHash` values → two different key images → the UNIQUE constraint doesn't fire → counters are double-aggregated. Dropping `ringHash` from the key-image domain forces a single key image per `(device, date)` regardless of which ring was used. Signature still binds the ring (via the message bytes), so signer-hiding is unaffected.

---

## 2. Wire formats

### Attestation bundle (POSTed to `/observatory/api/publish` wrapped as `{ attestation: ... }`)

```json
{
  "format": 1,
  "date": "YYYY-MM-DD",
  "ringVersion": 7,
  "ringHash": "<64-char sha256 hex>",
  "merkleRoot": "<64-char sha256 hex>",
  "counters": { /* the Session-10 NoisyBundle payload, opaque to the signature */ },
  "signature": {
    "c0": "<64-char hex>",
    "s": ["<64-char hex>", "..."],
    "keyImage": "<64-char hex>"
  }
}
```

### Ring snapshot (`GET /observatory/api/ring`)

```json
{
  "version": 7,
  "pubKeys": ["<64-char Ristretto255 hex>", "..."],
  "ringHash": "<64-char sha256 hex>"
}
```

### Verify endpoint (`GET /observatory/api/verify/:date`)

```json
{
  "date": "YYYY-MM-DD",
  "count": 42,
  "attestations": [ /* each is the full Attestation bundle */ ],
  "rings": [ /* every ring referenced by these attestations */ ],
  "currentRing": { /* the latest ring */ }
}
```

---

## 3. Threat model

| Adversary | Capability | Mitigation |
|---|---|---|
| Malicious observatory server | Can forge counters, can drop attestations, can alter ring | Every attestation carries a SAG signature; auditor's verifier tool re-verifies client-side. Forgery requires breaking discrete log on Ristretto255. |
| Honest-but-curious server | Sees keyImage, counters, ring | Key image reveals only "same device on same date" — already apparent from the `(date, keyImage)` schema; no identity leakage. Counters are Laplace-noised (ε=1.0). |
| Colluding ring members | N-1 members collude to deanonymize the Nth | SAG provides *unconditional* anonymity even against the entire rest of the ring. An N=2 ring provides 1-out-of-2 anonymity; larger rings provide stronger hiding. |
| Adversary with subpoena access to server DB | Wants to identify a specific contributor | Counters are DP-noised; ring signatures hide which member signed; the server never learns device-identity bindings. A subpoena yields aggregated noise and keyImage tokens, not identities. |
| Malicious client with stolen device secret | Wants to double-publish or impersonate | Stolen secret can sign as that device, but UNIQUE(date, keyImage) blocks double-publish. Owner can rotate key via popup Settings → "Rotate device key". |
| Local attacker with timing-side-channel capability | Wants to extract device secret via signing timing | BigInt in V8 is not constant-time. Documented limitation — attacker must already have process-level access to the machine. Not a realistic concern for the DP-counter threat model. |

---

## 4. Auditor workflow

1. Visit `http://72.61.227.64:8300/observatory/verifier` (or the mirror maintained by your auditing firm — the page is 100% client-side, serve it from any HTTPS origin).
2. Enter a date (e.g. `2026-04-21`) and click **Verify**. The tool:
   - Fetches `/observatory/api/verify/2026-04-21`.
   - For each attestation: recomputes the Merkle root from the counters, checks `ringHash` matches the ring referenced, runs the SAG verify loop in-browser.
   - Produces a table with one row per attestation (key-image prefix, Merkle-root prefix, valid/invalid, failure reason).
3. Inspect the summary card: ring size, total attestations, valid count, invalid count.
4. Click **Download PDF** for an archive-quality report. The PDF includes an "Audit Certificate Hash" — `sha256(date || ringHash || keyImageList)`. Two auditors running the same verifier against the same date MUST produce the same certificate hash; any divergence means one of them saw a different view of the server state.

### Trustlessness drills (for the paranoid auditor)

- **Network cut mid-verify.** Open DevTools → Network → Offline mode AFTER the page loads. Paste a known-good attestation JSON in the paste-mode textarea. Verification should still work (all libs are already loaded from CDN and cached).
- **Library pinning.** The verifier imports `@noble/curves@1.9.7` and `@noble/hashes@1.5.0` from esm.sh with SHA-pinned URLs. Auditors can mirror the CDN locally and verify the JS byte-for-byte against the official release hashes.
- **Certificate hash cross-check.** Run the verifier on two independent machines. The audit certificate hash in the PDF MUST match.

---

## 5. Device rotation + lost-device policy

- A user can rotate their device keypair via popup Settings → Observatory → "Rotate device key". This generates a fresh Ristretto keypair, re-enrolls with the server, and forces a fresh ring snapshot.
- Rotating mid-day will produce a new key image. The UNIQUE(date, keyImage) constraint is per-device-secret, not per-person, so the new keypair can publish once more that day. This is an accepted minor double-count risk; DP noise (ε=1.0) absorbs single extras.
- Lost devices: the stolen secret can sign until the legitimate user rotates. There is no revocation list; ring turnover (weekly refresh) eventually evicts orphaned keys only if the server adds a manual revoke endpoint (out of Session-16 scope).

---

## 6. What this proves — and what it doesn't

**Proves.**
- At least one real enrolled device attested on this date with these DP-noised counters.
- The server did not fabricate the aggregate counts above what at least N valid signatures could produce.
- The counter payload was not altered after signing (Merkle commitment).
- No single device double-published on this date under this ring-refresh cadence.

**Does NOT prove.**
- That *every* enrolled device attested (the absence of a device's keyImage is consistent with both "user opted out" and "user offline").
- That a particular individual is or is not using accessibility features.
- Compliance with a specific regulation — that's a legal judgment, not a cryptographic one. The observatory supplies *evidence*, not a *certification*.

---

## 7. Compliance mapping

| Regulation | How this evidence supports compliance |
|---|---|
| RPwD Act 2016 §20 (India) | Aggregate count of adaptation-apply events + struggle-trigger events, cryptographically attested. Shows accommodations are actually used, not just available. |
| European Accessibility Act 2025 Art. 4 | Ring-signed evidence of language coverage (Indic + European languages) and sectoral adoption (domain connectors). |
| ADA Title I (USA) | Documented provision of accommodations; audit log of feature enablement counts with cryptographic non-repudiation on the source. |

The `/observatory/api/compliance-report` endpoint produces a pre-formatted JSON that maps these regulations to live aggregate numbers. Pair it with the PDF export from the verifier to produce a dated, cryptographically-sealed compliance packet.

---

## 8. Out of scope (deferred)

- External CA-rooted device certificates — current keys are self-generated.
- Revocation lists — lost devices stop publishing on their own, and ring turnover eventually prunes orphans; no explicit revoke endpoint.
- Cross-organization federation — single-deployment ring only.
- Post-quantum signatures — Ristretto255 is pre-quantum; PQ upgrade is future work.
- True zk-SNARKs for counter correctness — DP noise is the privacy primitive; ring signatures are the authenticity primitive; zk-SNARKs for counter-range proofs are out of scope.
- Native-code hardening against timing side channels — BigInt in V8 is not constant-time (documented trade-off).
