#!/usr/bin/env bash
# Post-script for the ODH review agent.
# Runs on the GitHub Actions runner AFTER the sandbox.
# Reads agent-result.json, posts a PR review with inline comments and summary.
#
# Environment variables (set by workflow):
#   PR_NUMBER, HEAD_SHA, OWNER, REPO, GH_TOKEN

set -euo pipefail

output_dir="${FULLSEND_OUTPUT_DIR:-/workspace/output}"
result_file="$output_dir/agent-result.json"

pr_number="${PR_NUMBER:?PR_NUMBER is required}"
head_sha="${HEAD_SHA:?HEAD_SHA is required}"
owner="${OWNER:-$(gh repo view --json owner --jq '.owner.login')}"
repo="${REPO:-$(gh repo view --json name --jq '.name')}"

if [ ! -f "$result_file" ]; then
  echo "[post-review] ERROR: agent-result.json not found at $result_file"
  exit 1
fi

echo "[post-review] Processing agent result for PR #${pr_number}"

action=$(jq -r '.action' "$result_file")
body=$(jq -r '.body // "Review completed."' "$result_file")
findings_count=$(jq '.findings | length' "$result_file")

echo "[post-review] Action: $action, Findings: $findings_count"

# Map action to GitHub review event
case "$action" in
  approve)         event="APPROVE" ;;
  request-changes) event="REQUEST_CHANGES" ;;
  comment|*)       event="COMMENT" ;;
esac

# Severity badge mapping
severity_badge() {
  case "$1" in
    critical) echo "🔴 Critical" ;;
    high)     echo "🟠 Major" ;;
    medium)   echo "🟡 Minor" ;;
    low)      echo "🧹 Nit" ;;
    info)     echo "ℹ️ Info" ;;
    *)        echo "$1" ;;
  esac
}

# Source skill display name
skill_display() {
  case "$1" in
    style-review)     echo "Style review" ;;
    rbac-review)      echo "RBAC review" ;;
    jira-eval-review) echo "Jira Eval review" ;;
    claude-review)    echo "Claude review" ;;
    *)                echo "$1" ;;
  esac
}

# Build inline comments for critical/high/medium findings (not low/info — those are nits)
comments='[]'
for i in $(seq 0 $((findings_count - 1))); do
  severity=$(jq -r ".findings[$i].severity" "$result_file")
  file=$(jq -r ".findings[$i].file" "$result_file")
  line=$(jq -r ".findings[$i].line // empty" "$result_file")
  description=$(jq -r ".findings[$i].description" "$result_file")
  remediation=$(jq -r ".findings[$i].remediation // empty" "$result_file")
  source=$(jq -r ".findings[$i].source_skill // \"\"" "$result_file")
  category=$(jq -r ".findings[$i].category // \"\"" "$result_file")

  # Only post inline comments for critical/high/medium
  if [[ "$severity" == "low" || "$severity" == "info" ]]; then
    continue
  fi

  # Skip findings without a file or line
  if [[ -z "$file" || -z "$line" || "$line" == "null" ]]; then
    continue
  fi

  badge=$(severity_badge "$severity")
  source_display=$(skill_display "$source")
  comment_body="_${badge}_ · _${source_display}_\n\n**${description}**"
  if [ -n "$remediation" ] && [ "$remediation" != "null" ]; then
    comment_body="${comment_body}\n\n<details>\n<summary>Suggested fix</summary>\n\n${remediation}\n\n</details>"
  fi

  comments=$(echo "$comments" | jq -c \
    --arg path "$file" \
    --argjson line "$line" \
    --arg body "$comment_body" \
    '. + [{"path": $path, "line": $line, "body": $body}]')
done

inline_count=$(echo "$comments" | jq 'length')
echo "[post-review] Inline comments: $inline_count"

# Build review JSON
review_file="$output_dir/review-payload.json"
jq -n \
  --arg event "$event" \
  --arg body "$body" \
  --arg commit_id "$head_sha" \
  --argjson comments "$comments" \
  '{
    event: $event,
    body: $body,
    commit_id: $commit_id,
    comments: $comments
  }' > "$review_file"

# Post the review
echo "[post-review] Posting review (event=$event)..."
gh api "repos/$owner/$repo/pulls/$pr_number/reviews" \
  --input "$review_file" \
  --jq '.id' || {
    echo "[post-review] WARNING: Failed to post review, trying without inline comments"
    jq 'del(.comments)' "$review_file" > "${review_file}.fallback"
    gh api "repos/$owner/$repo/pulls/$pr_number/reviews" \
      --input "${review_file}.fallback" \
      --jq '.id' || echo "[post-review] ERROR: Failed to post review"
  }

# Apply label actions if present
label_actions=$(jq -r '.label_actions.actions // []' "$result_file")
label_count=$(echo "$label_actions" | jq 'length')
if [ "$label_count" -gt 0 ]; then
  echo "[post-review] Applying $label_count label actions..."
  for i in $(seq 0 $((label_count - 1))); do
    label_action=$(echo "$label_actions" | jq -r ".[$i].action")
    label_name=$(echo "$label_actions" | jq -r ".[$i].label")
    case "$label_action" in
      add)
        gh api "repos/$owner/$repo/issues/$pr_number/labels" \
          -f "labels[]=$label_name" --silent 2>/dev/null || true
        echo "[post-review]   + $label_name"
        ;;
      remove)
        gh api "repos/$owner/$repo/issues/$pr_number/labels/$label_name" \
          -X DELETE --silent 2>/dev/null || true
        echo "[post-review]   - $label_name"
        ;;
    esac
  done
fi

# Create/update check run
echo "[post-review] Creating check run..."
case "$action" in
  approve)
    conclusion="success"
    title="Fullsend Review — Approved"
    ;;
  request-changes)
    conclusion="failure"
    title="Fullsend Review — Changes Requested ($findings_count findings)"
    ;;
  *)
    conclusion="neutral"
    title="Fullsend Review — $findings_count findings"
    ;;
esac

gh api "repos/$owner/$repo/check-runs" \
  -f "name=ODH Fullsend Review" \
  -f "head_sha=$head_sha" \
  -f "status=completed" \
  -f "conclusion=$conclusion" \
  -f "output[title]=$title" \
  -f "output[summary]=See PR review for details." \
  --jq '.id' 2>/dev/null || echo "[post-review] WARNING: Failed to create check run"

echo "[post-review] Post-script complete"
