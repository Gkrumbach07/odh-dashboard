#!/usr/bin/env python3
"""Turn `cr review --agent` NDJSON (stdin) into a findings envelope (stdout).

Does not post GitHub comments. Keeps only fields the review schema allows.

Severity: critical→critical, major→high, minor→medium, trivial→low, info→info.
Category is `coderabbit` unless the CLI already set one — so a security finding
at the same line stays a separate row until the challenger merges duplicates.

TODO: remove scripts/cr-mock + fixtures/coderabbit-review.ndjson when real
CodeRabbit integration is configured (CODERABBIT_CLI=cr as the repo default).

Usage:
  adapt-coderabbit.py
  adapt-coderabbit.py --self-test
"""
from __future__ import annotations

import json
import sys

SEVERITY_MAP = {
    "critical": "critical",
    "major": "high",
    "minor": "medium",
    "trivial": "low",
    "info": "info",
}

ALLOWED_FINDING_KEYS = (
    "severity",
    "category",
    "file",
    "line",
    "description",
    "remediation",
    "why",
    "actionable",
)


def map_severity(raw: str) -> str:
    key = (raw or "info").strip().lower()
    return SEVERITY_MAP.get(key, "info")


def finding_from_event(event: dict) -> dict | None:
    if event.get("type") != "finding":
        return None
    file_name = event.get("fileName") or event.get("file") or "N/A"
    line = event.get("startLine") or event.get("line") or event.get("start_line")
    comment = (event.get("comment") or "").strip()
    codegen = (event.get("codegenInstructions") or "").strip()
    description = comment or codegen
    if not description:
        return None
    finding: dict = {
        "severity": map_severity(str(event.get("severity") or "info")),
        "category": (event.get("category") or "coderabbit").strip() or "coderabbit",
        "file": str(file_name),
        "description": description,
        "actionable": True,
    }
    if line not in (None, "", 0):
        try:
            finding["line"] = int(line)
        except (TypeError, ValueError):
            pass
    if codegen:
        finding["remediation"] = codegen
    if comment and codegen:
        finding["why"] = "From CodeRabbit CLI output (not a GitHub comment)."
    return {k: finding[k] for k in ALLOWED_FINDING_KEYS if k in finding}


def adapt_ndjson(lines: list[str]) -> dict:
    findings: list[dict] = []
    saw_complete = False
    complete_status = ""
    errors: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"invalid json: {exc}")
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "finding":
            mapped = finding_from_event(event)
            if mapped:
                findings.append(mapped)
        elif kind == "complete":
            saw_complete = True
            complete_status = str(event.get("status") or "")
        elif kind == "error":
            errors.append(str(event.get("message") or event))
    if errors and not findings:
        status = "error"
        findings = [
            {
                "severity": "info",
                "category": "dimension-producer",
                "file": "N/A",
                "description": (
                    "coderabbit producer did not return findings: "
                    + "; ".join(errors)
                ),
                "actionable": False,
            }
        ]
    elif complete_status == "review_skipped":
        status = "skipped"
    elif saw_complete or findings:
        status = "ok"
    else:
        status = "empty"
    return {
        "dimension": "coderabbit",
        "kind": "cli-adapter",
        "status": status,
        "findings": findings,
    }


def _self_test() -> None:
    from pathlib import Path

    fixture = (
        Path(__file__).resolve().parent.parent
        / "fixtures"
        / "coderabbit-review.ndjson"
    )
    envelope = adapt_ndjson(fixture.read_text().splitlines())
    if envelope["status"] != "ok":
        raise SystemExit(f"FAIL adapt status: {envelope['status']}")
    if len(envelope["findings"]) != 2:
        raise SystemExit(f"FAIL adapt count: {len(envelope['findings'])}")
    by_line = {f.get("line"): f for f in envelope["findings"]}
    if by_line.get(7, {}).get("severity") != "high":
        raise SystemExit(f"FAIL major→high: {by_line.get(7)}")
    if by_line.get(24, {}).get("severity") != "medium":
        raise SystemExit(f"FAIL minor→medium: {by_line.get(24)}")
    cats = {f["category"] for f in envelope["findings"]}
    if cats != {"coderabbit"}:
        raise SystemExit(f"FAIL adapter category stays coderabbit: {cats}")
    print("PASS adapt major→high / minor→medium, category=coderabbit")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        _self_test()
        return
    envelope = adapt_ndjson(sys.stdin.read().splitlines())
    json.dump(envelope, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
