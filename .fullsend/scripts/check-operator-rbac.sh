#!/usr/bin/env bash
# Host check for ADR 0008 (the operator holds every rule it grants).
#
# Every permission a Role or ClusterRole under manifests/modules/ or
# manifests/base/ grants must also be held by both operator role files,
# dashboard-operator/config/rbac/role.yaml and
# dashboard-operator/charts/dashboard/templates/rbac.yaml; otherwise RBAC
# escalation prevention refuses the role at reconcile. resourceNames scope
# counts: an unscoped `get` is not covered by a `get` limited to named
# resources. Only gaps this PR opens are reported, from the PR's own commits.
# Logic: lib/decision_checks.py (operator-rbac).
#
# Usage:
#   check-operator-rbac.sh [output.json]
#   check-operator-rbac.sh --self-test
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_OUT="${_DIR}/../.run/operator-rbac.json"

run_producer() {
  python3 "${_DIR}/lib/decision_checks.py" operator-rbac "$1"
}

operator_role() {
  # $1: extra rule block appended to the fixture's operator rules.
  cat <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: manager-role
rules:
  - apiGroups: [""]
    resources: [configmaps, secrets]
    verbs: [get, list, watch]
  - apiGroups:
      - config.openshift.io
    resources:
      - apiservers
    resourceNames:
      - cluster
    verbs:
      - get
${1:-}
EOF
}

operator_chart() {
  cat <<EOF
{{- if .Values.rbac.create }}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "dashboard.clusterRoleName" . }}
  labels:
    {{- include "dashboard.labels" . | nindent 4 }}
rules:
  - apiGroups:
      - ""
    resources:
      - configmaps
      - secrets
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - config.openshift.io
    resources:
      - apiservers
    resourceNames:
      - cluster
    verbs:
      - get
${1:-}
{{- end }}
EOF
}

module_role() {
  # $1: "scoped" or "unscoped" apiservers get; $2: extra rule block.
  local names=""
  [[ "$1" == "scoped" ]] && names=$'    resourceNames:\n      - cluster'
  cat <<EOF
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: odh-dashboard-example
rules:
  # Read config maps
  - apiGroups:
      - ""
    verbs:
      - get
    resources:
      - configmaps
  - apiGroups:
      - config.openshift.io
    resources:
      - apiservers
${names}
    verbs:
      - get
${2:-}
EOF
}

run_self_test() {
  # shellcheck source=lib/decision-check-fixture.sh
  source "${_DIR}/lib/decision-check-fixture.sh"
  local out base head role chart module fail=0
  out="$(mktemp)"
  role=dashboard-operator/config/rbac/role.yaml
  chart=dashboard-operator/charts/dashboard/templates/rbac.yaml
  module=manifests/modules/example/cluster-role.yaml
  fixture_init
  mkdir -p "${FIXTURE_REPO}/docs/adr"
  printf '%s\n' '# 8.' '' '- A PR that adds a rule must add the same rule to' \
    > "${FIXTURE_REPO}/docs/adr/0008-operator-holds-every-rule-it-grants.md"
  operator_role | fixture_write "${role}"
  operator_chart | fixture_write "${chart}"
  module_role scoped | fixture_write "${module}"
  base="$(fixture_commit)"

  # Upstream #10325: a scoped apiservers get loses its resourceNames.
  module_role unscoped | fixture_write "${module}"
  head="$(fixture_commit)"
  fixture_run operator-rbac "${base}" "${head}" "${out}" "${module}"
  fixture_assert "${out}" '
    .status == "ok" and (.findings | length == 1) and
    (.findings[0] | .file == "manifests/modules/example/cluster-role.yaml" and .line == "13"
      and .severity == "low" and .category == "operator-rbac-not-mirrored"
      and (.description | contains("`get` on `config.openshift.io/apiservers` (any name)"))
      and (.description | contains("either operator role file"))
      and (.description | contains("only for resourceNames `cluster`"))
      and (.description | contains("0008-operator-holds-every-rule-it-grants.md:3")))
  ' "operator-rbac: an unscoped get is not covered by a get scoped to resourceNames" || fail=1

  # Mirrored in role.yaml only: the chart is still missing it.
  operator_role $'  - apiGroups: [config.openshift.io]\n    resources: [apiservers]\n    verbs: [get]' | fixture_write "${role}"
  head="$(fixture_commit)"
  fixture_run operator-rbac "${base}" "${head}" "${out}" "${module}" "${role}"
  fixture_assert "${out}" '
    (.findings | length == 1) and
    (.findings[0].description | contains("missing from `dashboard-operator/charts/dashboard/templates/rbac.yaml`"))
  ' "operator-rbac: a rule mirrored in only one operator file is reported against the other" || fail=1

  # Mirrored in both, chart template directives included.
  operator_chart $'  - apiGroups:\n      - config.openshift.io\n    resources:\n      - apiservers\n    verbs:\n      - get' \
    | fixture_write "${chart}"
  head="$(fixture_commit)"
  fixture_run operator-rbac "${base}" "${head}" "${out}" "${module}" "${role}" "${chart}"
  fixture_assert "${out}" '.status == "ok" and (.findings | length == 0)' \
    "operator-rbac: a rule held by both operator files passes" || fail=1

  # A gap that predates the PR is not this PR's finding.
  operator_role | fixture_write "${role}"
  operator_chart | fixture_write "${chart}"
  module_role scoped $'  - apiGroups: [apps]\n    resources: [deployments]\n    verbs: [create]' | fixture_write "${module}"
  base="$(fixture_commit)"
  module_role scoped $'  - apiGroups: [apps]\n    resources: [deployments]\n    verbs: [create]\n  # comment only' \
    | fixture_write "${module}"
  head="$(fixture_commit)"
  fixture_run operator-rbac "${base}" "${head}" "${out}" "${module}"
  fixture_assert "${out}" '(.findings | length == 0) and .preexisting_gaps == 1' \
    "operator-rbac: gaps already present at the PR base are counted, not reported" || fail=1

  # Narrowing the operator uncovers a module role the PR does not touch.
  module_role scoped | fixture_write "${module}"
  base="$(fixture_commit)"
  printf '%s\n' 'kind: ClusterRole' 'metadata:' '  name: manager-role' 'rules:' \
    '  - apiGroups: [""]' '    resources: [configmaps, secrets]' '    verbs: [get, list, watch]' \
    | fixture_write "${role}"
  head="$(fixture_commit)"
  fixture_run operator-rbac "${base}" "${head}" "${out}" "${role}"
  fixture_assert "${out}" '
    (.findings | length == 1) and .findings[0].file == "manifests/modules/example/cluster-role.yaml" and
    (.findings[0].description | contains("resourceName `cluster`"))
  ' "operator-rbac: a narrowed operator role re-checks every operand role" || fail=1

  fixture_run operator-rbac "${base}" "${head}" "${out}" "frontend/src/App.tsx"
  fixture_assert "${out}" '.status == "none" and .reason == "no-rbac-changes" and (.findings | length == 0)' \
    "operator-rbac: a PR without RBAC changes is not applicable" || fail=1

  fixture_run operator-rbac "${base}" "$(printf 'a%.0s' {1..40})" "${out}" "${module}"
  fixture_assert "${out}" '.status == "error" and .reason == "pr-revisions-unavailable"' \
    "operator-rbac: a missing PR commit is an error, not a pass" || fail=1

  fixture_cleanup
  rm -f "${out}"
  [[ "${fail}" -eq 0 ]] || return 1
  echo "All operator-rbac self-tests passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit $?
fi

run_producer "${1:-${_DEFAULT_OUT}}"
