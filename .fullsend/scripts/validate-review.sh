#!/usr/bin/env bash
# Validation script for the ODH review agent output.
# Called by fullsend's validation_loop after each sandbox iteration.
#
# The working directory is set by fullsend to the iteration dir.
# Output files are extracted to output/ relative to that dir.
#
# Exit 0 = valid, exit 1 = invalid (triggers retry).

set -euo pipefail

OUTPUT_DIR="output"
if [[ ! -d "${OUTPUT_DIR}" ]]; then
  echo "FAIL: output directory not found"
  exit 1
fi

RESULT_FILE="${OUTPUT_DIR}/agent-result.json"
if [[ ! -f "${RESULT_FILE}" ]]; then
  echo "FAIL: ${RESULT_FILE} not found"
  exit 1
fi

if ! python3 -m json.tool "${RESULT_FILE}" > /dev/null 2>&1; then
  echo "FAIL: ${RESULT_FILE} is not valid JSON"
  exit 1
fi

if ! python3 -c "import jsonschema" 2>/dev/null; then
  echo "WARN: jsonschema not installed, skipping schema validation"
  echo "PASS: JSON is valid (schema not checked)"
  exit 0
fi

SCHEMA_FILE="${FULLSEND_OUTPUT_SCHEMA:-schemas/odh-review-result.schema.json}"
if [[ ! -f "${SCHEMA_FILE}" ]]; then
  echo "WARN: schema file not found at ${SCHEMA_FILE}, skipping schema validation"
  echo "PASS: JSON is valid (schema not checked)"
  exit 0
fi

python3 -c "
import json, sys
from jsonschema import validate, ValidationError

with open(sys.argv[1]) as f:
    instance = json.load(f)
with open(sys.argv[2]) as f:
    schema = json.load(f)
try:
    validate(instance=instance, schema=schema)
    findings = len(instance.get('findings', []))
    action = instance.get('action', 'unknown')
    print(f'PASS: action={action}, findings={findings}')
except ValidationError as e:
    print(f'FAIL: schema validation error: {e.message}')
    if e.path:
        print(f'  at: {\".\".join(str(p) for p in e.path)}')
    sys.exit(1)
" "${RESULT_FILE}" "${SCHEMA_FILE}"
