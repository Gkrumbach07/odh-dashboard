#!/usr/bin/env bash
# Pre-script for the ODH review agent.
# Runs on the GitHub Actions runner BEFORE the sandbox.
# Fetches PR metadata, diff, changed files, Jira key, and prior review threads.
# Writes context to /workspace/output/ for the sandbox agent to consume.
#
# Environment variables (set by workflow):
#   PR_NUMBER, HEAD_SHA, HEAD_REPO, OWNER, REPO, GH_TOKEN

set -euo pipefail

output_dir="${FULLSEND_OUTPUT_DIR:-/workspace/output}"
mkdir -p "$output_dir"

pr_number="${PR_NUMBER:?PR_NUMBER is required}"
head_sha="${HEAD_SHA:?HEAD_SHA is required}"
owner="${OWNER:-$(gh repo view --json owner --jq '.owner.login')}"
repo="${REPO:-$(gh repo view --json name --jq '.name')}"

echo "[pre-review] Gathering context for PR #${pr_number} (${owner}/${repo})"

# Fetch PR metadata
pr_meta=$(gh pr view "$pr_number" --repo "$owner/$repo" \
  --json title,body,headRefName,baseRefName,mergeable,mergeStateStatus,author,reviewDecision,files \
  2>/dev/null || echo '{}')

pr_title=$(echo "$pr_meta" | jq -r '.title // ""')
pr_body=$(echo "$pr_meta" | jq -r '.body // ""')
changed_files=$(echo "$pr_meta" | jq -r '[.files[]?.path] // []')

# Fetch PR diff
gh pr diff "$pr_number" --repo "$owner/$repo" > "$output_dir/pr.diff" 2>/dev/null || true
echo "[pre-review] Diff: $(wc -l < "$output_dir/pr.diff") lines"

# Extract Jira key from PR title, body, or branch name
branch=$(echo "$pr_meta" | jq -r '.headRefName // ""')
jira_key=$(echo "$pr_title $pr_body $branch" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | head -1 || true)
if [ -n "$jira_key" ]; then
  echo "[pre-review] Jira key: $jira_key"
else
  echo "[pre-review] No Jira key found"
fi

# Fetch existing unresolved review threads (avoid re-posting)
prior_threads='[]'
if command -v jq &>/dev/null; then
  all_threads='[]'
  cursor=""

  while :; do
    args=(-f owner="$owner" -f repo="$repo" -F pr="$pr_number")
    if [ -n "$cursor" ]; then
      args+=(-f cursor="$cursor")
    fi

    response=$(gh api graphql "${args[@]}" -f query='
      query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$pr) {
            reviewThreads(first:100, after:$cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                isOutdated
                comments(first:5) {
                  nodes {
                    databaseId
                    body
                    path
                    line
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    ' 2>/dev/null || echo '{"data":null}')

    sanitized=$(echo "$response" | tr -d '\000-\010\013\014\016-\037')

    if echo "$sanitized" | jq -e '.data.repository' &>/dev/null; then
      page_threads=$(echo "$sanitized" | jq -c '[
        .data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved == false and .isOutdated == false)
        | {
            thread_id: .id,
            path: .comments.nodes[0].path,
            line: .comments.nodes[0].line,
            body: .comments.nodes[0].body,
            author: (.comments.nodes[0].author.login // "ghost"),
            database_id: .comments.nodes[0].databaseId
          }
      ]' 2>/dev/null || echo '[]')

      all_threads=$(echo "$all_threads" | jq -c --argjson new "$page_threads" '. + $new')
    fi

    has_next=$(echo "$sanitized" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage // false')
    cursor=$(echo "$sanitized" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')
    [ "$has_next" = "true" ] || break
  done

  prior_threads="$all_threads"
  echo "[pre-review] Prior unresolved threads: $(echo "$prior_threads" | jq 'length')"
fi

# Fetch CI check status
ci_checks='[]'
ci_checks=$(gh pr checks "$pr_number" --repo "$owner/$repo" \
  --json name,bucket,link,description 2>/dev/null || echo '[]')
echo "[pre-review] CI checks: $(echo "$ci_checks" | jq 'length')"

# Write context JSON
jq -n \
  --arg pr_number "$pr_number" \
  --arg head_sha "$head_sha" \
  --arg owner "$owner" \
  --arg repo "$repo" \
  --arg pr_title "$pr_title" \
  --arg pr_body "$pr_body" \
  --arg branch "$branch" \
  --arg jira_key "$jira_key" \
  --argjson changed_files "$changed_files" \
  --argjson prior_threads "$prior_threads" \
  --argjson ci_checks "$ci_checks" \
  --arg diff_path "pr.diff" \
  '{
    pr_number: $pr_number,
    head_sha: $head_sha,
    owner: $owner,
    repo: $repo,
    pr_title: $pr_title,
    pr_body: $pr_body,
    branch: $branch,
    jira_key: (if $jira_key == "" then null else $jira_key end),
    changed_files: $changed_files,
    prior_threads: $prior_threads,
    ci_checks: $ci_checks,
    diff_path: $diff_path
  }' > "$output_dir/context.json"

echo "[pre-review] Context written to $output_dir/context.json"
echo "[pre-review] Pre-script complete"
