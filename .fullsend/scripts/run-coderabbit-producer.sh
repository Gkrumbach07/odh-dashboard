#!/usr/bin/env bash
# Run CodeRabbit as a review input, not as a GitHub reviewer.
#
#   $CODERABBIT_CLI review --agent [CODERABBIT_REVIEW_ARGS]
#     | adapt-coderabbit.py
#     > .run/coderabbit.json
#
# Local development defaults to scripts/cr-mock (checked-in sample NDJSON).
# GitHub Actions skips this producer unless a real CLI is configured, so a
# fixture can never be mistaken for findings on a live pull request. The real
# tool:
#
#   CODERABBIT_CLI=cr
#   CODERABBIT_REVIEW_ARGS='--base origin/main'
#
# TODO: configure CODERABBIT_CLI=cr in the host job after the service account
# and custom-secret forwarding path are available.
#
# GitHub stores repo files as non-executable; this script runs a file CLI
# with bash when the execute bit is missing.
#
# Usage:
#   run-coderabbit-producer.sh [output.json]
#   run-coderabbit-producer.sh --self-test
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ADAPT="${_DIR}/adapt-coderabbit.py"
_MOCK="${_DIR}/cr-mock"
_DEFAULT_OUT="${_DIR}/../.run/coderabbit.json"

write_empty() {
  local reason="$1"
  local dest="$2"
  python3 - "$reason" "${dest}" <<'PY'
import json, sys
reason, dest = sys.argv[1], sys.argv[2]
payload = {
    "dimension": "coderabbit",
    "kind": "cli-adapter",
    "status": "error",
    "findings": [
        {
            "severity": "info",
            "category": "dimension-producer",
            "file": "N/A",
            "description": f"coderabbit producer did not return findings: {reason}",
            "actionable": False,
        }
    ],
}
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY
}

# Run $1 as `review --agent …`. Files without +x are invoked with bash.
run_cli() {
  local cli="$1"
  shift
  if [[ -f "${cli}" && ! -x "${cli}" ]]; then
    bash "${cli}" "$@"
    return
  fi
  "${cli}" "$@"
}

run_producer() {
  local out="$1"
  mkdir -p "$(dirname "${out}")"

  if [[ -z "${CODERABBIT_CLI:-}" && "${GITHUB_ACTIONS:-}" == "true" ]]; then
    rm -f "${out}"
    echo "CodeRabbit CLI is not configured in GitHub Actions — skipping producer"
    return 0
  fi

  local cli="${CODERABBIT_CLI:-${_MOCK}}"
  local extra=()
  if [[ -n "${CODERABBIT_REVIEW_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra=( ${CODERABBIT_REVIEW_ARGS} )
  fi
  local ndjson
  ndjson="$(mktemp)"
  local rc=0

  set +e
  if [[ ${#extra[@]} -gt 0 ]]; then
    run_cli "${cli}" review --agent "${extra[@]}" >"${ndjson}"
  else
    run_cli "${cli}" review --agent >"${ndjson}"
  fi
  rc=$?
  set -e

  if [[ "${rc}" -ne 0 ]]; then
    echo "::warning::coderabbit CLI (${cli}) exited ${rc} — recording empty dimension" >&2
    write_empty "exit ${rc}" "${out}"
    rm -f "${ndjson}"
    return 0
  fi

  if ! python3 "${_ADAPT}" <"${ndjson}" >"${out}"; then
    echo "::warning::coderabbit adapter failed — recording empty dimension" >&2
    write_empty "adapter failed" "${out}"
    rm -f "${ndjson}"
    return 0
  fi
  rm -f "${ndjson}"
  echo "Wrote coderabbit dimension to ${out} (CLI=${cli})"
}

run_self_test() {
  python3 "${_ADAPT}" --self-test

  local tmp copy
  tmp="$(mktemp)"
  copy="$(mktemp)"
  cp "${_MOCK}" "${copy}"
  chmod a-x "${copy}"
  MOCK_CODERABBIT_FIXTURE="${_DIR}/../fixtures/coderabbit-review.ndjson" \
    CODERABBIT_CLI="${copy}" CODERABBIT_REVIEW_ARGS='--base main' \
    run_producer "${tmp}" >/dev/null

  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["dimension"] == "coderabbit", data
assert data["kind"] == "cli-adapter", data
assert data["status"] == "ok", data
assert len(data["findings"]) == 2, data
by_line = {f.get("line"): f for f in data["findings"]}
assert by_line[7]["severity"] == "high", by_line[7]
assert by_line[7]["category"] == "coderabbit", by_line[7]
assert "Math.random" in by_line[7]["description"], by_line[7]
assert by_line[24]["severity"] == "medium", by_line[24]
assert "createObjectURL" in by_line[24]["description"], by_line[24]
print("PASS producer: cr-mock review --agent → adapter (works without +x)")
PY

  local wrapper
  wrapper="$(mktemp)"
  cat >"${wrapper}" <<EOF
#!/usr/bin/env bash
exec bash "${_MOCK}" "\$@"
EOF
  chmod +x "${wrapper}"
  CODERABBIT_CLI="${wrapper}" run_producer "${tmp}" >/dev/null
  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["status"] == "ok" and len(data["findings"]) == 2
print("PASS producer: CODERABBIT_CLI swap still uses review --agent + adapter")
PY

  (
    unset CODERABBIT_CLI
    GITHUB_ACTIONS=true run_producer "${tmp}" >/dev/null
  )
  if [[ -e "${tmp}" ]]; then
    echo "FAIL producer: GitHub Actions used the local CodeRabbit fixture" >&2
    return 1
  fi
  echo "PASS producer: GitHub Actions skips an unconfigured CodeRabbit CLI"

  rm -f "${tmp}" "${wrapper}" "${copy}"
  echo "All coderabbit-producer self-tests passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

run_producer "${1:-${_DEFAULT_OUT}}"
