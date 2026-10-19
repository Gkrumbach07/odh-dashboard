---
paths:
  - "manifests/modules/**/*role*.yaml"
  - "manifests/modules/**/*rbac*.yaml"
  - "manifests/base/sa-rbac/**"
  - "dashboard-operator/config/rbac/role.yaml"
  - "dashboard-operator/charts/dashboard/templates/rbac.yaml"
---

# 8. The Operator Holds Every Rule It Grants

Date: 2026-10-19

## Status

Proposed

## Context

The dashboard operator renders and applies the manifests under
`manifests/base/` and `manifests/modules/<slug>/` (kustomize, in
`dashboard-operator/internal/controller/module_deploy.go`). Some of those
manifests are Roles and ClusterRoles for the dashboard and module service
accounts.

Kubernetes RBAC escalation prevention lets a subject create or update a role
only if it already holds every permission in it, unless it has the `escalate`
verb. The operator's role (`dashboard-operator/config/rbac/role.yaml`, mirrored
in `dashboard-operator/charts/dashboard/templates/rbac.yaml`) has no `escalate`
or `bind`. So a module role that grants something the operator lacks fails to
apply at reconcile time, on a cluster, with nothing caught in CI. A chart test
keeps the two operator role files in sync with each other, but nothing checks
module roles against them.

Previous changes that added operand permissions updated both operator role
files at the same time (#9802, #10124).

## Decision

Every rule granted by a Role or ClusterRole that the operator applies
(`manifests/modules/**`, `manifests/base/**`) is also held by the operator, in
both `dashboard-operator/config/rbac/role.yaml` and
`dashboard-operator/charts/dashboard/templates/rbac.yaml`.

## Review rules

- A PR that adds a rule (apiGroup, resource, verb) to a Role or ClusterRole
  under `manifests/modules/` or `manifests/base/` must add the same rule to
  both `dashboard-operator/config/rbac/role.yaml` and
  `dashboard-operator/charts/dashboard/templates/rbac.yaml`, unless the
  operator already holds it.
- Do not give the operator `escalate` or `bind` to avoid mirroring.

## Consequences

**Positive:**
- Module RBAC applies on first reconcile instead of failing on a cluster.

**Negative:**
- The operator role grows with every module permission.
- Until a test compares module roles with the operator role, this relies on
  review.

## References

- [Dashboard operator](../dashboard-operator.md)
- [Operator controller rules](../../.claude/rules/operator-controller.md)
- [Kubernetes RBAC: privilege escalation prevention](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping)
