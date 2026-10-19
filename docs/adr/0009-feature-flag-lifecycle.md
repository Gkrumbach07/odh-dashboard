---
paths:
  - "frontend/src/concepts/areas/const.ts"
  - "frontend/src/app/featureFlags/**"
  - "backend/src/utils/constants.ts"
  - "distributions/core-bff/bff/internal/models/dashboard_config.go"
  - "manifests/base/crd/odhdashboardconfigs.opendatahub.io.crd.yaml"
  - "backend/src/**/__tests__/**"
---

# 9. Feature Flag Lifecycle

Date: 2026-10-19

## Status

Proposed

## Context

A dashboard feature flag has a default in three places: the frontend groups in
`frontend/src/concepts/areas/const.ts` (`techPreviewFlags`,
`advancedAIMLFlags` and the other functional groups, `devTemporaryFeatureFlags`,
`devFlags`), the backend `blankDashboardCR` in `backend/src/utils/constants.ts`,
and the core-bff `BlankDashboardCR` in
`distributions/core-bff/bff/internal/models/dashboard_config.go`.
Customer-settable flags also appear in the OdhDashboardConfig CRD.

These have drifted (core-bff still defaults several GA flags to false), and
the onboarding doc says a Tech Preview flag may default to true. Reviewers
have consistently asked for the same lifecycle:

- Tech Preview features ship disabled.
- GA promotion moves the flag into its existing functional group; the
  feature-flag modal has no "GA" section (Gen AI Studio, prompt management,
  AutoML and AutoRAG all followed this).
- Dev-only and ephemeral flags stay out of the CRD.
- Flag defaults are covered by behaviour tests (Cypress visibility, operator
  federation config), not one unit assertion per flag.

## Decision

1. A new Tech Preview flag defaults to `false`, with the same value in the
   frontend `const.ts`, the backend `blankDashboardCR` and the core-bff
   `BlankDashboardCR`.
2. On GA promotion the flag moves out of `techPreviewFlags` into its existing
   functional group in `const.ts` with a `true` default, and the backend and
   core-bff defaults change to match. No GA-specific group is created.
3. New `devTemporaryFeatureFlags` and `devFlags` entries are not added to the
   OdhDashboardConfig CRD; the CRD lists flags customers can set.
4. Flag defaults are not unit-tested one assertion per flag against
   `blankDashboardCR`.

## Review rules

- A flag added to `techPreviewFlags` must default to `false`, and the PR must
  set the same default in `backend/src/utils/constants.ts` and
  `distributions/core-bff/bff/internal/models/dashboard_config.go`.
- A GA promotion must not add a new flag group or a "Generally Available"
  section; move the flag into an existing group.
- A flag added to `devTemporaryFeatureFlags` or `devFlags` must not be added
  to `manifests/base/crd/odhdashboardconfigs.opendatahub.io.crd.yaml`.
- Do not request per-flag unit tests of `blankDashboardCR` defaults.

## Consequences

**Positive:**
- Defaults agree across the three runtimes; the modal stays organised by
  function.

**Negative:**
- Three files change for every flag addition or promotion. Existing drift
  (core-bff GA defaults, `modelAsService` defaulting to true, older temporary
  flags in the CRD) is separate cleanup.

## References

- [Onboarding modular architecture](../onboard-modular-architecture.md)
- [Modular architecture rules](../../.claude/rules/modular-architecture.md)
