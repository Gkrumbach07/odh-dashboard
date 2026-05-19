# Preflight Report Template

Used for terminal output, PR summary comment, and inline review comments in `--ci` mode.

## What Goes Where

| Severity | Inline PR review comment | Summary comment |
|----------|--------------------------|-----------------|
| 🔴 Critical | Yes | Yes (expandable) |
| 🟠 Major | Yes | Yes (expandable) |
| 🟡 Minor | Yes | Yes (expandable) |
| 🟢 Nit | **No** — nits only in summary | Yes (expandable) |

## Comment Overwrite (Sticky Comment)

Update the existing comment instead of creating duplicates:

```bash
EXISTING_ID=$(gh api "repos/OWNER/REPO/issues/PR/comments" \
  --jq '.[] | select(.body | contains("<!-- odh-preflight-agent -->")) | .id' | head -1)

if [ -n "$EXISTING_ID" ]; then
  gh api "repos/OWNER/REPO/issues/comments/$EXISTING_ID" \
    --method PATCH --input /tmp/preflight-comment.json
else
  gh pr comment PR --body-file /tmp/preflight-comment.md
fi
```

The marker `<!-- odh-preflight-agent -->` MUST be the first line of every summary comment.

## Summary Comment

Write to `/tmp/preflight-comment.md` then post with `--body-file`:

```markdown
<!-- odh-preflight-agent -->
## Preflight Agent Report

**Verdict:** <emoji> <READY | READY WITH WARNINGS | NOT READY>
**Mode:** <check-only | managed>
**Commit:** `<short SHA>`

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Conflicts | ✅ | Mergeable, up to date |
| CI | ⏭️ | 48 passed, 2 pending |
| Lint | ⏭️ | Covered by CI |
| Type Check | ⏭️ | Covered by CI |
| Unit Tests | ⏭️ | Covered by CI |
| Jira | ✅ | RHOAIENG-12345 |
| Test Coverage | ⚠️ | No test files added |
| PR Body | ✅ | All sections present |

<details>
<summary>🔴 Critical (N)</summary>

| File | Issue |
|------|-------|
| `path/file.tsx:42` | Description |

</details>

<details>
<summary>🟠 Major (N)</summary>

| File | Issue |
|------|-------|
| `path/file.tsx:53` | Guard `conditions` before reading `.length` |

</details>

<details>
<summary>🟡 Minor (N)</summary>

| File | Issue |
|------|-------|
| `path/file.scss:8` | Use PF token instead of hardcoded value |

</details>

<details>
<summary>🟢 Nit (N)</summary>

| File | Issue |
|------|-------|
| `path/file.tsx:20` | Prefer `const` over `let` |
| `path/file.tsx:45` | Unnecessary else after return |

</details>

---
*Automated by [ODH Dashboard Agent](<workflow run URL>)*
```

**Rules:**
- First line MUST be `<!-- odh-preflight-agent -->`
- Only include severity sections that have findings
- Only include check rows that were evaluated
- Status emojis: ✅ passed · ❌ failed · ⚠️ warning · ⏭️ covered by CI · ➖ n/a

## Inline Review Comments (Critical, Major, Minor only — NOT Nits)

Submit as a **single PR review** via `gh api`. Format for each comment:

```markdown
🟠 Major

**<Short title.>**

<Description. Use `code` formatting for identifiers.>

<details>
<summary>Proposed fix</summary>

```diff
- <old code>
+ <new code>
```

</details>
```

**Severity badge** — just the circle + word, nothing else:

| Badge | When |
|-------|------|
| `🔴 Critical` | Security, data loss, crash |
| `🟠 Major` | Bug, incorrect behavior, missing guard |
| `🟡 Minor` | Code quality, naming, style |

**Rules for inline comments:**
- Always include `Proposed fix` with a diff when possible
- Do NOT post inline comments for Nits — those go in the summary only
- Do NOT set a top-level `body` on the review — empty string `""`
- Only post for findings with specific file + line

### Submitting the Review

Write to JSON and POST:

```bash
cat > /tmp/review.json << 'JSON'
{
  "event": "COMMENT",
  "body": "",
  "comments": [
    {
      "path": "src/components/Foo.tsx",
      "line": 42,
      "body": "🟠 Major\n\n**Guard `conditions` before reading `.length`.**\n\nLine 42 assumes `conditions` always exists. A partial API payload without `conditions` will throw.\n\n<details>\n<summary>Proposed fix</summary>\n\n```diff\n- if (dscStatus.conditions.length === 0) {\n+ const conditions = dscStatus?.conditions;\n+ if (!Array.isArray(conditions) || conditions.length === 0) {\n```\n\n</details>"
    }
  ]
}
JSON
gh api repos/OWNER/REPO/pulls/PR/reviews --input /tmp/review.json
```

## Writing Files in CI

Use the **Write tool** to create `/tmp/preflight-comment.md` and `/tmp/review.json`. Bash file redirects (`>`, `tee`, heredocs) may be blocked by the CI security sandbox. The Write tool always works.

After writing, post with:
- `gh pr comment PR --body-file /tmp/preflight-comment.md`
- `gh api repos/OWNER/REPO/pulls/PR/reviews --input /tmp/review.json`
