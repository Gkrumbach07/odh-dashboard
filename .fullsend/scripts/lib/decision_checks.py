"""Deterministic checks for recorded decisions that a script can verify.

Each check reads the PR's own revisions from the target checkout's object
store (`git show <sha>:<path>`, `git diff`), never a working-tree checkout, so
PR code is only ever data here. pre-review.sh fetches both commits before the
adapters run. Each check writes one cli-adapter findings envelope.

    python3 decision_checks.py <check> <output.json>

Checks:
    operator-rbac   ADR 0008: module and base Roles/ClusterRoles are held by
                    both operator role files.
    flag-defaults   ADR 0009: a flag added or changed in const.ts has the same
                    default in the backend and core-bff.
    bff-config      ADR 0007: no added `bffConfig` block in a package.json.

Inputs (set by pre-review.sh run_adapter):
    FULLSEND_ADAPTER_REPO_DIR   target checkout holding the PR's commits
    FULLSEND_ADAPTER_PR_FILES   the PR's changed paths, one per line
    FULLSEND_ADAPTER_BASE_SHA   PR base commit
    FULLSEND_ADAPTER_HEAD_SHA   PR head commit
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SHA = re.compile(r"^[0-9a-fA-F]{40}$")


# --------------------------------------------------------------------------
# Envelope and PR revision access
# --------------------------------------------------------------------------

class Unavailable(Exception):
    """The PR revisions cannot be read; reported as an error envelope."""


def envelope(check_id, status, findings=None, **extra):
    payload = {
        "id": check_id,
        "dimension": check_id,
        "kind": "cli-adapter",
        "output": "findings",
        "status": status,
        "findings": findings or [],
    }
    payload.update(extra)
    return payload


class PullRequest:
    def __init__(self, repo_dir, changed, base_sha, head_sha):
        self.repo = repo_dir
        self.changed = changed
        self.head = head_sha
        self.base = base_sha
        self._diff_base = None

    @classmethod
    def from_env(cls):
        repo = Path(os.environ.get("FULLSEND_ADAPTER_REPO_DIR") or "")
        files_path = os.environ.get("FULLSEND_ADAPTER_PR_FILES") or ""
        if not files_path or not Path(files_path).is_file():
            raise Unavailable("pr-files-missing")
        changed = [
            line.strip()
            for line in Path(files_path).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        return cls(
            repo,
            changed,
            os.environ.get("FULLSEND_ADAPTER_BASE_SHA") or "",
            os.environ.get("FULLSEND_ADAPTER_HEAD_SHA") or "",
        )

    def require_revisions(self):
        if not self.repo.is_dir():
            raise Unavailable("repo-dir-missing")
        for sha in (self.base, self.head):
            if not SHA.match(sha):
                raise Unavailable("revision-invalid")
            if self._git("cat-file", "-e", f"{sha}^{{commit}}", check=False) is None:
                raise Unavailable("pr-revisions-unavailable")

    def _git(self, *args, check=True):
        # No external diff or textconv drivers: the compared trees are PR data.
        proc = subprocess.run(
            ["git", "-C", str(self.repo), "-c", "core.quotepath=off", *args],
            capture_output=True,
            text=True,
            errors="replace",
        )
        if proc.returncode != 0:
            if check:
                raise Unavailable("git-failed")
            return None
        return proc.stdout

    @property
    def diff_base(self):
        # The merge base matches what GitHub shows as the PR diff; a shallow
        # history without it falls back to the base tip.
        if self._diff_base is None:
            out = self._git("merge-base", self.base, self.head, check=False)
            self._diff_base = (out or "").strip() or self.base
        return self._diff_base

    def read(self, rev, path):
        """File text at a revision, or None when it does not exist there."""
        return self._git("show", f"{rev}:{path}", check=False)

    def read_head(self, path):
        return self.read(self.head, path)

    def read_base(self, path):
        return self.read(self.diff_base, path)

    def added_lines(self, path):
        """Head line numbers the PR added or changed in a file."""
        out = self._git(
            "diff", "--no-ext-diff", "--no-textconv", "-U0", "--no-renames",
            self.diff_base, self.head, "--", path,
            check=False,
        ) or ""
        lines = set()
        for match in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", out, re.M):
            start, count = int(match.group(1)), int(match.group(2) or "1")
            lines.update(range(start, start + count))
        return lines


def guidance_line(pr, path, phrase):
    """`path:line` of a phrase in a guidance document at the PR base."""
    text = pr.read_base(path) or ""
    for number, line in enumerate(text.splitlines(), 1):
        if phrase in line:
            return f"{path}:{number}"
    return path


def finding(file, line, description, remediation, category):
    out = {
        "severity": "low",
        "category": category,
        "file": file,
        "description": description,
        "remediation": remediation,
        "actionable": True,
    }
    if line:
        out["line"] = str(line)
    return out


# --------------------------------------------------------------------------
# ADR 0008: the operator holds every rule it grants
# --------------------------------------------------------------------------

OPERATOR_ROLE_FILES = (
    "dashboard-operator/config/rbac/role.yaml",
    "dashboard-operator/charts/dashboard/templates/rbac.yaml",
)
OPERAND_RBAC = re.compile(r"^manifests/(modules|base)/.+\.ya?ml$")
RULE_KEYS = ("apiGroups", "resources", "verbs", "resourceNames", "nonResourceURLs")
TEMPLATE_EXPR = re.compile(r"\{\{.*?\}\}")


def _scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _strip_comment(value):
    # A `#` starts a comment only at the start or after whitespace.
    return re.sub(r"(^|\s)#.*$", "", value).rstrip()


def _flow_list(value):
    inner = value.strip()[1:-1]
    return [_scalar(v) for v in inner.split(",") if v.strip()]


def parse_roles(text):
    """Roles and ClusterRoles in a manifest, without a YAML library.

    RBAC manifests here are block-style YAML with scalar lists, block or flow.
    Helm directives are dropped and inline template expressions blanked, so the
    operator's chart template parses the same way. Returns
    [{"kind", "name", "rules": [{"line", <RULE_KEYS>...}]}].
    """
    roles = []
    lines = text.splitlines()
    docs, current = [], []
    for number, raw in enumerate(lines, 1):
        if re.match(r"^---\s*$", raw):
            docs.append(current)
            current = []
            continue
        if raw.lstrip().startswith("{{"):
            continue
        current.append((number, TEMPLATE_EXPR.sub("TEMPLATE", raw)))
    docs.append(current)

    for doc in docs:
        kind = name = ""
        rules = []
        in_metadata = False
        i = 0
        while i < len(doc):
            number, raw = doc[i]
            line = _strip_comment(raw)
            if not line.strip():
                i += 1
                continue
            top = re.match(r"^([A-Za-z]+):\s*(.*)$", line)
            if top:
                key, value = top.group(1), top.group(2)
                in_metadata = key == "metadata"
                if key == "kind":
                    kind = _scalar(value)
                elif key == "rules":
                    i, rules = _parse_rules(doc, i + 1)
                    continue
            elif in_metadata:
                meta = re.match(r"^  name:\s*(.+)$", line)
                if meta:
                    name = _scalar(meta.group(1))
            i += 1
        if kind in ("Role", "ClusterRole"):
            roles.append({"kind": kind, "name": name, "rules": rules})
    return roles


def _parse_rules(doc, i):
    rules, rule, item_indent, key, key_indent = [], None, None, None, None
    while i < len(doc):
        number, raw = doc[i]
        line = _strip_comment(raw)
        if not line.strip():
            i += 1
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0 and not line.startswith("-"):
            break
        body = line.strip()
        item = re.match(r"^-\s+(.*)$", body)
        if item and (item_indent is None or indent == item_indent):
            item_indent = indent
            rule = {"line": number}
            rules.append(rule)
            body = item.group(1)
            key_indent = indent + 2
            key = None
        elif item and key is not None and indent > key_indent - 2:
            rule.setdefault(key, []).append(_scalar(item.group(1)))
            i += 1
            continue
        if rule is None:
            i += 1
            continue
        kv = re.match(r"^([A-Za-z]+):\s*(.*)$", body)
        if kv:
            key, value = kv.group(1), kv.group(2).strip()
            if value.startswith("["):
                rule[key] = _flow_list(value)
                key = None
            elif value:
                rule[key] = [_scalar(value)]
                key = None
            else:
                rule.setdefault(key, [])
        i += 1
    return i, rules


def rule_tuples(rule):
    """Atomic permissions a rule grants. A name of None means any name."""
    out = set()
    for verb in rule.get("verbs", []):
        for url in rule.get("nonResourceURLs", []):
            out.add(("url", url, verb, None))
        for group in rule.get("apiGroups", []):
            for resource in rule.get("resources", []):
                names = rule.get("resourceNames") or [None]
                for name in names:
                    out.add((group, resource, verb, name))
    return out


def _covers(rule, perm):
    group, resource, verb, name = perm
    verbs = rule.get("verbs", [])
    if verb not in verbs and "*" not in verbs:
        return False
    if group == "url":
        return any(
            u == resource or u == "*" or (u.endswith("*") and resource.startswith(u[:-1]))
            for u in rule.get("nonResourceURLs", [])
        )
    groups, resources = rule.get("apiGroups", []), rule.get("resources", [])
    if group not in groups and "*" not in groups:
        return False
    if resource not in resources and "*" not in resources:
        return False
    names = rule.get("resourceNames") or []
    # An unscoped grant is covered only by an unscoped rule.
    return not names or (name is not None and name in names)


def _describe(perm):
    group, resource, verb, name = perm
    if group == "url":
        return f"`{verb}` on non-resource URL `{resource}`"
    target = f"{group}/{resource}" if group else f"core/{resource}"
    scope = "any name" if name is None else f"resourceName `{name}`"
    return f"`{verb}` on `{target}` ({scope})"


def _scoped_hint(operator_rules, perm):
    group, resource, verb, name = perm
    if group == "url" or name is not None:
        return ""
    names = sorted({
        n
        for rule in operator_rules
        if _covers({**rule, "resourceNames": []}, perm)
        for n in rule.get("resourceNames") or []
    })
    shown = ", ".join(f"`{n}`" for n in names)
    return f" (the operator holds it only for resourceNames {shown})" if names else ""


def check_operator_rbac(pr):
    category = "operator-rbac-not-mirrored"
    operator_changed = any(f in pr.changed for f in OPERATOR_ROLE_FILES)
    changed_operand = [f for f in pr.changed if OPERAND_RBAC.match(f)]
    if not operator_changed and not changed_operand:
        return envelope("operator-rbac", "none", reason="no-rbac-changes")
    pr.require_revisions()

    if operator_changed:
        # A narrowed operator role can uncover any operand role.
        listing = pr._git("ls-tree", "-r", "--name-only", pr.head, "--", "manifests") or ""
        scope = sorted(set(f for f in listing.splitlines() if OPERAND_RBAC.match(f)) | set(changed_operand))
    else:
        scope = changed_operand

    def operator_rules(read):
        held = {}
        for path in OPERATOR_ROLE_FILES:
            text = read(path)
            held[path] = [r for role in parse_roles(text or "") for r in role["rules"]]
        return held

    def uncovered(read, held):
        out = {}
        for path in scope:
            text = read(path)
            if not text:
                continue
            for role in parse_roles(text):
                for rule in role["rules"]:
                    for perm in rule_tuples(rule):
                        missing = [
                            op for op in OPERATOR_ROLE_FILES
                            if not any(_covers(r, perm) for r in held[op])
                        ]
                        if missing:
                            out[(path, perm)] = (role, rule, missing)
        return out

    head_held = operator_rules(pr.read_head)
    if not all(head_held.values()):
        return envelope("operator-rbac", "error", reason="operator-role-unreadable")
    head_gaps = uncovered(pr.read_head, head_held)
    base_gaps = uncovered(pr.read_base, operator_rules(pr.read_base))

    adr = "docs/adr/0008-operator-holds-every-rule-it-grants.md"
    cite = guidance_line(pr, adr, "must add the same rule to")
    grouped = {}
    for (path, perm), (role, rule, missing) in sorted(head_gaps.items(), key=lambda kv: (kv[0][0], kv[1][1]["line"], str(kv[0][1]))):
        if (path, perm) in base_gaps:
            continue  # already uncovered before this PR
        grouped.setdefault((path, rule["line"], role["kind"], role["name"]), []).append((perm, missing))

    findings = []
    for (path, line, kind, name), gaps in grouped.items():
        parts = []
        for perm, missing in gaps:
            where = "either operator role file" if len(missing) == 2 else f"`{missing[0]}`"
            hint = _scoped_hint(head_held[missing[0]], perm)
            parts.append(f"{_describe(perm)}, missing from {where}{hint}")
        findings.append(finding(
            path,
            line,
            f"{kind} `{name}` grants permissions the dashboard operator does not hold: "
            + "; ".join(parts)
            + ". RBAC escalation prevention will refuse to apply this role at reconcile, "
            "because the operator has no `escalate` verb. ADR 0008 "
            f"({cite}): a PR that adds a rule to an operand Role or ClusterRole must add the same rule to "
            "both operator role files unless the operator already holds it.",
            "Add the same rule (same apiGroups, resources, verbs and resourceNames scope) to both "
            f"`{OPERATOR_ROLE_FILES[0]}` and `{OPERATOR_ROLE_FILES[1]}`, or narrow this rule to what the "
            "operator already holds.",
            category,
        ))
    preexisting = len([k for k in head_gaps if k in base_gaps])
    return envelope("operator-rbac", "ok", findings, checked_files=scope, preexisting_gaps=preexisting)


# --------------------------------------------------------------------------
# ADR 0009: feature flag defaults agree in three places
# --------------------------------------------------------------------------

FRONTEND_FLAGS = "frontend/src/concepts/areas/const.ts"
BACKEND_FLAGS = "backend/src/utils/constants.ts"
CORE_BFF_FLAGS = "distributions/core-bff/bff/internal/models/dashboard_config.go"


def frontend_flags(text):
    """{flag: (value, line, group)} from the exported flag groups."""
    out, group = {}, None
    for number, line in enumerate(text.splitlines(), 1):
        start = re.match(r"^export const (\w+(?:Flags|FeatureFlags))\b.*=\s*\{", line)
        if start:
            group = start.group(1)
            continue
        if group and re.match(r"^\}", line):
            group = None
            continue
        entry = group and re.match(r"^\s+(\w+):\s*(true|false)\s*,?", line)
        if entry:
            out[entry.group(1)] = (entry.group(2) == "true", number, group)
    return out


def _block_flags(text, opener, entry):
    out, depth = {}, None
    for line in text.splitlines():
        if depth is None:
            if re.search(opener, line):
                depth = 1
            continue
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            break
        match = re.match(entry, line)
        if match and depth == 1:
            out[match.group(1).lower()] = match.group(2) == "true"
    return out


def backend_flags(text):
    return _block_flags(text, r"^\s+dashboardConfig:\s*\{", r"^\s+(\w+):\s*(true|false)\s*,?")


def core_bff_flags(text):
    return _block_flags(text, r"DashboardConfig:\s*DashboardFeatureFlags\{", r"^\s+(\w+):\s*(true|false)\s*,")


def check_flag_defaults(pr):
    category = "flag-default-mismatch"
    if FRONTEND_FLAGS not in pr.changed:
        return envelope("flag-defaults", "none", reason="no-flag-changes")
    pr.require_revisions()
    head = pr.read_head(FRONTEND_FLAGS)
    if head is None:
        return envelope("flag-defaults", "none", reason="flags-file-removed")
    flags = frontend_flags(head)
    added = pr.added_lines(FRONTEND_FLAGS)
    touched = {name: v for name, v in flags.items() if v[1] in added}
    base_flags = frontend_flags(pr.read_base(FRONTEND_FLAGS) or "")
    base_groups = {group for _, _, group in base_flags.values()}
    backend = backend_flags(pr.read_head(BACKEND_FLAGS) or "")
    core_bff = core_bff_flags(pr.read_head(CORE_BFF_FLAGS) or "")
    if not backend or not core_bff:
        return envelope("flag-defaults", "error", reason="defaults-unreadable")

    adr = "docs/adr/0009-feature-flag-lifecycle.md"
    findings = []
    for name, (value, line, group) in sorted(touched.items(), key=lambda kv: kv[1][1]):
        shown = str(value).lower()
        problems, fixes = [], []
        if group == "techPreviewFlags" and value:
            problems.append(
                "a Tech Preview flag defaults to `true`; ADR 0009 "
                f"({guidance_line(pr, adr, 'must default to `false`')}): a flag added to "
                "`techPreviewFlags` must default to `false`"
            )
            fixes.append(f"default `{name}` to `false` while it is Tech Preview")
        promoted = base_flags.get(name, (None, None, None))[2] == "techPreviewFlags"
        if promoted and group != "techPreviewFlags" and group not in base_groups:
            problems.append(
                f"the flag leaves `techPreviewFlags` for `{group}`, a group this PR creates; ADR 0009 "
                f"({guidance_line(pr, adr, 'must not add a new flag group')}): a GA promotion must not add "
                "a new flag group; move the flag into an existing functional group"
            )
            fixes.append(f"move `{name}` into its existing functional group instead of `{group}`")
        drift = []
        for path, label, defaults in (
            (BACKEND_FLAGS, "backend `blankDashboardCR`", backend),
            (CORE_BFF_FLAGS, "core-bff `BlankDashboardCR`", core_bff),
        ):
            other = defaults.get(name.lower())
            if other is None:
                drift.append(f"the {label} (`{path}`) has no default for it")
            elif other != value:
                drift.append(f"the {label} (`{path}`) defaults it to `{str(other).lower()}`")
        if drift:
            problems.append(
                " and ".join(drift)
                + f"; ADR 0009 ({guidance_line(pr, adr, 'set the same default in')}): the PR must set the same "
                f"default in `{BACKEND_FLAGS}` and `{CORE_BFF_FLAGS}`"
            )
            fixes.append(
                f"set `{name}` to the same default in `{FRONTEND_FLAGS}`, the backend `blankDashboardCR` "
                "and the core-bff `BlankDashboardCR`"
            )
        if not problems:
            continue
        findings.append(finding(
            FRONTEND_FLAGS,
            line,
            f"This PR sets feature flag `{name}` to `{shown}` in `{group}`, but "
            + ". Also, ".join(problems) + ".",
            "; ".join(fixes).capitalize() + ".",
            category,
        ))
    return envelope("flag-defaults", "ok", findings, checked_flags=sorted(touched))


# --------------------------------------------------------------------------
# ADR 0007: no bffConfig block in package.json
# --------------------------------------------------------------------------

def check_bff_config(pr):
    category = "dead-bff-config"
    manifests = [f for f in pr.changed if f == "package.json" or f.endswith("/package.json")]
    if not manifests:
        return envelope("bff-config", "none", reason="no-package-json-changes")
    pr.require_revisions()
    adr = "docs/adr/0007-module-e2e-bff-wiring.md"
    findings = []
    for path in manifests:
        text = pr.read_head(path)
        if text is None:
            continue
        added = pr.added_lines(path)
        for number, line in enumerate(text.splitlines(), 1):
            if number in added and re.match(r'^\s*"bffConfig"\s*:', line):
                findings.append(finding(
                    path,
                    number,
                    "This PR adds a `bffConfig` block. Nothing reads it: the E2E workflow reader was "
                    "removed in #8432, and the local BFF starts from the package's Makefile "
                    "(`dev-bff-e2e-cluster`, `E2E_BFF_PORT`) and its `cypress:server:e2e` script. ADR 0007 "
                    f"({guidance_line(pr, adr, 'Do not add a `bffConfig` block')}): do not add a "
                    "`bffConfig` block to any `package.json`.",
                    "Remove the `bffConfig` block; put the port and start command in the Makefile and the "
                    "`cypress:server:e2e` script.",
                    category,
                ))
    return envelope("bff-config", "ok", findings, checked_files=manifests)


CHECKS = {
    "operator-rbac": check_operator_rbac,
    "flag-defaults": check_flag_defaults,
    "bff-config": check_bff_config,
}


def main(argv):
    if len(argv) != 3 or argv[1] not in CHECKS:
        print(f"usage: {argv[0]} {{{'|'.join(CHECKS)}}} <output.json>", file=sys.stderr)
        return 2
    check_id, dest = argv[1], Path(argv[2])
    try:
        payload = CHECKS[check_id](PullRequest.from_env())
    except Unavailable as exc:
        payload = envelope(check_id, "error", reason=str(exc))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    note = payload.get("reason") or f"{len(payload['findings'])} findings"
    print(f"Wrote {check_id} check ({payload['status']}: {note}) to {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
