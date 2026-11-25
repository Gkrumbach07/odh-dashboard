#!/usr/bin/env bash
# FORK-ONLY TEST STUB: canned CodeRabbit findings for the replay of upstream
# PR 10837, to exercise the challenger's handling of host findings.
set -euo pipefail
_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${_DIR}/../.run"
jq -n '{id: "coderabbit", dimension: "coderabbit", kind: "cli-adapter", output: "findings", status: "ok", findings: [
  {severity: "high", category: "coderabbit", file: "dashboard-operator/internal/controller/dashboard_controller.go", line: "625",
   description: "If reconciling the console-config Role or RoleBinding fails, the reconcile only records the failure and still deploys Dashboard. The pod can start without access to console-config and keeps the fallback branding until it is restarted.",
   remediation: "Return a retryable error before deploying when the console-config grant cannot be established.", actionable: true},
  {severity: "high", category: "coderabbit", file: "dashboard-operator/internal/controller/namespaced_rbac.go", line: "46",
   description: "The new Role grants the Dashboard service account list and watch on every ConfigMap in the openshift-console namespace, which is broader than the cluster-wide rule it replaces.",
   remediation: "Restrict the rule to get on the console-config ConfigMap.", actionable: true},
  {severity: "medium", category: "coderabbit", file: "manifests/base/sa-rbac/cluster-role.yaml",
   description: "The replacement console-config grant is created only by the Go controller. Installing the manifests directly with kustomize removes the ConfigMap rule and adds nothing in its place, so branding detection loses access on that install path.",
   remediation: "Add a namespaced Role and RoleBinding for console-config to the manifests, or document that direct installs lose branding.", actionable: true}
]}' > "${_DIR}/../.run/coderabbit.json"
