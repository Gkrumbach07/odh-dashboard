#!/usr/bin/env bash
# Validation script for the ODH review agent output.
# Called by fullsend's validation_loop after each sandbox iteration.
# Validates agent-result.json against the JSON schema.
#
# Exit 0 = valid, exit 1 = invalid (triggers retry).

set -euo pipefail

output_dir="${FULLSEND_OUTPUT_DIR:-/workspace/output}"
result_file="${1:-$output_dir/agent-result.json}"
schema_file="${2:-schemas/odh-review-result.schema.json}"

if [ ! -f "$result_file" ]; then
  echo "FAIL: agent-result.json not found at $result_file" >&2
  exit 1
fi

# Check it's valid JSON
if ! jq empty "$result_file" 2>/dev/null; then
  echo "FAIL: agent-result.json is not valid JSON" >&2
  exit 1
fi

# Check required fields
action=$(jq -r '.action // empty' "$result_file")
if [ -z "$action" ]; then
  echo "FAIL: missing required field 'action'" >&2
  exit 1
fi

case "$action" in
  approve|request-changes|comment) ;;
  *)
    echo "FAIL: action must be approve, request-changes, or comment (got: $action)" >&2
    exit 1
    ;;
esac

if ! jq -e '.findings | type == "array"' "$result_file" >/dev/null 2>&1; then
  echo "FAIL: missing or invalid 'findings' array" >&2
  exit 1
fi

# Validate each finding has required fields
invalid=$(jq '[.findings[] | select(.severity == null or .category == null or .file == null or .description == null)] | length' "$result_file")
if [ "$invalid" -gt 0 ]; then
  echo "FAIL: $invalid findings missing required fields (severity, category, file, description)" >&2
  exit 1
fi

# Validate severity values
bad_severity=$(jq '[.findings[] | select(.severity | IN("critical","high","medium","low","info") | not)] | length' "$result_file")
if [ "$bad_severity" -gt 0 ]; then
  echo "FAIL: $bad_severity findings have invalid severity values" >&2
  exit 1
fi

findings_count=$(jq '.findings | length' "$result_file")
echo "PASS: action=$action, findings=$findings_count"
exit 0
