#!/usr/bin/env bash
# Vendored from fullsend-ai/agents scripts/post-review.sh
# @ 91f61f3441baedf3f912c9afd4bd574c98793b96 (harness review.yaml base).
#
# Local changes from the stock script:
#   1. Set the GitHub review action from findings (critical/high →
#      request-changes, and so on) and rewrite the sticky comment.
#   2. Do not append the /fs-fix "Next steps" footer.
#   3. Require Problem / Solution / Evidence headings. Pre-review skips the
#      agent when they are missing; this script still flags them if the
#      agent ran.
#   4. If the agent omitted host-collected producer findings from
#      `.run/collected.json`, append ones that are not already covered
#      at the same file and nearby line.
#   5. Link file/line references in the sticky summary and suppress inline
#      review comments by omitting line numbers only from the CLI payload.
#   6. Render a compact, CodeRabbit-inspired summary: disposition and merge
#      risk first, Jira context collapsed, and findings as readable cards.

#
# Harness may fetch this script with sibling files in scripts/.
#
# Usage:
#   post-review.sh              # CI / harness post_script
#   post-review.sh --self-test  # local fixtures, no GitHub
#
# Stock behavior kept: severity filter, protected-path, labels,
# stale-head (exit 10), and the formal fullsend post-review disposition.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# CWD is runDir.
#
# Required environment variables:
#   REVIEW_TOKEN                      — token with pull-requests:write on the target repo
#   PR_NUMBER                         — GitHub PR number
#   REPO_FULL_NAME                    — owner/repo (e.g. my-org/my-repo)
#   REVIEW_FINDING_SEVERITY_THRESHOLD — minimum severity for findings
#                                       (info|low|medium|high|critical);
#                                       default supplied by harness/review.yaml
#   REVIEW_PROTECTED_PATHS            — comma-separated protected path prefixes,
#                                       or empty string to opt out; required
#                                       (non-empty-or-explicitly-empty) for
#                                       approve actions; default supplied by
#                                       harness/review.yaml
#
# Exit codes:
#   0 — review posted
#   1 — error (review not posted or fallback comment posted)
set -euo pipefail

REVIEW_STICKY_MARKER='<!-- fullsend:review-agent -->'

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pr-description-sot.sh
source "${_SCRIPT_DIR}/pr-description-sot.sh"

# $1 = path to agent-result.json. Writes transformed JSON to stdout.
transform_review_result() {
  python3 - "$1" <<'PY'
import json, os, re, sys
from datetime import datetime, timezone
from urllib.parse import quote

FUNCTIONAL_CATEGORIES = {
    "correctness", "security", "protected-path",
    # Host-injected when REQUIRED_PR_HEADINGS is non-empty and a heading is missing.
    "description-sot",
}

def is_functional(finding):
    cat = (finding.get("category") or "").lower()
    if cat in FUNCTIONAL_CATEGORIES:
        return True
    return any(tok in cat for tok in ("bug", "permission", "schema", "silent"))

def compute_action(result):
    existing = result.get("action")
    if existing == "failure":
        return "failure", "agent-failure"
    findings = result.get("findings") or []
    if any((f.get("category") or "") == "approach-rejected" for f in findings):
        return "reject", "approach-rejected"
    sevs = [(f.get("severity") or "info") for f in findings]
    if any(s in ("critical", "high") for s in sevs):
        return "request-changes", "critical-or-high"
    medium = [f for f in findings if f.get("severity") == "medium"]
    if any(is_functional(f) for f in medium):
        return "request-changes", "medium-functional"
    if medium:
        return "comment", "medium-advisory"
    action = "approve"
    reason = "no-blocking-findings"
    risk = (result.get("risk") or "low").lower()
    confidence = (result.get("confidence") or "high").lower()
    pa = result.get("product_ask") if isinstance(result.get("product_ask"), dict) else {}
    if action == "approve" and risk in ("high", "critical"):
        return "comment", "risk-blocks-approve"
    if action == "approve" and confidence == "low":
        return "comment", "low-confidence"
    if action == "approve" and (pa.get("needs_human") or pa.get("status") == "mismatch-unjustified"):
        return "comment", "product-ask-needs-human"
    return action, reason

def norm_heading(text):
    text = (text or "").strip().rstrip(":").strip()
    return re.sub(r"\s+", " ", text).lower()

def section_bodies(body):
    matches = list(re.finditer(r"^(#{1,6})\s+(.+?)\s*$", body or "", re.M))
    out = {}
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        out[norm_heading(m.group(2))] = body[start:end]
    return out

def is_filled(text):
    text = re.sub(r"<!--.*?-->", "", text or "", flags=re.S).strip()
    if not text:
        return False
    compact = re.sub(r"\s+", " ", text).strip().strip("*_`")
    return re.fullmatch(r"(n/?a|na|none|tbd|todo|\.{3}|replace this.*)", compact, re.I) is None

def inject_description_sot_findings(result):
    """Append findings for missing or empty required PR headings."""
    required = [h.strip() for h in os.environ.get("REVIEW_REQUIRED_HEADINGS", "").splitlines() if h.strip()]
    if not required:
        return result
    body = os.environ.get("REVIEW_PR_BODY", "")
    sections = section_bodies(body)
    findings = list(result.get("findings") or [])
    existing_desc = {f.get("description") for f in findings if (f.get("category") or "") == "description-sot"}
    for heading in required:
        content = sections.get(norm_heading(heading))
        if content is not None and is_filled(content):
            continue
        desc = f"PR description is missing required section `{heading}` (heading absent or no real content)."
        if desc in existing_desc:
            continue
        findings.append({
            "severity": "medium",
            "category": "description-sot",
            "file": ".github/PULL_REQUEST_TEMPLATE/agentic.md",
            "description": desc,
            "remediation": "Fill this section with real content in the PR body (see .github/PULL_REQUEST_TEMPLATE/agentic.md). Edit REQUIRED_PR_HEADINGS in pr-description-sot.sh to change the list.",
            "why": "Required PR-body sections are the source of truth; the host enforces them so review does not depend on the agent.",
        })
    result["findings"] = findings
    return result

def apply_product_ask(result):
    """Raise risk / lower confidence for unjustified Jira-vs-description mismatch.
    Needs-human refuses approve later. Description remains SoT."""
    pa = result.get("product_ask")
    if not isinstance(pa, dict):
        return result
    status = pa.get("status") or "none"
    risk_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    conf_rank = {"high": 0, "medium": 1, "low": 2}

    def bump_risk(floor):
        cur = (result.get("risk") or "low").lower()
        if risk_rank.get(floor, 0) > risk_rank.get(cur, 0):
            result["risk"] = floor

    def drop_confidence(floor):
        cur = (result.get("confidence") or "high").lower()
        if conf_rank.get(floor, 0) > conf_rank.get(cur, 0):
            result["confidence"] = floor

    if status == "mismatch-unjustified":
        pa["needs_human"] = True
        pa["justified_in_description"] = False
        bump_risk("high")
        drop_confidence("low")
    return result


def nearby_finding(left, right, window=5):
    left_file = (left.get("file") or "").strip().lower()
    right_file = (right.get("file") or "").strip().lower()
    if not left_file or left_file != right_file or left_file == "n/a":
        return False
    try:
        left_line = int(left.get("line") or 0)
        right_line = int(right.get("line") or 0)
    except (TypeError, ValueError):
        return False
    if left_line < 1 or right_line < 1:
        return False
    return abs(left_line - right_line) <= window

def load_producer_findings(path):
    """Flatten findings from collected.json (array of envelopes) or one envelope."""
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(payload, list):
        extra = []
        for envelope in payload:
            if isinstance(envelope, dict):
                extra.extend(envelope.get("findings") or [])
        return extra
    if isinstance(payload, dict):
        return list(payload.get("findings") or [])
    return []

def merge_producer_findings(result):
    """Keep producer rows the agent dropped. Skip a producer finding when
    the agent already has one at the same file and a nearby line."""
    path = os.environ.get("REVIEW_PRODUCER_JSON") or ""
    if not path or not os.path.isfile(path):
        return result
    extra = load_producer_findings(path)
    if not extra:
        return result
    existing = list(result.get("findings") or [])
    added = []
    for finding in extra:
        if any(nearby_finding(finding, row) for row in existing):
            continue
        desc = (finding.get("description") or "").strip()
        if desc and any((row.get("description") or "").strip() == desc for row in existing):
            continue
        added.append(finding)
    if not added:
        return result
    result = dict(result)
    result["findings"] = existing + added
    return result

def group_findings(findings):
    order = ["critical", "high", "medium", "low", "info"]
    grouped = {s: [] for s in order}
    for f in findings:
        grouped.setdefault(f.get("severity") or "info", []).append(f)
    return [(s, grouped[s]) for s in order if grouped.get(s)]

def count_summary(findings):
    counts = []
    for severity, items in group_findings(findings):
        count = len(items)
        counts.append(f"`{count} {severity}`")
    return " · ".join(counts)

def action_presentation(action):
    return {
        "approve": ("TIP", "Approved"),
        "comment": ("WARNING", "Review comments"),
        "request-changes": ("CAUTION", "Changes requested"),
        "reject": ("CAUTION", "Approach rejected"),
        "failure": ("CAUTION", "Review failed"),
    }.get(action, ("NOTE", action.replace("-", " ").title()))

def severity_presentation(severity):
    return {
        "critical": "🔴",
        "high": "🟠",
        "medium": "🟡",
        "low": "🔵",
        "info": "⚪",
    }.get(severity, "⚪")

def category_title(category):
    return re.sub(r"[-_]+", " ", category or "finding").strip().capitalize()

def suppress_mentions(text):
    """Keep agent prose from turning @words into GitHub mentions/links."""
    return re.sub(r"@(?=[A-Za-z0-9-])", "@\u200b", text or "")

def render_location(result, finding, server_url):
    path = (finding.get("file") or "").strip()
    line = finding.get("line")
    label = f"{path}:{line}" if line else path
    repo = (result.get("repo") or os.environ.get("GITHUB_REPOSITORY") or "").strip("/")
    sha = (result.get("head_sha") or "").strip()
    if not path or path.lower() == "n/a" or not repo or not sha:
        return f"`{label}`"
    target = f"{server_url.rstrip('/')}/{repo}/blob/{sha}/{quote(path.lstrip('/'), safe='/')}"
    if line:
        target += f"#L{line}"
    safe_label = label.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
    return f"[{safe_label}]({target})"

def render_body(result, previous_md, action):
    sha = result.get("head_sha") or ""
    short = sha[:7] if sha else "unknown"
    risk = result.get("risk") or "unspecified"
    confidence = result.get("confidence") or "unspecified"
    started = os.environ.get("REVIEW_STARTED") or os.environ.get("FULLSEND_RUN_STARTED") or ""
    completed = datetime.now(timezone.utc).strftime("%H:%M UTC")
    run_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY") or result.get("repo") or ""
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_link = ""
    if repo and run_id:
        run_link = f"{run_url}/{repo}/actions/runs/{run_id}"

    findings = result.get("findings") or []
    callout, action_label = action_presentation(action)
    count_text = count_summary(findings)
    finding_text = count_text if count_text else "No actionable findings"
    risk_icon = severity_presentation(risk.lower())

    # Sticky copy is for the PR author: disposition and risk first, then
    # supporting Jira context and actionable findings. Host/agent action
    # disagreement stays in CI logs, not this body.
    lines = [
        "<!-- fullsend:review-poc -->",
        f"<!-- **Head SHA:** {sha} -->",
        "",
        "## 🤖 Fullsend review",
        "",
        f"> [!{callout}]",
        f"> **{action_label}** · {finding_text}",
        "",
        f"**Merge risk:** {risk_icon} {risk.capitalize()} · **Confidence:** {confidence.capitalize()}",
    ]
    meta = []
    if started:
        meta.append(f"Started {started}")
    meta.append(f"Completed {completed}")
    if run_link:
        meta.append(f"[View workflow run]({run_link})")
    lines.append("")

    pa = result.get("product_ask") if isinstance(result.get("product_ask"), dict) else None
    if pa:
        status = pa.get("status") or "none"
        extra = []
        if pa.get("needs_human"):
            extra.append("⚠️ needs human review")
        if pa.get("justified_in_description"):
            extra.append("justified in the PR description")
        suffix = f" · {'; '.join(extra)}" if extra else ""
        lines.append("<details>")
        lines.append(f"<summary>🎯 <strong>Product ask</strong> · <code>{status}</code>{suffix}</summary>")
        lines.append("")
        if status == "none":
            lines.append("No Jira snapshot, or no linked issue. Description remains the source of truth.")
            lines.append("")
        else:
            aligned = pa.get("aligned") or []
            mismatched = pa.get("mismatched") or []
            if aligned:
                lines.append("**Aligned**")
                for item in aligned:
                    lines.append(f"- {suppress_mentions(item)}")
                lines.append("")
            if mismatched:
                lines.append("**Mismatched**")
                for item in mismatched:
                    lines.append(f"- {suppress_mentions(item)}")
                lines.append("")
            lines.append("> The PR description remains the source of truth. This section compares it with Jira context; it does not review the diff against Jira acceptance criteria.")
            lines.append("")
        lines.append("</details>")
        lines.append("")

    lines.append("## Review findings")
    lines.append("")
    if not findings:
        lines.append("No actionable findings were generated. 🎉")
    else:
        finding_number = 0
        for sev, items in group_findings(findings):
            count = len(items)
            noun = "finding" if count == 1 else "findings"
            lines.append(f"### {severity_presentation(sev)} {sev.capitalize()} · {count} {noun}")
            lines.append("")
            for f in items:
                finding_number += 1
                loc = render_location(result, f, run_url)
                desc = suppress_mentions(f.get("description"))
                why = suppress_mentions(f.get("why"))
                rem = suppress_mentions(f.get("remediation"))
                lines.append(f"#### {finding_number}. {category_title(f.get('category'))} · {loc}")
                lines.append("")
                lines.append(desc)
                lines.append("")
                if why:
                    lines.append("<details>")
                    lines.append("<summary>Why this matters</summary>")
                    lines.append("")
                    lines.append(why)
                    lines.append("")
                    lines.append("</details>")
                    lines.append("")
                if rem:
                    lines.append(f"**Suggested change:** {rem}")
                    lines.append("")

    commit_link = ""
    if repo and sha:
        commit_link = f"[{short}]({run_url.rstrip('/')}/{repo}/commit/{sha})"
    else:
        commit_link = f"`{short}`"
    footer = [f"Reviewed commit {commit_link}"]
    footer.extend(meta)
    lines += ["", "---", "", f"<sub>{' · '.join(footer)}</sub>"]

    # previous_md is available if a later renderer wants history; this
    # body is the current run only.
    _ = previous_md
    return "\n".join(lines).rstrip() + "\n"

with open(sys.argv[1], encoding="utf-8") as fh:
    result = json.load(fh)
previous_md = os.environ.get("REVIEW_PREVIOUS_MARKDOWN", "")
result = inject_description_sot_findings(result)
result = merge_producer_findings(result)
result = apply_product_ask(result)
action, _reason = compute_action(result)
body = result.get("body")
if action != "failure":
    body = render_body(result, previous_md, action)
out = dict(result)
out["action"] = action
if body:
    out["body"] = body
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
}

# Fullsend v0.39.0 has no switch for summary-only review findings. Its CLI
# creates inline or file-level review comments only for findings that include
# a positive line number. Preserve findings for verdicts and approved-review
# follow-up issues, but remove line numbers from the copy passed to the CLI.
prepare_summary_only_result() {
  jq 'if (.findings | type) == "array" then .findings |= map(del(.line)) else . end' "$1" > "$2"
}

run_self_test() {
  local fail=0 tmp
  tmp=$(mktemp -d)
  cleanup_self_test() { rm -rf "${tmp}"; }
  trap cleanup_self_test EXIT

  expect_action() {
    local name="$1" json="$2" want="$3"
    local got
    printf '%s' "${json}" > "${tmp}/in.json"
    got=$(transform_review_result "${tmp}/in.json" | jq -r .action)
    if [[ "${got}" != "${want}" ]]; then
      echo "FAIL ${name}: want action=${want} got=${got}" >&2
      fail=1
    else
      echo "PASS ${name} (${want})"
    fi
  }

  expect_action high-blocks \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"severity":"high","category":"correctness","file":"a.go","description":"bug"}]}' \
    request-changes

  expect_action medium-style-comment \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"severity":"medium","category":"style-conventions","file":"a.tsx","description":"class name"}]}' \
    comment

  expect_action medium-functional-blocks \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"severity":"medium","category":"correctness","file":"a.go","description":"wrong behavior"}]}' \
    request-changes

  expect_action low-approve \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"severity":"low","category":"docs-currency","file":"README.md","description":"typo"}]}' \
    approve

  expect_action risk-blocks-approve \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","risk":"high","confidence":"high"}' \
    comment

  expect_action low-confidence-blocks \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","confidence":"low"}' \
    comment

  expect_action overwrite-agent-approve \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve","findings":[{"severity":"critical","category":"security","file":"a.go","description":"rce"}]}' \
    request-changes

  expect_action failure-passthrough \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"failure","reason":"tool-failure"}' \
    failure

  expect_action product-ask-aligned-approve \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","product_ask":{"status":"aligned","aligned":["same ask"],"mismatched":[],"justified_in_description":false,"needs_human":false}}' \
    approve

  expect_action product-ask-justified-needs-human \
    '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","product_ask":{"status":"mismatch-justified","aligned":[],"mismatched":["narrower scope"],"justified_in_description":true,"needs_human":true}}' \
    comment

  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","product_ask":{"status":"mismatch-unjustified","aligned":[],"mismatched":["Jira asks for export; PR does not mention it"],"justified_in_description":false}}' > "${tmp}/pa-unjust.json"
  local pa_out
  pa_out=$(transform_review_result "${tmp}/pa-unjust.json")
  if [[ "$(jq -r .action <<<"${pa_out}")" != "comment" ]]; then
    echo "FAIL product-ask-unjustified: want comment, got $(jq -r .action <<<"${pa_out}")" >&2
    fail=1
  elif [[ "$(jq -r .risk <<<"${pa_out}")" != "high" ]]; then
    echo "FAIL product-ask-unjustified: want risk=high, got $(jq -r .risk <<<"${pa_out}")" >&2
    fail=1
  elif [[ "$(jq -r .confidence <<<"${pa_out}")" != "low" ]]; then
    echo "FAIL product-ask-unjustified: want confidence=low, got $(jq -r .confidence <<<"${pa_out}")" >&2
    fail=1
  elif ! grep -q '<summary>🎯 <strong>Product ask</strong>' <<<"$(jq -r .body <<<"${pa_out}")"; then
    echo "FAIL product-ask-unjustified: renderer missing collapsed Product ask section" >&2
    fail=1
  else
    echo "PASS product-ask unjustified raises risk, drops confidence, comments"
  fi

  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve","findings":[{"severity":"low","category":"docs-currency","file":"README.md","line":12,"description":"Document @param behavior"}]}' > "${tmp}/render.json"
  local body rendered
  rendered=$(transform_review_result "${tmp}/render.json")
  body=$(jq -r .body <<<"${rendered}")
  if ! grep -q 'fullsend:review-poc' <<<"${body}"; then
    echo "FAIL render: missing poc marker" >&2
    fail=1
  else
    echo "PASS render marker"
  fi
  if ! grep -q '## 🤖 Fullsend review' <<<"${body}" || ! grep -Fq '> [!TIP]' <<<"${body}"; then
    echo "FAIL render: missing review heading or approve callout" >&2
    fail=1
  else
    echo "PASS render disposition callout"
  fi
  if ! grep -q '### 🔵 Low · 1 finding' <<<"${body}" || ! grep -q '#### 1. Docs currency' <<<"${body}"; then
    echo "FAIL render: missing severity count or readable finding heading" >&2
    fail=1
  else
    echo "PASS render finding hierarchy"
  fi
  if grep -q '@param' <<<"${body}"; then
    echo "FAIL render: agent prose can trigger a GitHub mention" >&2
    fail=1
  else
    echo "PASS render suppresses accidental mentions"
  fi
  if grep -q 'Previous run' <<<"${body}"; then
    echo "FAIL render: nested history should not appear" >&2
    fail=1
  else
    echo "PASS current-only body"
  fi
  if grep -q 'Host overwrote' <<<"${body}"; then
    echo "FAIL render: host/agent overwrite must not appear in sticky" >&2
    fail=1
  else
    echo "PASS sticky has no overwrite note"
  fi
  if ! grep -Fq '[README.md:12](https://github.com/o/r/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/README.md#L12)' <<<"${body}"; then
    echo "FAIL render: finding location is not a commit-pinned link" >&2
    fail=1
  else
    echo "PASS finding location links to reviewed commit"
  fi

  printf '%s' "${rendered}" > "${tmp}/rendered.json"
  prepare_summary_only_result "${tmp}/rendered.json" "${tmp}/summary-only.json"
  if ! jq -e '.findings[0].file == "README.md" and (.findings[0] | has("line") | not) and (.body | contains("README.md#L12"))' \
      "${tmp}/summary-only.json" >/dev/null; then
    echo "FAIL summary-only: expected body link with no structured line number" >&2
    fail=1
  else
    echo "PASS summary-only payload suppresses inline comments"
  fi

  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve","findings":[{"severity":"critical","category":"security","file":"a.go","description":"rce"}]}' > "${tmp}/overwrite.json"
  body=$(transform_review_result "${tmp}/overwrite.json" | jq -r .body)
  if grep -q 'Host overwrote' <<<"${body}"; then
    echo "FAIL render: overwrite note leaked when host changed action" >&2
    fail=1
  elif ! grep -q 'Changes requested' <<<"${body}"; then
    echo "FAIL render: expected changes-requested disposition in author-facing body" >&2
    fail=1
  else
    echo "PASS overwrite stays out of sticky"
  fi

  cat > "${tmp}/producer.json" <<'EOF'
[
  {"dimension":"alpha","findings":[
    {"severity":"high","category":"alpha","file":"helpers.ts","line":7,"description":"Math.random IDs"},
    {"severity":"medium","category":"alpha","file":"helpers.ts","line":24,"description":"object URL leak"}
  ]}
]
EOF
  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"severity":"high","category":"security","file":"helpers.ts","line":7,"description":"predictable IDs"}]}' > "${tmp}/with-sec.json"
  export REVIEW_PRODUCER_JSON="${tmp}/producer.json"
  local merged
  merged=$(transform_review_result "${tmp}/with-sec.json")
  unset REVIEW_PRODUCER_JSON
  if ! printf '%s' "${merged}" | jq -e \
    '.findings | length == 2 and any(.line == 7 and .category == "security") and any(.line == 24 and .category == "alpha")' \
    >/dev/null; then
    echo "FAIL producer merge: expected security :7 kept and leak :24 added, got $(printf '%s' "${merged}" | jq -c '[.findings[] | {line,category}]')" >&2
    fail=1
  else
    echo "PASS producer merge adds unique finding, skips same-line duplicate"
  fi

  # Missing required heading → host injects description-sot → request-changes
  export REVIEW_REQUIRED_HEADINGS=$'Problem\nSolution\nEvidence'
  export REVIEW_PR_BODY=$'## Problem\nUsers cannot export.\n'
  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve"}' > "${tmp}/sot-missing.json"
  local sot
  sot=$(transform_review_result "${tmp}/sot-missing.json")
  if [[ "$(jq -r .action <<<"${sot}")" != "request-changes" ]]; then
    echo "FAIL description-sot: want request-changes for missing heading" >&2
    fail=1
  elif [[ "$(jq '[.findings // [] | .[] | select(.category=="description-sot")] | length' <<<"${sot}")" != "2" ]]; then
    echo "FAIL description-sot: expected two missing-heading findings (Solution, Evidence)" >&2
    fail=1
  else
    echo "PASS description-sot missing heading blocks"
  fi

  export REVIEW_PR_BODY=$'## Problem\nUsers cannot export.\n\n## Solution\nAdd a helper.\n\n## Evidence\nUnit tests + screenshot.\n'
  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve"}' > "${tmp}/sot-ok.json"
  sot=$(transform_review_result "${tmp}/sot-ok.json")
  if [[ "$(jq -r .action <<<"${sot}")" != "approve" ]]; then
    echo "FAIL description-sot: want approve when required headings present" >&2
    fail=1
  elif [[ "$(jq '[.findings // [] | .[] | select(.category=="description-sot")] | length' <<<"${sot}")" != "0" ]]; then
    echo "FAIL description-sot: unexpected finding when headings present" >&2
    fail=1
  else
    echo "PASS description-sot headings present"
  fi

  # Words in prose are not headings; Impact/Test plan are optional
  export REVIEW_PR_BODY=$'Problem Solution Evidence Impact Test plan in a sentence.\n'
  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve"}' > "${tmp}/sot-prose.json"
  sot=$(transform_review_result "${tmp}/sot-prose.json")
  if [[ "$(jq '[.findings // [] | .[] | select(.category=="description-sot")] | length' <<<"${sot}")" != "3" ]]; then
    echo "FAIL description-sot: prose should not count as headings" >&2
    fail=1
  else
    echo "PASS description-sot ignores prose"
  fi
  if [[ "${REQUIRED_PR_HEADINGS[*]}" != "Problem Solution Evidence" ]]; then
    echo "FAIL description-sot: REQUIRED_PR_HEADINGS drifted (want Problem Solution Evidence)" >&2
    fail=1
  else
    echo "PASS description-sot required list"
  fi

  local tmpl
  tmpl="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../.github/PULL_REQUEST_TEMPLATE/agentic.md"
  export REVIEW_PR_BODY
  REVIEW_PR_BODY="$(cat "${tmpl}")"
  printf '%s' '{"pr_number":1,"repo":"o/r","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"approve"}' > "${tmp}/sot-tmpl.json"
  sot=$(transform_review_result "${tmp}/sot-tmpl.json")
  if [[ "$(jq '[.findings // [] | .[] | select(.category=="description-sot")] | length' <<<"${sot}")" != "3" ]]; then
    echo "FAIL description-sot: unused agentic template must still look unfilled" >&2
    fail=1
  else
    echo "PASS description-sot agentic template is unfilled"
  fi
  unset REVIEW_REQUIRED_HEADINGS REVIEW_PR_BODY

  if [[ "${fail}" -ne 0 ]]; then
    exit 1
  fi
  echo "All self-tests passed"
  trap - EXIT
  cleanup_self_test
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

: "${REVIEW_TOKEN:?REVIEW_TOKEN is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
if ! [[ "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  echo "::error::PR_NUMBER must be a positive integer" >&2
  exit 1
fi
: "${REPO_FULL_NAME:?REPO_FULL_NAME is required}"

echo "::add-mask::${REVIEW_TOKEN}"
export GH_TOKEN="${REVIEW_TOKEN}"

# Temp file cleanup: accumulate files to remove on exit so later traps
# don't overwrite earlier ones.
CLEANUP_FILES=()
trap 'rm -f "${CLEANUP_FILES[@]}"' EXIT

# Refuse to post reviews on merged or closed PRs.
# Also fetch draft status — draft PRs must not receive ready-for-merge.
PR_INFO=$(gh pr view "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --json state,isDraft)
PR_STATE=$(echo "${PR_INFO}" | jq -r '.state')
PR_IS_DRAFT=$(echo "${PR_INFO}" | jq -r '.isDraft')
if [ "${PR_STATE}" != "OPEN" ]; then
  echo "PR is ${PR_STATE}, skipping review"

  STATE_LOWER="$(echo "${PR_STATE}" | tr '[:upper:]' '[:lower:]')"
  COMMENT_BODY="Review skipped — this PR is already **${STATE_LOWER}**.

The \`/fs-review\` command only reviews open pull requests.

<sub>Posted by <a href=\"https://github.com/fullsend-ai/fullsend\">fullsend</a> post-review check</sub>"

  printf '%s' "${COMMENT_BODY}" | gh issue comment "${PR_NUMBER}" \
    --repo "${REPO_FULL_NAME}" --body-file - 2>/dev/null || true

  exit 0
fi

# Find the agent result — prefer the validated iteration when set.
# Trust boundary: FULLSEND_VALIDATED_ITERATION_DIR is set by the fullsend CLI
# on the runner — not by the sandbox or the agent. No containment check
# (realpath / prefix guard) is applied here; the value is trusted from the
# external harness. If the trust model changes, add a realpath prefix check.
if [[ -n "${FULLSEND_VALIDATED_ITERATION_DIR:-}" ]]; then
  if [[ -f "${FULLSEND_VALIDATED_ITERATION_DIR}/agent-result.json" ]]; then
    RESULT_FILE="${FULLSEND_VALIDATED_ITERATION_DIR}/agent-result.json"
  elif [[ -f "${FULLSEND_VALIDATED_ITERATION_DIR}/result.json" ]]; then
    RESULT_FILE="${FULLSEND_VALIDATED_ITERATION_DIR}/result.json"
  else
    echo "::error::FULLSEND_VALIDATED_ITERATION_DIR is set but contains neither agent-result.json nor result.json" >&2
    exit 1
  fi
else
  RESULT_FILE=$(find .  -maxdepth 4 -path '*/iteration-*/output/agent-result.json' | sort -V | tail -1)
fi

if [ -z "${RESULT_FILE}" ] || [ ! -f "${RESULT_FILE}" ]; then
  echo "::error::No agent-result.json found — posting failure notice"
  echo '{"action":"failure","reason":"agent-no-output"}' | \
    fullsend post-review \
      --repo "${REPO_FULL_NAME}" \
      --pr "${PR_NUMBER}" \
      --token "${REVIEW_TOKEN}" \
      --result -
  exit 1
fi

echo "Using result: ${RESULT_FILE}"

# ---------------------------------------------------------------------------
# Severity filtering: drop findings below the configured threshold.
# Defense-in-depth — the agent should already have filtered, but the
# post-script enforces it. The filter runs before ACTION is read so
# that verdict recalculation (if all findings are removed) is possible.
# ---------------------------------------------------------------------------
REVIEW_FINDING_SEVERITY_THRESHOLD="${REVIEW_FINDING_SEVERITY_THRESHOLD:-}"
case "${REVIEW_FINDING_SEVERITY_THRESHOLD}" in
  info|low|medium|high|critical) ;;
  *) # Sanitize before interpolating into a workflow command. Strip raw
     # newlines, then strip every '%' and ':' character outright rather than
     # matching specific multi-char tokens (e.g. "%0A", "::") — matching
     # fixed-width tokens is not idempotent and can be bypassed by adjacent
     # fragments reassembling after a single pass (e.g. "%0%0aA" -> "%0A",
     # ':::error:::' -> '::error::'). Removing every occurrence of a single
     # character in one pass can't reassemble into that character.
     sanitized="${REVIEW_FINDING_SEVERITY_THRESHOLD//$'\n'/}"
     sanitized="${sanitized//$'\r'/}"
     sanitized="${sanitized//%/}"
     sanitized="${sanitized//:/}"
     echo "::error::REVIEW_FINDING_SEVERITY_THRESHOLD='${sanitized}' is invalid (expected info|low|medium|high|critical)"
     echo '{"action":"failure","reason":"tool-failure"}' | \
       fullsend post-review \
         --repo "${REPO_FULL_NAME}" \
         --pr "${PR_NUMBER}" \
         --token "${REVIEW_TOKEN}" \
         --result -
     exit 1 ;;
esac

severity_rank() {
  case "$1" in
    info)     echo 0 ;;
    low)      echo 1 ;;
    medium)   echo 2 ;;
    high)     echo 3 ;;
    critical) echo 4 ;;
    *)        echo 1 ;;
  esac
}

threshold_rank=$(severity_rank "$REVIEW_FINDING_SEVERITY_THRESHOLD")

if jq -e '.findings' "${RESULT_FILE}" >/dev/null 2>&1; then
  original_count=$(jq '.findings | length' "${RESULT_FILE}")
  FILTERED_RESULT=$(mktemp)
  CLEANUP_FILES+=("${FILTERED_RESULT}")
  jq --argjson rank "$threshold_rank" '
    .findings |= [.[] | select(
      (if .severity == "info" then 0
       elif .severity == "low" then 1
       elif .severity == "medium" then 2
       elif .severity == "high" then 3
       elif .severity == "critical" then 4
       else 1 end) >= $rank
    )]
  ' "${RESULT_FILE}" > "${FILTERED_RESULT}"
  filtered_count=$(jq '.findings | length' "${FILTERED_RESULT}")

  if [ "${filtered_count}" -lt "${original_count}" ]; then
    echo "Severity filter (threshold=${REVIEW_FINDING_SEVERITY_THRESHOLD}): kept ${filtered_count}/${original_count} findings"
    RESULT_FILE="${FILTERED_RESULT}"

    # If filtering removed all findings, delete the empty findings array
    # (minItems: 1 in the schema). For request-changes/reject, also
    # downgrade to comment — zero findings with a blocking verdict is
    # semantically wrong. Use "comment" (not "approve") so the PR gets
    # requires-manual-review, not ready-for-merge.
    if [ "${filtered_count}" -eq 0 ]; then
      original_action=$(jq -r '.action' "${FILTERED_RESULT}")
      DOWNGRADE_RESULT=$(mktemp)
      CLEANUP_FILES+=("${DOWNGRADE_RESULT}")
      if [ "${original_action}" = "request-changes" ] || [ "${original_action}" = "reject" ]; then
        echo "All findings removed by severity filter — downgrading '${original_action}' to 'comment'"
        jq 'del(.findings) | .action = "comment"' "${FILTERED_RESULT}" > "${DOWNGRADE_RESULT}"
      else
        jq 'del(.findings)' "${FILTERED_RESULT}" > "${DOWNGRADE_RESULT}"
      fi
      RESULT_FILE="${DOWNGRADE_RESULT}"
    fi
  else
    rm -f "${FILTERED_RESULT}"
  fi
fi

# Set action and comment body after the severity filter so dropped
# findings do not affect the GitHub review.
PREVIOUS_MD=""
if [[ -n "${PRIOR_REVIEW_FILE:-}" && -f "${PRIOR_REVIEW_FILE}" ]]; then
  PREVIOUS_MD=$(cat "${PRIOR_REVIEW_FILE}")
elif [[ -f prior-review.txt ]]; then
  PREVIOUS_MD=$(cat prior-review.txt)
fi
export REVIEW_PREVIOUS_MARKDOWN="${PREVIOUS_MD}"

# Required headings: fetch the PR body when REQUIRED_PR_HEADINGS is set.
# Edit the list in pr-description-sot.sh.
if [[ ${#REQUIRED_PR_HEADINGS[@]} -gt 0 ]]; then
  REVIEW_REQUIRED_HEADINGS=$(printf '%s\n' "${REQUIRED_PR_HEADINGS[@]}")
  export REVIEW_REQUIRED_HEADINGS
  REVIEW_PR_BODY=$(gh pr view "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --json body --jq .body 2>/dev/null || true)
  export REVIEW_PR_BODY
  echo "Checking ${#REQUIRED_PR_HEADINGS[@]} required PR heading(s)"
else
  export REVIEW_REQUIRED_HEADINGS=""
  export REVIEW_PR_BODY=""
fi

echo "Transforming review result (action + comment body) using ${RESULT_FILE}"
export REVIEW_PRODUCER_JSON="${REVIEW_PRODUCER_JSON:-${_SCRIPT_DIR}/../.run/collected.json}"
AGENT_ACTION=$(jq -r '.action // "omitted"' "${RESULT_FILE}")
TRANSFORMED=$(mktemp)
CLEANUP_FILES+=("${TRANSFORMED}")
transform_review_result "${RESULT_FILE}" > "${TRANSFORMED}"
cp "${TRANSFORMED}" "${RESULT_FILE}"
echo "Host action=$(jq -r .action "${RESULT_FILE}") (agent had ${AGENT_ACTION})"

ACTION=$(jq -r '.action' "${RESULT_FILE}")
# ACTION retains the original value for the entire script — not re-read after protected-path downgrade.

# ---------------------------------------------------------------------------
# Protected-path check: the review agent must not approve PRs that touch
# sensitive paths. If the PR modifies any of these, downgrade "approve" to
# "comment" so only a human can grant approval. This is the sole enforcement
# point — the code agent is free to propose changes to any path.
# ---------------------------------------------------------------------------
DOWNGRADED=false
if [ "${ACTION}" = "approve" ]; then
  # harness/review.yaml always sets REVIEW_PROTECTED_PATHS (with a default,
  # overridable per-repo via harness composition), so an unset value here
  # indicates a genuine misconfiguration rather than an intentional opt-out.
  if [[ "${REVIEW_PROTECTED_PATHS+set}" != "set" ]]; then
    echo "::error::REVIEW_PROTECTED_PATHS is not set — check harness/review.yaml" >&2
    exit 1
  fi

  if [[ -z "${REVIEW_PROTECTED_PATHS}" ]]; then
    # Explicitly empty — operator has opted out of protected-path
    # enforcement for this repo. Distinct from comma-noise below, which
    # is treated as a likely misconfiguration rather than an intentional
    # opt-out.
    echo "::notice::REVIEW_PROTECTED_PATHS is explicitly empty — protected-path enforcement disabled"
    REVIEW_ACTIVE_PROTECTED_PATHS=()
  else
    IFS=',' read -ra REVIEW_ACTIVE_PROTECTED_PATHS <<< "${REVIEW_PROTECTED_PATHS}"
    # Trim leading/trailing whitespace and drop empty entries.
    trimmed=()
    for entry in "${REVIEW_ACTIVE_PROTECTED_PATHS[@]}"; do
      entry="$(echo "${entry}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -n "${entry}" ]] && trimmed+=("${entry}")
    done
    REVIEW_ACTIVE_PROTECTED_PATHS=()
    [[ ${#trimmed[@]} -gt 0 ]] && REVIEW_ACTIVE_PROTECTED_PATHS=("${trimmed[@]}")
    unset trimmed entry
    if [[ ${#REVIEW_ACTIVE_PROTECTED_PATHS[@]} -eq 0 ]]; then
      # Sanitize before interpolating into a workflow command. Strip raw
      # newlines, then strip every '%' and ':' character outright rather
      # than collapsing fixed-width tokens (e.g. "::", "%0A") — matching
      # fixed-width tokens is not idempotent and can be bypassed by
      # adjacent fragments reassembling after a single pass. Same
      # approach as the REVIEW_FINDING_SEVERITY_THRESHOLD sanitization
      # above.
      sanitized_paths="${REVIEW_PROTECTED_PATHS//$'\n'/}"
      sanitized_paths="${sanitized_paths//$'\r'/}"
      sanitized_paths="${sanitized_paths//%/}"
      sanitized_paths="${sanitized_paths//:/}"
      echo "::error::REVIEW_PROTECTED_PATHS=\"${sanitized_paths}\" contains no valid path entries after trimming — likely misconfigured (stray/consecutive commas?). Refusing to continue (fail-closed)." >&2
      unset sanitized_paths
      exit 1
    fi
  fi

  # PR-files fetch and the empty-result guard are an independent safety
  # net (refuse to approve if we can't establish what changed) and must
  # run regardless of whether protected-path enforcement itself is
  # enabled — only the pattern-matching loop below is gated on a
  # non-empty REVIEW_ACTIVE_PROTECTED_PATHS.
  PR_FILES=$(gh pr view "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --json files --jq '.files[].path')
  if [ -z "${PR_FILES}" ]; then
    echo "::error::Failed to fetch PR files or PR has no changed files — refusing to approve (gh pr view --json files)" >&2
    exit 1
  fi

  if [[ ${#REVIEW_ACTIVE_PROTECTED_PATHS[@]} -gt 0 ]]; then
    PROTECTED_MATCHES=""
    while IFS= read -r file; do
      [ -z "${file}" ] && continue
      for pattern in "${REVIEW_ACTIVE_PROTECTED_PATHS[@]}"; do
        if [[ "${file}" == "${pattern}"* ]]; then
          PROTECTED_MATCHES="${PROTECTED_MATCHES}${file}"$'\n'
          break
        fi
      done
    done <<< "${PR_FILES}"

    if [ -n "${PROTECTED_MATCHES}" ]; then
      echo "PR touches protected paths — downgrading approve to comment"
      echo "${PROTECTED_MATCHES}" | sed '/^$/d' | sed 's/^/  /'

      PROTECTED_NOTICE=$'\n\n---\n\n'
      PROTECTED_NOTICE+=$'> **Protected paths detected** — this PR modifies files under one or more\n'
      PROTECTED_NOTICE+=$'> protected paths. The review agent cannot approve PRs that touch these paths.\n'
      PROTECTED_NOTICE+=$'> A human reviewer must approve this PR.\n'
      PROTECTED_NOTICE+=$'>\n'
      PROTECTED_NOTICE+=$'> Protected files in this PR:\n'
      while IFS= read -r f; do
        [ -z "${f}" ] && continue
        PROTECTED_NOTICE+="> - \`${f}\`"$'\n'
      done <<< "${PROTECTED_MATCHES}"

      # Rewrite the result file with downgraded action and appended notice.
      MODIFIED_RESULT=$(mktemp)
      CLEANUP_FILES+=("${MODIFIED_RESULT}")
      jq --arg notice "${PROTECTED_NOTICE}" \
        '.action = "comment" | .body = (.body + $notice)' \
        "${RESULT_FILE}" > "${MODIFIED_RESULT}"
      RESULT_FILE="${MODIFIED_RESULT}"
      DOWNGRADED=true
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Label-actions validation: the review agent may recommend contextual labels
# (e.g. area/api, priority/high). Validate them here so the label reason
# appears in the review body. Actual label API calls happen after posting.
# ---------------------------------------------------------------------------
REVIEW_CONTROL_LABELS=(
  "ready-for-merge" "requires-manual-review" "rejected"
  "ready-for-review" "fullsend-no-fix" "fullsend-fix"
)

is_control_label() {
  local label="$1"
  for cl in "${REVIEW_CONTROL_LABELS[@]}"; do
    if [[ "${cl}" == "${label}" ]]; then
      return 0
    fi
  done
  return 1
}

VALIDATED_LABEL_ADDS=()
VALIDATED_LABEL_REMOVES=()
LABEL_REASON=""

HAS_LABEL_ACTIONS=$(jq 'has("label_actions")' "${RESULT_FILE}")
if [[ "${HAS_LABEL_ACTIONS}" == "true" ]]; then
  LABEL_REASON=$(jq -r '.label_actions.reason' "${RESULT_FILE}")
  LABEL_COUNT=$(jq '.label_actions.actions | length' "${RESULT_FILE}")

  echo "Validating ${LABEL_COUNT} label action(s)..."

  # Fetch existing repo labels once.
  EXISTING_LABELS=$(gh api "repos/${REPO_FULL_NAME}/labels" --paginate --jq '.[].name' 2>/dev/null || true)

  label_exists() {
    local label="$1"
    echo "${EXISTING_LABELS}" | grep -qFx "${label}"
  }

  for i in $(seq 0 $((LABEL_COUNT - 1))); do
    LA_ACTION=$(jq -r ".label_actions.actions[${i}].action" "${RESULT_FILE}")
    LA_LABEL=$(jq -r ".label_actions.actions[${i}].label" "${RESULT_FILE}")

    # Sanitize jq -r output: strip newlines, carriage returns, and GHA
    # workflow command delimiters to prevent command injection via crafted
    # label names or action values.
    LA_ACTION="${LA_ACTION//$'\n'/}"
    LA_ACTION="${LA_ACTION//$'\r'/}"
    LA_ACTION="${LA_ACTION//::/:}"
    LA_LABEL="${LA_LABEL//$'\n'/}"
    LA_LABEL="${LA_LABEL//$'\r'/}"
    LA_LABEL="${LA_LABEL//::/:}"

    if [[ ! "${LA_LABEL}" =~ ^[a-zA-Z0-9._/:\ +\-]+$ ]]; then
      echo "::warning::Refused label '${LA_LABEL}' -- contains invalid characters"
      continue
    fi

    if is_control_label "${LA_LABEL}"; then
      echo "::warning::Refused to ${LA_ACTION} control label '${LA_LABEL}' -- control labels are managed by the review pipeline"
      continue
    fi

    case "${LA_ACTION}" in
      add)
        if ! label_exists "${LA_LABEL}"; then
          echo "::warning::Skipping label '${LA_LABEL}' -- does not exist in repo (will not auto-create)"
          continue
        fi
        VALIDATED_LABEL_ADDS+=("${LA_LABEL}")
        ;;
      remove)
        VALIDATED_LABEL_REMOVES+=("${LA_LABEL}")
        ;;
      *)
        echo "::warning::Unknown label action '${LA_ACTION}' for label '${LA_LABEL}'"
        ;;
    esac
  done

  # Append label reason to body if any labels validated.
  VALIDATED_COUNT=$(( ${#VALIDATED_LABEL_ADDS[@]} + ${#VALIDATED_LABEL_REMOVES[@]} ))
  if [[ "${VALIDATED_COUNT}" -gt 0 ]]; then
    LABEL_NOTICE=$'\n\n---\n'"**Labels:** ${LABEL_REASON}"
    LABEL_MODIFIED_RESULT=$(mktemp)
    CLEANUP_FILES+=("${LABEL_MODIFIED_RESULT}")
    jq --arg notice "${LABEL_NOTICE}" \
      '.body = (.body + $notice)' \
      "${RESULT_FILE}" > "${LABEL_MODIFIED_RESULT}"
    RESULT_FILE="${LABEL_MODIFIED_RESULT}"
  fi
fi

# ---------------------------------------------------------------------------
# Post the review. Exit code 10 = stale-head: the PR HEAD moved after the
# agent reviewed it. When this happens, post a /fs-review comment to
# re-dispatch a fresh review for the current HEAD.
# ---------------------------------------------------------------------------
POST_RESULT_FILE=$(mktemp)
CLEANUP_FILES+=("${POST_RESULT_FILE}")
prepare_summary_only_result "${RESULT_FILE}" "${POST_RESULT_FILE}"
INLINE_LOCATION_COUNT=$(jq '[.findings[]? | select(.line != null)] | length' "${RESULT_FILE}")
if [ "${INLINE_LOCATION_COUNT}" -gt 0 ]; then
  echo "Summary-only review: linked ${INLINE_LOCATION_COUNT} finding location(s) in the sticky comment; inline comments disabled"
fi

POST_REVIEW_EXIT=0
fullsend post-review \
  --repo "${REPO_FULL_NAME}" \
  --pr "${PR_NUMBER}" \
  --token "${REVIEW_TOKEN}" \
  --result "${POST_RESULT_FILE}" || POST_REVIEW_EXIT=$?

if [ "${POST_REVIEW_EXIT}" -eq 10 ]; then
  echo "Stale-head detected — checking whether to re-dispatch review"

  # Loop guard: if a stale-head re-dispatch comment was posted recently
  # (within the last 5 minutes), skip to avoid cascading dispatches from
  # rapid force-pushes. The next synchronize event will pick it up.
  REDISPATCH_MARKER="<!-- fullsend:stale-head-redispatch -->"
  RECENT_REDISPATCH=$(gh api \
    "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments" \
    --paginate 2>/dev/null \
    | jq -s "add // [] | [.[] | select(.body | contains(\"${REDISPATCH_MARKER}\"))
          | select(.created_at > (now - 300 | strftime(\"%Y-%m-%dT%H:%M:%SZ\")))]
     | length") || RECENT_REDISPATCH=0

  if [ "${RECENT_REDISPATCH}" -gt 0 ]; then
    echo "Recent stale-head re-dispatch already exists — skipping"
  else
    echo "Re-dispatching review for current HEAD"
    gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
      --body "/fs-review
${REDISPATCH_MARKER}" || echo "::warning::Failed to post re-dispatch comment"
  fi

  # Stale-head is handled gracefully — exit 0 so the workflow does not
  # appear as a failure.
  exit 0
elif [ "${POST_REVIEW_EXIT}" -ne 0 ]; then
  echo "::error::fullsend post-review failed with exit code ${POST_REVIEW_EXIT} (PR #${PR_NUMBER} in ${REPO_FULL_NAME})" >&2
  exit "${POST_REVIEW_EXIT}"
fi

# ---------------------------------------------------------------------------
# Outcome labels: apply labels based on the review action.
# Labels are created if missing, matching the needs-human pattern in
# post-fix.sh.
# Label logic is mirrored in post-review-test.sh — update both.
# ---------------------------------------------------------------------------

# Determine the target outcome label before mutating anything so we can
# skip no-op remove/re-add cycles that generate timeline noise.
OUTCOME_LABEL=""
if [ "${ACTION}" = "approve" ] && [ "${DOWNGRADED}" = "false" ] && [ "${PR_IS_DRAFT}" != "true" ]; then
  OUTCOME_LABEL="ready-for-merge"
elif { [ "${ACTION}" = "approve" ] && { [ "${DOWNGRADED}" = "true" ] || [ "${PR_IS_DRAFT}" = "true" ]; }; } || \
     [ "${ACTION}" = "comment" ]; then
  OUTCOME_LABEL="requires-manual-review"
elif [ "${ACTION}" = "reject" ]; then
  OUTCOME_LABEL="rejected"
fi

# Remove stale outcome labels from prior runs, skipping the label we are
# about to apply so we don't create a pointless unlabel/relabel cycle.
# 2>/dev/null is intentional: removal of a non-existent label is the
# common case and not worth logging.
for stale_label in "ready-for-merge" "requires-manual-review" "rejected"; do
  [ "${stale_label}" = "${OUTCOME_LABEL}" ] && continue
  gh pr edit "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
    --remove-label "${stale_label}" 2>/dev/null || true
done

if [ "${OUTCOME_LABEL}" = "ready-for-merge" ]; then
  echo "Approve disposition — applying ready-for-merge label"
  gh label create "ready-for-merge" --repo "${REPO_FULL_NAME}" \
    --description "All reviewers approved — ready to merge" --color "0E8A16" \
    2>/dev/null || true
  gh pr edit "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
    --add-label "ready-for-merge" || true
elif [ "${OUTCOME_LABEL}" = "requires-manual-review" ]; then
  if [ "${PR_IS_DRAFT}" = "true" ] && [ "${ACTION}" = "approve" ]; then
    echo "PR is a draft — skipping ready-for-merge, applying requires-manual-review"
  else
    echo "Review requires human judgment — applying requires-manual-review label"
  fi
  gh label create "requires-manual-review" --repo "${REPO_FULL_NAME}" \
    --description "Review requires human judgment" --color "FBCA04" \
    2>/dev/null || true
  gh pr edit "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
    --add-label "requires-manual-review" || true
elif [ "${OUTCOME_LABEL}" = "rejected" ]; then
  echo "Reject disposition — closing PR and applying label"
  gh label create "rejected" --repo "${REPO_FULL_NAME}" \
    --description "Approach rejected by review agent" --color "B60205" \
    2>/dev/null || true
  gh pr close "${PR_NUMBER}" \
    --repo "${REPO_FULL_NAME}" \
    --comment "Closed by review agent: approach rejected." || true
  gh pr edit "${PR_NUMBER}" \
    --repo "${REPO_FULL_NAME}" \
    --add-label "rejected" || true
elif [ "${ACTION}" = "request-changes" ]; then
  echo "Request-changes disposition — no outcome label (fix agent triggers on event)"
fi

# ---------------------------------------------------------------------------
# Contextual labels: apply validated label mutations from label_actions.
# ---------------------------------------------------------------------------
for label in "${VALIDATED_LABEL_ADDS[@]}"; do
  echo "Adding contextual label '${label}'..."
  gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/labels" \
    -f "labels[]=${label}" --silent || \
    echo "::warning::Failed to add label '${label}'"
done

for label in "${VALIDATED_LABEL_REMOVES[@]}"; do
  echo "Removing contextual label '${label}'..."
  encoded=$(printf '%s' "${label}" | jq -sRr @uri)
  gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/labels/${encoded}" \
    -X DELETE --silent 2>/dev/null || true
done

echo "Review posted on ${REPO_FULL_NAME}#${PR_NUMBER}"
