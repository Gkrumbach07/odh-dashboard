"""Exercise Jira routing for the code agent with a Fullsend CLI; no Jira API calls.

Needs a CLI that includes fullsend#8892 (the poller's pin). Run:
  FULLSEND_BIN=/path/to/fullsend python3 .fullsend/scripts/tests/test_jira_dispatch.py

The json input driver takes actor.role as given, so these cases cover the
trigger and the role each event needs. Who gets the write role (the jira
lists in config.yaml) is resolved by the live poller and is not covered here.
Project, tenant and repository are fixed by the poll's --jira-project,
--jira-url, JQL and --target-repo. Bot events never reach dispatch: the
poller drops them first.
"""

import copy
import json
import os
import pathlib
import runpy
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
binary = os.environ.get("FULLSEND_BIN", "fullsend")
select_record = runpy.run_path(str(ROOT / ".fullsend/scripts/jira_dispatch.py"))[
    "select_record"
]
base = {
    "repo": "opendatahub-io/odh-dashboard",
    "entity": {
        "kind": "work_item",
        "id": 12345,
        "key": "RHOAIENG-123",
        "url": "https://redhat.atlassian.net/browse/RHOAIENG-123",
    },
    "transition": {
        "kind": "label_changed",
        "label": {"name": "ready-to-code", "action": "added"},
    },
    "actor": {
        "id": "human-test",
        "kind": "human",
        "role": "write",
        "is_entity_author": False,
    },
    "state": {"labels": ["ready-to-code"]},
    "source": {"system": "jira", "raw_type": "changelog", "raw_action": "updated"},
}
fs_code = {
    "kind": "comment_added",
    "comment": {"body": "/fs-code", "command": "/fs-code"},
}
cases = []


def add(name, expected, **changes):
    event = copy.deepcopy(base)
    for key, val in changes.items():
        event[key] = val
    cases.append((name, event, expected))


add("label_added", 1)
add("admin_actor", 1, actor=base["actor"] | {"role": "admin"})
add("explicit_retry", 1, transition=fs_code)
# A synthetic opened event carries current labels and the reporter, even when
# someone else added ready-to-code later. It must never start coding.
add("created_with_label", 0, transition={"kind": "opened"})
add(
    "reporter_cannot_authorize_later_label",
    0,
    transition={"kind": "opened"},
    actor=base["actor"] | {"is_entity_author": True},
)
add("bot_fs_code", 0, transition=fs_code, actor=base["actor"] | {"kind": "bot"})
add(
    "fs_code_mid_sentence",
    0,
    transition={"kind": "comment_added", "comment": {"body": "please /fs-code"}},
)
add(
    "ordinary_comment",
    0,
    transition={"kind": "comment_added", "comment": {"body": "hello"}},
)
add(
    "label_removed",
    0,
    transition={
        "kind": "label_changed",
        "label": {"name": "ready-to-code", "action": "removed"},
    },
)
add(
    "autofix_label",
    0,
    transition={
        "kind": "label_changed",
        "label": {"name": "jira-autofix", "action": "added"},
    },
)
# labels: allowlist means a label author outside the write list gets no
# write role, so neither a label nor /fs-code from them starts coding.
add("triage_actor_adds_label", 0, actor=base["actor"] | {"role": "triage"})
add("read_only_actor_adds_label", 0, actor=base["actor"] | {"role": "read"})
add("read_only_fs_code", 0, transition=fs_code, actor=base["actor"] | {"role": "read"})
add("triage_fs_code", 0, transition=fs_code, actor=base["actor"] | {"role": "triage"})

failures = []
with tempfile.NamedTemporaryFile(mode="w+", suffix=".json") as f:
    for name, event, expected in cases:
        f.seek(0)
        f.truncate()
        json.dump(event, f)
        f.flush()
        p = subprocess.run(
            [
                binary,
                "dispatch",
                "--input-driver",
                "json",
                "--input-file",
                f.name,
                "--config-dir",
                str(ROOT / ".fullsend"),
                "--output-driver",
                "json",
            ],
            text=True,
            capture_output=True,
        )
        if p.returncode:
            raise RuntimeError(name + ": " + p.stderr)
        result = json.loads(p.stdout) or []
        ok = len(result) == expected
        if ok and expected:
            ok = result[0]["agent"] == "code" and select_record(result, 0) == {
                "include": [result[0]]
            }
        print(f"{name}: {'passed' if ok else 'FAILED'} (dispatches={len(result)})")
        if not ok:
            failures.append((name, result, p.stderr))
if failures:
    raise SystemExit(f"{len(failures)} case(s) failed: {failures}")
