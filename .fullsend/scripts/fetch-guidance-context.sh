#!/usr/bin/env bash
# Host selection of the repository guidance that governs a PR's changed files.
#
# Reads the `paths:` front matter of .claude/rules/*.md, docs/adr/*.md and
# packages/*/docs/adr/*.md from the base-branch checkout and lists every
# document whose globs match at least one changed file. The guidance-review
# LLM reads exactly this list, so whether a rule or ADR is considered no
# longer depends on a reviewer deciding to open it.
#
# Inputs (set by pre-review.sh run_adapter):
#   FULLSEND_ADAPTER_REPO_DIR   base-branch checkout (target-repo)
#   FULLSEND_ADAPTER_PR_FILES   file holding the PR's changed paths, one per line
#
# Writes context JSON only — no findings, no forge calls, no credentials.
#
# Usage:
#   fetch-guidance-context.sh [output.json]
#   fetch-guidance-context.sh --self-test
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_OUT="${_DIR}/../.run/guidance.json"

run_producer() {
  python3 - "${1}" <<'PY'
import json, os, re, sys
from pathlib import Path

dest = Path(sys.argv[1])
MAX_DOCS = 15
MAX_MATCHED = 8


def envelope(**kwargs):
    payload = {
        "id": "repo-guidance",
        "dimension": "repo-guidance",
        "kind": "cli-adapter",
        "output": "context",
    }
    payload.update(kwargs)
    return payload


def write(payload):
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def glob_to_regex(glob):
    # `**/` matches zero or more directories, `**` anything, `*` and `?`
    # stay inside one path segment. Braces are not used by any rule today.
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            out += ".*"
            i += 2
        elif glob[i] == "*":
            out += "[^/]*"
            i += 1
        elif glob[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(glob[i])
            i += 1
    return re.compile("^" + out + "$")


def front_matter(text):
    if not text.startswith("---\n"):
        return {}, []
    end = text.find("\n---", 4)
    if end < 0:
        return {}, []
    fields, paths, in_paths = {}, [], False
    for line in text[4:end].splitlines():
        item = re.match(r"^\s+-\s+[\"']?([^\"']+)[\"']?\s*$", line)
        if in_paths and item:
            paths.append(item.group(1).strip())
            continue
        in_paths = False
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if kv:
            key, value = kv.group(1), kv.group(2).strip().strip("\"'")
            if key == "paths" and not value:
                in_paths = True
            else:
                fields[key] = value
    return fields, paths


def title_of(text, fields):
    if fields.get("description"):
        return fields["description"]
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return m.group(1).strip() if m else ""


def adr_status(text):
    m = re.search(r"^##\s+Status\s*\n+\s*([A-Za-z][^\n]*)", text, re.M)
    return m.group(1).strip() if m else ""


repo = Path(os.environ.get("FULLSEND_ADAPTER_REPO_DIR") or "")
files_path = os.environ.get("FULLSEND_ADAPTER_PR_FILES") or ""

if not repo.is_dir():
    write(envelope(status="error", reason="repo-dir-missing"))
    print(f"Wrote guidance context (error: repo-dir-missing) to {dest}")
    raise SystemExit(0)
if not files_path or not Path(files_path).is_file():
    write(envelope(status="error", reason="pr-files-missing"))
    print(f"Wrote guidance context (error: pr-files-missing) to {dest}")
    raise SystemExit(0)

changed = [l.strip() for l in Path(files_path).read_text(encoding="utf-8").splitlines() if l.strip()]
if not changed:
    write(envelope(status="none", reason="no-changed-files"))
    print(f"Wrote guidance context (none: no-changed-files) to {dest}")
    raise SystemExit(0)

candidates = [("rule", p) for p in sorted(repo.glob(".claude/rules/*.md"))]
candidates += [("adr", p) for p in sorted(repo.glob("docs/adr/*.md"))]
candidates += [("adr", p) for p in sorted(repo.glob("packages/*/docs/adr/*.md"))]

docs = []
for kind, path in candidates:
    if path.is_symlink() or not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    fields, globs = front_matter(text)
    if not globs:
        continue
    status = adr_status(text) if kind == "adr" else ""
    if kind == "adr" and status.lower().startswith(("superseded", "deprecated", "rejected")):
        continue
    patterns = [glob_to_regex(g) for g in globs]
    matched = [f for f in changed if any(p.match(f) for p in patterns)]
    if not matched:
        continue
    entry = {
        "path": str(path.relative_to(repo)),
        "kind": kind,
        "title": title_of(text, fields),
        "paths": globs,
        "match_count": len(matched),
        "matched_files": matched[:MAX_MATCHED],
    }
    if status:
        entry["adr_status"] = status
    docs.append(entry)

# ADRs first (narrow, decision-specific), then rules; within each, the
# documents whose globs are most specific to this change come first.
docs.sort(key=lambda d: (d["kind"] != "adr", -d["match_count"] / max(1, len(changed)), d["path"]))
truncated = len(docs) > MAX_DOCS
docs = docs[:MAX_DOCS]

if not docs:
    write(envelope(status="none", reason="no-matching-guidance", changed_file_count=len(changed)))
    print(f"Wrote guidance context (none: no matching guidance for {len(changed)} files) to {dest}")
    raise SystemExit(0)

write(envelope(status="ok", changed_file_count=len(changed), truncated=truncated, documents=docs))
print(f"Wrote guidance context (ok: {len(docs)} documents for {len(changed)} files) to {dest}")
PY
}

run_self_test() {
  local tmp repo files
  tmp="$(mktemp)"
  repo="$(mktemp -d)"
  files="$(mktemp)"
  mkdir -p "${repo}/.claude/rules" "${repo}/docs/adr" "${repo}/packages/gen-ai/docs/adr"
  cat > "${repo}/.claude/rules/cypress-e2e.md" <<'EOF'
---
description: Cypress E2E guidelines
paths:
  - "packages/cypress/cypress/tests/e2e/**"
---
# Cypress E2E
EOF
  cat > "${repo}/.claude/rules/react.md" <<'EOF'
---
description: React conventions
paths:
  - "**/*.tsx"
---
EOF
  cat > "${repo}/docs/adr/0009-operator-rbac.md" <<'EOF'
---
paths:
  - "manifests/modules/*/rbac*.yaml"
---
# 9. Mirror module RBAC

## Status

Proposed
EOF
  cat > "${repo}/docs/adr/0003-old.md" <<'EOF'
---
paths:
  - "**"
---
# 3. Old

## Status

Superseded by 0009
EOF
  printf '# no front matter\n' > "${repo}/packages/gen-ai/docs/adr/0001-x.md"

  printf '%s\n' \
    'packages/cypress/cypress/tests/e2e/notebooks/test.cy.ts' \
    'manifests/modules/model-registry/rbac.yaml' \
    'README.md' > "${files}"
  FULLSEND_ADAPTER_REPO_DIR="${repo}" FULLSEND_ADAPTER_PR_FILES="${files}" run_producer "${tmp}" >/dev/null
  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["status"] == "ok", data
paths = [d["path"] for d in data["documents"]]
assert paths == ["docs/adr/0009-operator-rbac.md", ".claude/rules/cypress-e2e.md"], paths
assert data["documents"][0]["adr_status"] == "Proposed", data
assert data["documents"][1]["matched_files"] == ["packages/cypress/cypress/tests/e2e/notebooks/test.cy.ts"], data
print("PASS repo-guidance: globs select ADRs before rules and skip superseded ADRs")
PY

  printf '%s\n' 'frontend/src/App.tsx' > "${files}"
  FULLSEND_ADAPTER_REPO_DIR="${repo}" FULLSEND_ADAPTER_PR_FILES="${files}" run_producer "${tmp}" >/dev/null
  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert [d["path"] for d in data["documents"]] == [".claude/rules/react.md"], data
print("PASS repo-guidance: **/ matches files at any depth")
PY

  printf '%s\n' 'Makefile' > "${files}"
  FULLSEND_ADAPTER_REPO_DIR="${repo}" FULLSEND_ADAPTER_PR_FILES="${files}" run_producer "${tmp}" >/dev/null
  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["status"] == "none" and data["reason"] == "no-matching-guidance", data
print("PASS repo-guidance: unmatched changes produce no context")
PY

  FULLSEND_ADAPTER_REPO_DIR="${repo}/missing" FULLSEND_ADAPTER_PR_FILES="${files}" run_producer "${tmp}" >/dev/null
  python3 - "${tmp}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["status"] == "error" and data["reason"] == "repo-dir-missing", data
print("PASS repo-guidance: a missing checkout is reported, not guessed")
PY

  local definition prompt
  definition="$(jq -r 'first(.dimensions[] | select(.id == "guidance-review") | .definition) // empty' "${_DIR}/../dimensions.json")"
  prompt="${_DIR}/../${definition}"
  [[ -n "${definition}" && -f "${prompt}" ]]
  grep -Eiq 'untrusted (prompt )?data' "${prompt}"
  grep -Eiq 'never as instructions' "${prompt}"
  echo "PASS repo-guidance: guidance-review prompt states the data boundary"

  rm -rf "${tmp}" "${repo}" "${files}"
  echo "All repo-guidance self-tests passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

run_producer "${1:-${_DEFAULT_OUT}}"
