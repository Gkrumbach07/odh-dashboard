---
paths:
  - "packages/*/package.json"
  - "distributions/*/package.json"
  - "packages/*/Makefile"
  - "packages/cypress/src/e2e-proxy/**"
  - "docs/bff-e2e-testing.md"
---

# 7. Module E2E BFF Wiring

Date: 2026-10-19

## Status

Proposed

## Context

Packages with a BFF run that BFF locally during live-cluster E2E. Two pieces
of configuration decide whether requests reach it:

- **How the BFF starts.** Each package's `cypress:server:e2e` script calls
  `make dev-bff-e2e-cluster E2E_BFF_PORT=…`, and the root runs those scripts
  through turbo. An earlier design read a `bffConfig` block from the package's
  `package.json` in the E2E workflow; that reader was removed in #8432
  (2026-07-14) and nothing reads `bffConfig` since. Scaffolding guidance kept
  prescribing it, so new packages still add the dead block.
- **Where the e2e proxy sends `/<package>/api`.** `packages/app-config` copies
  the package's `module-federation.service` onto every proxy entry, and
  `packages/cypress/src/e2e-proxy/routes.ts` sends a request to the cluster
  whenever `service.name` is not `odh-dashboard`. Only `odh-dashboard` routes to
  the local backend, which forwards to the package's local port. The cluster
  Service name for the deployed module comes from the operator, not from this
  field.

## Decision

A package's E2E BFF wiring comes only from its Makefile
(`dev-bff-e2e-cluster`, `E2E_BFF_PORT`), its `cypress:server:e2e` script and
its `module-federation` block. `bffConfig` in `package.json` is not read and is
not added.

A package whose BFF runs locally for E2E sets `module-federation.service.name`
to `odh-dashboard`.

## Review rules

- Do not add a `bffConfig` block to any `package.json`; it has no reader.
- A package that defines `cypress:server:e2e` (or otherwise runs its BFF
  locally for E2E) must set `module-federation.service.name` to
  `odh-dashboard`. A `odh-dashboard-<slug>-ui` value sends E2E API traffic to
  the cluster instead of the local BFF.

## Consequences

**Positive:**
- One source of truth for the local BFF port and start command.
- E2E API calls reach the BFF under test.

**Negative:**
- `bffConfig` blocks already in `data-connect-hub`, `data-registry` and
  `notebooks` are dead and should be removed; `data-connect-hub` also has a
  `-ui` service name today.

## References

- [BFF E2E testing](../bff-e2e-testing.md)
- [Module onboarding rules](../../.claude/rules/module-onboarding.md)
- `packages/cypress/src/e2e-proxy/routes.ts`, `packages/app-config/src/module-federation.ts`
- #8432 (removed the `bffConfig` reader)
