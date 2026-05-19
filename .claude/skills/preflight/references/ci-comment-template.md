# Preflight Report Template

This template is used for both terminal output and PR comments. When `--ci` is passed, post this as a PR comment AND submit inline review comments.

## Summary Comment

Post as a top-level PR comment via `gh pr comment PR --body-file /tmp/preflight-comment.md`:

```markdown
## Preflight Agent Report

**Verdict:** <emoji> <READY | READY WITH WARNINGS | NOT READY>
**Mode:** <check-only | managed>
**Commit:** `<head SHA>`

| Check | Status | Details |
|-------|--------|---------|
| Conflicts | <emoji> | <one-line detail> |
| CI | <emoji> | <pass/fail/pending — list failing check names> |
| Lint | <emoji> | <pass or error count> |
| Type Check | <emoji> | <pass or error count> |
| Unit Tests | <emoji> | <pass or error count> |
| Reviews | <emoji> | <N unresolved threads> |
| Jira | <emoji> | <key or missing> |
| Test Coverage | <emoji> | <test files present or missing> |
| PR Body | <emoji> | <complete or missing sections> |

<details>
<summary>Review Findings (<N> issues)</summary>

### <Reviewer Name> (<N> findings)

**<severity>: <title>**
`<file>:<line>` — <description>

*(repeat for each finding)*

</details>

---
*Automated by [ODH Dashboard Agent](<workflow run URL>)*
```

Status emojis: ✅ passed · ❌ failed · ⚠️ warning · ⏭️ covered by CI · ➖ not applicable

Only include check rows that were actually evaluated. Omit rows for skipped or inapplicable checks.

## Inline Review Comments

For each finding that has a specific file and line number, submit an inline PR review comment. Use a single review submission with all comments batched:

```bash
gh api repos/OWNER/REPO/pulls/PR/reviews \
  --method POST \
  -f event=COMMENT \
  -f body="Preflight review — <N> inline findings" \
  -f 'comments[][path]=<file>' \
  -f 'comments[][position]=<diff position>' \
  -f 'comments[][body]=**[<severity>]** <description>'
```

If the `gh api` review submission is complex, write the review payload to a JSON file and submit:

```bash
cat > /tmp/review.json << 'JSON'
{
  "event": "COMMENT",
  "body": "Preflight review — N inline findings",
  "comments": [
    {
      "path": "src/file.tsx",
      "line": 42,
      "body": "**[warning]** Description of the issue"
    }
  ]
}
JSON
gh api repos/OWNER/REPO/pulls/PR/reviews --input /tmp/review.json
```

Only submit inline comments for findings with known file paths and line numbers. General observations go in the summary comment only.

## Shell Quoting

Always write comment bodies to a temp file and use `--body-file` or `--input` to avoid shell escaping issues. Never pass markdown directly as a `-b` argument.
