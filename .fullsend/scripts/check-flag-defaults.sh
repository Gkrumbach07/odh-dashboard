#!/usr/bin/env bash
# Host check for ADR 0009 (feature flag lifecycle).
#
# For every flag this PR adds or changes in
# frontend/src/concepts/areas/const.ts, the backend blankDashboardCR
# (backend/src/utils/constants.ts) and the core-bff BlankDashboardCR
# (distributions/core-bff/bff/internal/models/dashboard_config.go) must carry
# the same default. Also reports a Tech Preview flag defaulting to true and a
# promotion out of techPreviewFlags into a group the PR creates. Flags the PR
# does not touch are not checked, so existing drift is not this PR's finding.
# Logic: lib/decision_checks.py (flag-defaults).
#
# Usage:
#   check-flag-defaults.sh [output.json]
#   check-flag-defaults.sh --self-test
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_OUT="${_DIR}/../.run/flag-defaults.json"

run_producer() {
  python3 "${_DIR}/lib/decision_checks.py" flag-defaults "$1"
}

frontend_const() {
  # $1: extra techPreviewFlags entries; $2: extra groups.
  cat <<EOF
import type { DashboardCommonConfig } from '@odh-dashboard/k8s-core';

export const techPreviewFlags = {
  genAiTracing: false,
${1:-}
} satisfies Partial<DashboardCommonConfig>;

// Group 4: Advanced AI/ML Features & Pipelines
export const advancedAIMLFlags = {
  genAiStudio: true,
} satisfies Partial<DashboardCommonConfig>;
${2:-}
export const SupportedAreasStateMap = {
  example: { featureFlags: ['genAiTracing'] },
};
EOF
}

backend_constants() {
  cat <<EOF
export const blankDashboardCR: DashboardConfig = {
  spec: {
    dashboardConfig: {
      genAiTracing: false,
      genAiStudio: true,
${1:-}
    },
    notebookController: {
      enabled: true,
    },
  },
};
EOF
}

core_bff_config() {
  cat <<EOF
var BlankDashboardCR = DashboardConfig{
	Spec: DashboardConfigSpec{
		DashboardConfig: DashboardFeatureFlags{
			GenAiTracing: false,
			GenAiStudio:  true,
${1:-}
		},
		NotebookController: &NotebookController{
			Enabled: true,
		},
	},
}
EOF
}

run_self_test() {
  # shellcheck source=lib/decision-check-fixture.sh
  source "${_DIR}/lib/decision-check-fixture.sh"
  local out base head fe be go fail=0
  out="$(mktemp)"
  fe=frontend/src/concepts/areas/const.ts
  be=backend/src/utils/constants.ts
  go=distributions/core-bff/bff/internal/models/dashboard_config.go
  fixture_init
  mkdir -p "${FIXTURE_REPO}/docs/adr"
  printf '%s\n' '# 9.' '' '- A flag added to `techPreviewFlags` must default to `false`, and the PR must' \
    '  set the same default in `backend/src/utils/constants.ts` and' \
    '- A GA promotion must not add a new flag group or a "Generally Available"' \
    > "${FIXTURE_REPO}/docs/adr/0009-feature-flag-lifecycle.md"
  frontend_const | fixture_write "${fe}"
  backend_constants | fixture_write "${be}"
  core_bff_config | fixture_write "${go}"
  base="$(fixture_commit)"

  # A new Tech Preview flag with all three defaults in place.
  frontend_const '  newThing: false,' | fixture_write "${fe}"
  backend_constants '      newThing: false,' | fixture_write "${be}"
  core_bff_config $'\t\t\tNewThing: false,' | fixture_write "${go}"
  head="$(fixture_commit)"
  fixture_run flag-defaults "${base}" "${head}" "${out}" "${fe}" "${be}" "${go}"
  fixture_assert "${out}" '.status == "ok" and (.findings | length == 0) and .checked_flags == ["newThing"]' \
    "flag-defaults: a flag set the same way in all three files passes" || fail=1

  # Defaults to true in Tech Preview, absent from the backend, false in core-bff.
  frontend_const '  newThing: true,' | fixture_write "${fe}"
  backend_constants | fixture_write "${be}"
  core_bff_config $'\t\t\tNewThing: false,' | fixture_write "${go}"
  head="$(fixture_commit)"
  fixture_run flag-defaults "${base}" "${head}" "${out}" "${fe}" "${go}"
  fixture_assert "${out}" '
    (.findings | length == 1) and
    (.findings[0] | .file == "frontend/src/concepts/areas/const.ts" and .line == "5"
      and .category == "flag-default-mismatch" and .severity == "low"
      and (.description | contains("must default to `false`"))
      and (.description | contains("backend `blankDashboardCR` (`backend/src/utils/constants.ts`) has no default"))
      and (.description | contains("core-bff `BlankDashboardCR`"))
      and (.description | contains("defaults it to `false`"))
      and (.description | contains("0009-feature-flag-lifecycle.md:4")))
  ' "flag-defaults: a Tech Preview true and missing or different defaults are reported on the flag line" || fail=1

  # Upstream #10105: GA promotion into a new group.
  frontend_const '  promoted: false,' | fixture_write "${fe}"
  backend_constants '      promoted: false,' | fixture_write "${be}"
  core_bff_config $'\t\t\tPromoted: false,' | fixture_write "${go}"
  base="$(fixture_commit)"
  frontend_const '' $'\nexport const generallyAvailableFeatureFlags = {\n  promoted: true,\n} satisfies Partial<DashboardCommonConfig>;' \
    | fixture_write "${fe}"
  backend_constants '      promoted: true,' | fixture_write "${be}"
  head="$(fixture_commit)"
  fixture_run flag-defaults "${base}" "${head}" "${out}" "${fe}" "${be}"
  fixture_assert "${out}" '
    (.findings | length == 1) and
    (.findings[0].description | contains("`generallyAvailableFeatureFlags`, a group this PR creates"))
    and (.findings[0].description | contains("0009-feature-flag-lifecycle.md:5"))
    and (.findings[0].description | contains("core-bff `BlankDashboardCR` (`distributions/core-bff/bff/internal/models/dashboard_config.go`) defaults it to `false`"))
    and (.findings[0].description | contains("backend") and contains("has no default") | not)
  ' "flag-defaults: a promotion into a new group and core-bff drift are reported" || fail=1

  # Removing a flag everywhere touches no flag line.
  frontend_const | fixture_write "${fe}"
  backend_constants | fixture_write "${be}"
  core_bff_config | fixture_write "${go}"
  head="$(fixture_commit)"
  fixture_run flag-defaults "${base}" "${head}" "${out}" "${fe}" "${be}" "${go}"
  fixture_assert "${out}" '.status == "ok" and (.findings | length == 0) and .checked_flags == []' \
    "flag-defaults: a flag removed from every file is not reported" || fail=1

  fixture_run flag-defaults "${base}" "${head}" "${out}" "${be}"
  fixture_assert "${out}" '.status == "none" and .reason == "no-flag-changes"' \
    "flag-defaults: a PR that does not touch const.ts is not applicable" || fail=1

  fixture_run flag-defaults "$(printf 'b%.0s' {1..40})" "${head}" "${out}" "${fe}"
  fixture_assert "${out}" '.status == "error" and .reason == "pr-revisions-unavailable"' \
    "flag-defaults: a missing PR commit is an error, not a pass" || fail=1

  fixture_cleanup
  rm -f "${out}"
  [[ "${fail}" -eq 0 ]] || return 1
  echo "All flag-defaults self-tests passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit $?
fi

run_producer "${1:-${_DEFAULT_OUT}}"
