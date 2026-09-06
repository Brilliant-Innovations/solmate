# ADR-0006 — Step-up authentication stack: Supabase TOTP for session assurance, SimpleWebAuthn for passkey step-up

**Status:** Accepted
**Date:** 2026-09-06
**Class (§31 taxonomy):** TRADE-OFF / DECISION
**Blueprint text affected:** §5.7 ("Passkey/WebAuthn step-up must use a production-stable implementation; do not make Live Readiness depend on an experimental auth feature. The reference implementation may use a dedicated WebAuthn library/service while keeping Supabase user identity canonical."), D41, §15.6, §20.26. Execution plan M2: "production-stable WebAuthn step-up library selected".
**§31-protected decision affected:** none changed. "Human risk-increasing controls require step-up while pause/close remain fast" is implemented as written; "database rows alone are not execution authority" shapes where verification runs.

## Context

Verified on 2026-09-06:

| Option | State | Verdict |
| --- | --- | --- |
| Supabase Auth native passkeys (`auth.registerPasskey`, `auth.signInWithPasskey`, WebAuthn MFA factor) | Documented as **experimental**: "The API may change without notice", opt-in flag on the client | Excluded by §5.7 |
| Supabase Auth TOTP MFA (`auth.mfa.enroll/challenge/verify`, `aal1`/`aal2` JWT claim) | Generally available, free on every project, enabled by default on hosted projects | Adopted for session assurance |
| SimpleWebAuthn (`@simplewebauthn/server` 14.0.1, `@simplewebauthn/browser` 14.0.0) | Mature TypeScript WebAuthn library, Node ≥ 22, FIDO MDS support, PQC algorithms in v14; `@simplewebauthn/types` retired in v13 (types ship in server/browser) | Adopted for passkey step-up |

## Decision

1. **Identity and TOTP are Supabase Auth.** Every browser control write requires an `aal2` session: `ops.has_aal2()` is part of the RLS policy on `ops.control_requests` (migration `20260906001100`). Pause and other risk-reducing controls stay fast (no passkey ceremony) but are not reachable from a session that has not completed TOTP. Sign-in redirects to `/sign-in/mfa` until the factor is verified; enrolment lives in Settings → Operator Security.
2. **Passkeys are the primary step-up (D41) and are verified by the worker with SimpleWebAuthn.** The browser runs the ceremony (`@simplewebauthn/browser`, M9 UI) and files the assertion as `payload.stepUp` (`StepUpEvidence`) inside the control request it is authorising. The worker verifies it (`apps/worker/src/step-up/verify.ts`) with `verifyAuthenticationResponse` against the stored passkey and challenge, then writes the immutable `ops.step_up_assertions` row and references it from `control_requests.step_up_assertion_ref`.
3. **Challenges come from the database, bound to one exact request.** `ops.begin_step_up(kind, binding_hash)` (SECURITY DEFINER, aal2 operator only, self-scoped, rate-limited, 5-minute life) generates 32 random bytes server-side. `binding_hash = canonicalHash({ kind, payload })` (`stepUpBindingHash`), so an assertion for "arm release A" cannot be replayed to arm release B or to resume entries. The worker rejects mismatched kind, hash, user, expiry, consumed challenge, revoked passkey and non-increasing sign count.
4. **Policy is data.** `STEP_UP_POLICY` in `libs/contracts/policy/step-up.ts` classifies every `ControlRequestKind` as `REQUIRED`, `FAST`, `LIVE_TARGET` (required only toward `LIVE_APPROVAL`/`LIVE_AUTO`; fails closed without a target) or `AAL2_ONLY` (`REGISTER_PASSKEY`, so the first passkey can be added with TOTP alone). Web, worker and tests import the same table.
5. **The browser never writes passkeys or assertions.** `ops.operator_passkeys`, `ops.step_up_challenges`, `ops.step_up_assertions` are readable by their owner (admins read passkeys/assertions), writable only by backend roles. `begin_step_up` is the one self-scoped RPC beside the `control_requests` insert; it stores a nonce, not authority.

## Consequences

- Live Readiness never depends on an experimental Supabase feature; SimpleWebAuthn is pinned like every other dependency (ADR-0005 table gains the two packages).
- `REVOKE_PASSKEY` requires step-up per D41 ("operator/credential changes"). Recovery from a lost passkey is an admin action outside the browser (`traderctl`, M3/M9), not a weakened policy.
- Release attestation (§6.16A) will reuse the same verifier and pinned `RELEASE_ATTESTATION_TRUST_FINGERPRINTS` (sha256 of the passkey's COSE public key) so the risk-authorizer can check an attestation without trusting a database row alone.
- M2 ships the substrate and the TOTP flow end-to-end; the passkey registration/assertion UI and the worker's control-request handler that calls the verifier arrive with §20.26 in M9 and the worker roles in M4+. Until then no control request kind that needs a passkey is issued by the UI.
- Hosted project settings the operator applies by hand: Authentication → Sign In / Providers → Email → disable "Allow new users to sign up"; Multi-Factor Authentication → TOTP enabled (default).
