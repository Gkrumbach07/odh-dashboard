#!/usr/bin/env bash
set -euo pipefail

# Reads /tmp/preflight-results.json and produces:
#   /tmp/preflight-comment.md  — summary PR comment
#   /tmp/review.json           — inline review comments (if any)
#
# Usage: format-results.sh <owner> <repo> <pr_number> <run_url>

RESULTS="/tmp/preflight-results.json"
if [ ! -f "$RESULTS" ]; then
  echo "No results file found at $RESULTS"
  exit 0
fi

OWNER="${1:?Usage: format-results.sh <owner> <repo> <pr> <run_url>}"
REPO="${2:?}"
PR="${3:?}"
RUN_URL="${4:-}"

# Status emoji map
status_emoji() {
  case "$1" in
    passed)  echo "✅" ;;
    failed)  echo "❌" ;;
    warning) echo "⚠️" ;;
    covered) echo "⏭️" ;;
    na)      echo "➖" ;;
    *)       echo "❓" ;;
  esac
}

# Verdict emoji
verdict_raw=$(jq -r '.verdict' "$RESULTS")
case "$verdict_raw" in
  READY)               verdict_emoji="✅"; verdict_text="READY" ;;
  READY_WITH_WARNINGS) verdict_emoji="⚠️"; verdict_text="READY WITH WARNINGS" ;;
  NOT_READY)           verdict_emoji="❌"; verdict_text="NOT READY" ;;
  *)                   verdict_emoji="❓"; verdict_text="$verdict_raw" ;;
esac

mode=$(jq -r '.mode' "$RESULTS")
commit=$(jq -r '.commit' "$RESULTS")

# Build summary comment
{
  echo "<!-- odh-preflight-agent -->"
  echo "## Preflight Agent Report"
  echo ""
  echo "**Verdict:** $verdict_emoji $verdict_text"
  echo "**Mode:** $mode"
  echo "**Commit:** \`$commit\`"
  echo ""
  echo "### Checks"
  echo ""
  echo "| Check | Status | Details |"
  echo "|-------|--------|---------|"

  jq -r '.checks[] | "\(.name)\t\(.status)\t\(.details)"' "$RESULTS" | while IFS=$'\t' read -r name status details; do
    emoji=$(status_emoji "$status")
    echo "| $name | $emoji | $details |"
  done

  # Group findings by severity
  for sev in critical major minor nit; do
    case "$sev" in
      critical) icon="🔴 Critical" ;;
      major)    icon="🟠 Major" ;;
      minor)    icon="🟡 Minor" ;;
      nit)      icon="🟢 Nit" ;;
    esac

    count=$(jq "[.findings[] | select(.severity == \"$sev\")] | length" "$RESULTS")
    if [ "$count" -gt 0 ]; then
      echo ""
      echo "<details>"
      echo "<summary>$icon ($count)</summary>"
      echo ""
      echo "| File | Issue |"
      echo "|------|-------|"
      jq -r ".findings[] | select(.severity == \"$sev\") | \"\(.file // \"—\"):\(.line // \"—\")\t\(.title)\"" "$RESULTS" | while IFS=$'\t' read -r loc title; do
        echo "| \`$loc\` | $title |"
      done
      echo ""
      echo "</details>"
    fi
  done

  echo ""
  echo "---"
  if [ -n "$RUN_URL" ]; then
    echo "*Automated by [ODH Dashboard Agent]($RUN_URL)*"
  else
    echo "*Automated by ODH Dashboard Agent*"
  fi
} > /tmp/preflight-comment.md

echo "Summary comment written to /tmp/preflight-comment.md"

# Build inline review JSON (critical + major + minor only, not nits)
inline_count=$(jq '[.findings[] | select(.severity != "nit" and .file != null and .line != null)] | length' "$RESULTS")

if [ "$inline_count" -gt 0 ]; then
  jq '{
    event: "COMMENT",
    body: "",
    comments: [
      .findings[]
      | select(.severity != "nit" and .file != null and .line != null)
      | {
          path: .file,
          line: .line,
          body: (
            (if .severity == "critical" then "🔴 Critical"
             elif .severity == "major" then "🟠 Major"
             else "🟡 Minor" end)
            + "\n\n**" + .title + "**\n\n" + .description
            + (if .diff then
                "\n\n<details>\n<summary>Proposed fix</summary>\n\n```diff\n" + .diff + "\n```\n\n</details>"
              else "" end)
          )
        }
    ]
  }' "$RESULTS" > /tmp/review.json
  echo "Inline review written to /tmp/review.json ($inline_count comments)"
else
  echo "No inline review comments needed"
fi
