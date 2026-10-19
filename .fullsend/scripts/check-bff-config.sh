#!/usr/bin/env bash
# Host check for ADR 0007 (module E2E BFF wiring).
#
# Reports a `bffConfig` block that this PR adds to any package.json. Nothing
# has read it since #8432; the local E2E BFF starts from the package Makefile
# and its cypress:server:e2e script. Blocks already present at the PR base are
# not this PR's finding. Logic: lib/decision_checks.py (bff-config).
#
# Usage:
#   check-bff-config.sh [output.json]
#   check-bff-config.sh --self-test
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_OUT="${_DIR}/../.run/bff-config.json"

run_producer() {
  python3 "${_DIR}/lib/decision_checks.py" bff-config "$1"
}

package_json() {
  # $1: version; $2: extra top-level members.
  cat <<EOF
{
  "name": "@odh-dashboard/example",
  "version": "$1",
${2:-}
  "scripts": {
    "cypress:server:e2e": "make dev-bff-e2e-cluster E2E_BFF_PORT=4040"
  }
}
EOF
}

run_self_test() {
  # shellcheck source=lib/decision-check-fixture.sh
  source "${_DIR}/lib/decision-check-fixture.sh"
  local out base head pkg old fail=0
  out="$(mktemp)"
  pkg=packages/example/package.json
  old=packages/legacy/package.json
  fixture_init
  mkdir -p "${FIXTURE_REPO}/docs/adr"
  printf '%s\n' '# 7.' '' '- Do not add a `bffConfig` block to any `package.json`; it has no reader.' \
    > "${FIXTURE_REPO}/docs/adr/0007-module-e2e-bff-wiring.md"
  package_json 1.0.0 | fixture_write "${pkg}"
  package_json 1.0.0 '  "bffConfig": { "port": 4041 },' | fixture_write "${old}"
  base="$(fixture_commit)"

  # Upstream #9989: a new package adds the dead block.
  package_json 1.0.0 $'  "bffConfig": {\n    "port": 4040\n  },' | fixture_write "${pkg}"
  package_json 1.0.1 '  "bffConfig": { "port": 4041 },' | fixture_write "${old}"
  head="$(fixture_commit)"
  fixture_run bff-config "${base}" "${head}" "${out}" "${pkg}" "${old}"
  fixture_assert "${out}" '
    .status == "ok" and (.findings | length == 1) and
    (.findings[0] | .file == "packages/example/package.json" and .line == "4"
      and .category == "dead-bff-config" and .severity == "low"
      and (.description | contains("0007-module-e2e-bff-wiring.md:3")))
  ' "bff-config: an added bffConfig block is reported; one already at the base is not" || fail=1

  fixture_run bff-config "${base}" "${head}" "${out}" "packages/example/src/index.ts"
  fixture_assert "${out}" '.status == "none" and .reason == "no-package-json-changes"' \
    "bff-config: a PR without package.json changes is not applicable" || fail=1

  fixture_run bff-config "${base}" "$(printf 'c%.0s' {1..40})" "${out}" "${pkg}"
  fixture_assert "${out}" '.status == "error" and .reason == "pr-revisions-unavailable"' \
    "bff-config: a missing PR commit is an error, not a pass" || fail=1

  fixture_cleanup
  rm -f "${out}"
  [[ "${fail}" -eq 0 ]] || return 1
  echo "All bff-config self-tests passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit $?
fi

run_producer "${1:-${_DEFAULT_OUT}}"
