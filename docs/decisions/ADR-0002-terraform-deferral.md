# ADR-0002 — Defer Profile 3/4 Terraform to M11; define deployment profiles in configuration and CI in M2

**Status:** Accepted
**Date:** 2026-09-05
**Class (§31 taxonomy):** TRADE-OFF / DECISION
**Blueprint text affected:** P0 acceptance (§28): "Profile 4 Terraform/DigitalOcean manifests prove three distinct Droplets, VPC/firewall boundaries, separate service secrets and service-specific attached persistence"; §35.2: "Define D65 deployment profiles in configuration/CI, but do not provision three paid persistent hosts before research evidence warrants them."
**§31-protected decision affected:** none.

## Context

P0 asks for the hardened Profile 4 infrastructure-as-code to exist, unapplied, at the very start. Writing DigitalOcean Terraform before the services have a runtime shape produces manifests that will be rewritten. What §35.2 and D65 actually require early is that the profiles are **defined** so CI and readiness know which checks each profile needs and which secrets each service receives.

## Decision

- M2 defines Profiles P0–P4 in configuration and CI: profile manifests, per-service secret sources, the checks each profile requires. Profile 0/1 manifests are runnable; Profile 3/4 manifests exist as declarations.
- The DigitalOcean Terraform for Profiles 3 and 4 is written in M11 and applied only at profile promotion (M12).
- Nothing about the logical trust boundaries changes: separate credentials per logical service are proven in M2 on Profile 0/1 manifests.

## Consequences

- P0 acceptance is met with this ADR noted; the Terraform item moves to M11's exit gate.
- Risk: a Profile 4 topology surprise late. Mitigation: the M2 profile declarations already name three hosts, separate secrets and per-service volumes, so M11 fills in provider syntax rather than design.

## Operator sign-off

Sean Rogers, 2026-09-05. Surfaced by the Fable review of plan v1 and the implementation-agent review of plan v2.
