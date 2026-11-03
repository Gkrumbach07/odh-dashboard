# Jira to code (pilot)

Fullsend's code agent can implement an RHOAIENG issue and open a PR in this
repository. Fullsend polls Jira every 30 minutes; a person marks an issue ready,
and the agent reads it, writes the change, runs checks and opens the PR. The PR
then gets the normal Fullsend review and human approval. Nothing merges on its
own.

This is a pilot, off by default. Fullsend's Jira support is pre-alpha upstream
([guide](https://github.com/fullsend-ai/fullsend/blob/640660d4f4c29ac024b4c5f6a512b03d62d491c3/docs/guides/user/jira-integration.md)).
The setup follows `opendatahub-io/mlflow-go`, which runs the same flow for
AI SDLC epics.

## Starting a run

An issue is a candidate when all of these hold:

- project `RHOAIENG`, component `AI Core Dashboard`;
- type Story, Task or Bug (epics are out of scope: one issue, one PR);
- label `ready-to-code`;
- none of `opt-in-autofix`, `jira-autofix`, `jira-autofix-pending`,
  `jira-autofix-review` (those belong to the jira-autofix bot);
- not Done.

On a candidate, a person on the `write` list under `authorization:` in
`config.yaml` can:

- add `ready-to-code` to start coding, or
- comment `/fs-code` (first word of the comment) to retry or ask for a new run.

Anyone else's label or comment is ignored, because the entry sets
`labels: allowlist`. An issue created with `ready-to-code` already on it does
not start: comment `/fs-code`, or remove and re-add the label. The poller only
looks back 24 hours, so the same applies after a longer outage.

The account that owns the Jira token counts as a bot. Its own comments and
labels never start a run, so it must not be a person's account.

## What the agent does

The code harness (`harness/code.yaml`, agents v0.53.0) reads the issue and its
comments through a read-only Jira connection inside the sandbox. The
`rhoaieng-jira-code` skill adds this repository's rules: recheck readiness,
stop instead of guessing when the scope is unclear or needs another repository,
follow `AGENTS.md` and `.claude/rules/`, run checks for the changed packages,
and write the PR in the template's Problem / Solution / Evidence shape. The
post-script pushes a branch to this repository, opens the PR against `main` and
comments the PR link on the Jira issue.

The PR comes from a branch in this repository, not a fork, so `/fs-fix` works
on it.

GitHub issues are not affected: the shim (`.github/workflows/fullsend.yaml`)
routes no issue events, so `/fs-code` or `ready-to-code` on a GitHub issue does
nothing.

## Activation

1. Create a dedicated Jira account for Fullsend and an API token. In RHOAIENG
   it needs Browse Projects, Edit Issues, Add Comments and Edit Own Comments.
   It does not need Administer Projects. It writes Jira issue properties for
   poll locks and checkpoints.
2. Add Actions secrets `FULLSEND_JIRA_BOT_TOKEN` and `FULLSEND_JIRA_BOT_EMAIL`.
   They are separate from the review adapter's `JIRA_*` secrets, which only
   read.
3. Set the repository variable `FULLSEND_JIRA_CODE_ENABLED` to `true`. Both
   workflows skip every job until then, and run only on `main`.
4. Label one small, well-scoped issue `ready-to-code`, then run
   **Actions → Fullsend Jira code poll → Run workflow** (or wait for the
   schedule). Check that the poll launches a **Fullsend Jira code run**, that
   the run opens a PR, and that the issue gets the PR link.

To stop it, set the variable to anything else. Removing `ready-to-code` stops
future runs but not one already running; cancel that Actions run.

## How the workflows fit together

- `fullsend-poll-jira.yaml` runs `fullsend poll --input-driver jira-poll` with
  the JQL above. It saves the dispatch records as an artifact and starts one
  `fullsend-code-jira.yaml` run per record.
- `fullsend-code-jira.yaml` takes only a poll run ID, attempt and record index.
  Before any secret reaches the code job, `scripts/jira_dispatch.py validate`
  checks that the artifact came from this repository's main-branch poll at the
  same commit, and `select` checks that the record is a code run for an
  RHOAIENG issue on `redhat.atlassian.net`.

The one-run-per-record split works around
[fullsend#8961](https://github.com/fullsend-ai/fullsend/issues/8961): two
records for the same agent in one matrix collide on the `fullsend-code`
artifact. Remove it and `fullsend-code-jira.yaml` once that is fixed.

Polling checkpoints are not exactly-once. If a launch or run fails after the
checkpoint, check for an existing PR and comment `/fs-code` again. Rerunning the
poll does not replay its records.

## Pins

The poller and the code run use Fullsend `640660d` (the main-branch merge of
[fullsend#8892](https://github.com/fullsend-ai/fullsend/pull/8892), which adds
the `jira` authorization entry). Move both to the first release that contains
it, expected v0.54.0; `test_jira_workflows.py` checks they match.

Review and fix stay on the shim's own pin. That older CLI ignores the `jira`
entry when it routes and runs reviews, but its `fullsend agent add`, `set`,
`update` and `remove` commands reject it ("invalid provider"). Use the
poller's CLI or newer for those until the shim is upgraded.

## Validation

```bash
python3 .fullsend/scripts/tests/test_jira_workflows.py
FULLSEND_BIN=/path/to/fullsend python3 .fullsend/scripts/tests/test_jira_dispatch.py
fullsend lint --fullsend-dir .fullsend
```

`test_jira_dispatch.py` needs a CLI that includes fullsend#8892. It covers the
trigger and the role each event needs, not live Jira, the `write` list lookup,
sandbox credentials or PR creation. The CLI caches remote harness files in
`.fullsend-cache/`, which is ignored.
