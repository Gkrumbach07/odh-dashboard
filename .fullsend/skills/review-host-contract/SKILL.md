---
name: review-host-contract
description: >-
  Fill findings, risk, confidence, and product_ask. The host writes the
  PR comment and the GitHub review action. Agent-authored action and
  markdown are not final.
---

# Review host contract

The sticky PR comment and GitHub review action are produced by the host
post-script. This skill does not replace `pr-review`. It constrains
`$FULLSEND_OUTPUT_DIR/agent-result.json`.

## Do

- Run `pr-review` (and domain skills) to produce **findings** and
  schema sections. `pr-review` reads `.fullsend/dimensions.json`.
  `output: findings` LLM rows are spawned; CLI findings envelopes come
  from `.fullsend/.run/collected.json` before merge and
  challenger. `output: context` snapshots (e.g.
  `.fullsend/.run/jira.json`) are host-fetched — do not fetch Jira
  in the sandbox and do not copy secrets. `output: section:*` LLMs fill
  named fields (e.g. `product_ask`) and skip the challenger. Do not
  start CLIs yourself. Do not scrape GitHub bot comments.
- Description vs code mismatches are ordinary findings (same
  `findings[]`).
- **PR description vs Jira description** is `product_ask`, not a
  finding and not a code-vs-AC review. Do not run `jira-eval-review`.
- Required PR headings (**Problem**, **Solution**, **Evidence**) are
  checked by the host. Missing headings skip the review agent. Impact,
  Test plan, and other template sections are optional. If the agent does
  run, you may still flag thin or mismatched section *content*.
- Set `risk` to `low` | `medium` | `high` | `critical`.
- Set `confidence` to `low` | `medium` | `high`.
- Copy `product_ask` from the description-jira section LLM (or
  `status: none` when there is no snapshot).
- Optional `why` on each finding (rationale).
- Invoke `issue-labels` **after** findings/risk/confidence/sections
  exist so labels can follow the assembled result, not only the diff.
- Keep `pr_number`, `repo`, `head_sha`.

## Do not

- Do not treat comment markdown as the review contract. The host
  overwrites `body`.
- Do not assume your `action` will be posted. The host sets it from
  findings (critical/high → `request-changes`, and so on). High/critical
  `risk`, low `confidence`, or `product_ask.needs_human` / unjustified
  mismatch can turn an approve into `comment`.
- Do not emit preflight-style markdown reports (Critical/Warning/Info
  tables, PASS/MISS). Fold domain-skill issues into `findings[]` with
  `severity`, `category`, `file`, `description`.
- Do not invent GitHub review types. Host posting still uses
  `approve` | `request-changes` | `comment` | `reject` | `failure`.
- Do not post or scrape tool GitHub comments. CLI adapters contribute
  JSON (findings or context), not a second reviewer.

## Failure

If you cannot complete the review, set `action` to `failure` and `reason`
to one of `tool-failure`, `missing-context`, `ambiguous-findings`,
`token-limit`. The host leaves `failure` unchanged. A missing Jira
snapshot is `product_ask.status: none`, not a failed review.
