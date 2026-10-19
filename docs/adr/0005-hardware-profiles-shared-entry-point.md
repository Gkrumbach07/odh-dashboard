---
paths:
  - "packages/hardware-profiles/**"
  - "frontend/src/concepts/hardwareProfiles/**"
---

# 5. Hardware Profiles Shared Entry Point

Date: 2026-10-19

## Status

Proposed

## Context

`packages/hardware-profiles` owns hardware-profile UI and hooks that many other
packages and the host reuse: the profile select, form section, binding-state
label, details popover and their hooks. Consumers reach them in two ways today:

- the `@odh-dashboard/hardware-profiles/shared` barrel (`shared/index.ts`),
  which the host re-exports through shims in
  `frontend/src/concepts/hardwareProfiles/`; and
- about 55 subpath exports in the package's `package.json`.

The repository-wide rule is "no barrel imports" (`.claude/rules/react.md`,
`no-barrel-files` set to `error` in `packages/eslint-config/base.js`). This
package turns that lint rule off in its own `.eslintrc.js` because `shared/` is
meant to be one stable entry point. Reviewers asked for the barrel-plus-shim
route for new shared components, and for `shared/` to stay free of
page-level and host-internal dependencies so other packages can consume it
without pulling in the package's pages.

Today `shared/` still imports `src/pages` in one place and
`@odh-dashboard/internal` in about ten.

## Decision

Reusable hardware-profile components and hooks are exported from
`packages/hardware-profiles/shared/index.ts` and consumed as
`@odh-dashboard/hardware-profiles/shared`. Host code reaches them through the
`#~/concepts/hardwareProfiles` shims. This is a sanctioned exception to the
repository-wide no-barrel rule, limited to this package's `shared/` entry
point.

Code in `packages/hardware-profiles/shared/` does not import from the
package's `src/pages` or from `@odh-dashboard/internal`. The existing imports
are tracked debt to migrate, not precedent.

## Review rules

- A new component or hook added under `packages/hardware-profiles/shared/`
  must be exported from `shared/index.ts`; do not add a new `package.json`
  subpath export for it.
- Host code must import shared hardware-profile UI through
  `#~/concepts/hardwareProfiles`, not directly from the package path.
- New or changed lines in `packages/hardware-profiles/shared/` must not import
  from `../src/pages` or from `@odh-dashboard/internal`. Move the dependency
  into `shared/` (for example `shared/utils.ts`) instead.

## Consequences

**Positive:**
- One entry point for consumers; renames inside the package don't break them.
- `shared/` can be consumed by other packages without the package's pages.

**Negative:**
- The no-barrel rule has a documented exception that reviewers must know.
- Migrating the existing `src/pages` and `@odh-dashboard/internal` imports is
  separate work.

## References

- [React rules: no barrel imports](../../.claude/rules/react.md)
- [Package topology](../package-topology.md)
- `packages/hardware-profiles/.eslintrc.js` (`no-barrel-files` off)
