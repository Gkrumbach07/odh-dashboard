# Self-test helpers for the decision-check adapters (check-*.sh). Sourced, not
# run. A fixture is a throwaway git repository with a base commit and a head
# commit, read through the same FULLSEND_ADAPTER_* inputs pre-review.sh passes.
#
#   fixture_init                 new repo in FIXTURE_REPO
#   fixture_write <path>         stdin becomes the file's content
#   fixture_commit               commit everything; prints the SHA
#   fixture_run <check> <base> <head> <out> [changed paths...]
#   fixture_assert <out> <jq filter> <message>

fixture_init() {
  FIXTURE_REPO="$(mktemp -d)"
  FIXTURE_FILES="$(mktemp)"
  git -C "${FIXTURE_REPO}" init -q
  git -C "${FIXTURE_REPO}" config user.email fixture@example.test
  git -C "${FIXTURE_REPO}" config user.name fixture
  git -C "${FIXTURE_REPO}" config commit.gpgsign false
}

fixture_write() {
  mkdir -p "$(dirname "${FIXTURE_REPO}/$1")"
  cat > "${FIXTURE_REPO}/$1"
}

fixture_commit() {
  git -C "${FIXTURE_REPO}" add -A
  git -C "${FIXTURE_REPO}" commit -q --allow-empty -m fixture
  git -C "${FIXTURE_REPO}" rev-parse HEAD
}

fixture_run() {
  local check="$1" base="$2" head="$3" out="$4"
  shift 4
  printf '%s\n' "$@" > "${FIXTURE_FILES}"
  FULLSEND_ADAPTER_REPO_DIR="${FIXTURE_REPO}" FULLSEND_ADAPTER_PR_FILES="${FIXTURE_FILES}" \
    FULLSEND_ADAPTER_BASE_SHA="${base}" FULLSEND_ADAPTER_HEAD_SHA="${head}" \
    python3 "${_DIR}/lib/decision_checks.py" "${check}" "${out}" >/dev/null
}

fixture_assert() {
  if jq -e "$2" "$1" >/dev/null; then
    echo "PASS $3"
  else
    echo "FAIL $3" >&2
    jq . "$1" >&2
    return 1
  fi
}

fixture_cleanup() {
  rm -rf "${FIXTURE_REPO}" "${FIXTURE_FILES}"
}
