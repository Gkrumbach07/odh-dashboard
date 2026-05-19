# Preflight Report Template

This template is used for terminal output, PR summary comments, and inline review comments. When `--ci` is passed, post the summary as a PR comment AND submit inline review comments for file-specific findings.

## Inline Review Comments

Submit as a single PR review via `gh api`. Each inline comment should follow this format:

```markdown
⚠️ Potential issue | 🟠 Major | ⚡ Quick win

**<Short title describing the issue.>**

<Description of what's wrong and why it matters. Use `code` formatting for identifiers.>

<details>
<summary>Proposed fix</summary>

```diff
- <old code>
+ <new code>
```

</details>
```

Severity badges (pick one per comment):

| Severity | Badge | When to use |
|----------|-------|-------------|
| Critical | `🔴 Critical` | Security issue, data loss, crash |
| Major | `🟠 Major` | Bug, incorrect behavior, missing guard |
| Minor | `🟡 Minor` | Code quality, naming, style |
| Nit | `🟢 Nit` | Nitpick, preference, optional improvement |

Effort badges (pick one per comment):

| Effort | Badge | When to use |
|--------|-------|-------------|
| Quick win | `⚡ Quick win` | One-line or trivial fix |
| Moderate | `🔧 Moderate` | Requires some thought |
| Heavy lift | `🏗️ Heavy lift` | Significant refactor |

Format: `⚠️ Potential issue | 🟠 Major | ⚡ Quick win`

Always include a `<details><summary>Proposed fix</summary>` section with a diff when possible. If no concrete fix, explain what to change.

### Submitting Inline Comments

Write the review payload to a JSON file and submit:

```bash
cat > /tmp/review.json << 'JSON'
{
  "event": "COMMENT",
  "body": "",
  "comments": [
    {
      "path": "src/file.tsx",
      "line": 42,
      "body": "⚠️ Potential issue | 🟠 Major | ⚡ Quick win\n\n**Guard `conditions` before reading `.length`.**\n\nLine 42 assumes `conditions` always exists.\n\n<details>\n<summary>Proposed fix</summary>\n\n```diff\n- if (dscStatus.conditions.length === 0) {\n+ const conditions = dscStatus?.conditions;\n+ if (!Array.isArray(conditions) || conditions.length === 0) {\n```\n\n</details>"
    }
  ]
}
JSON
gh api repos/OWNER/REPO/pulls/PR/reviews --input /tmp/review.json
```

Do NOT set a top-level `body` on the review — leave it as an empty string. The inline comments speak for themselves.

## Summary Comment

Post as a top-level PR comment via `gh pr comment PR --body-file /tmp/preflight-comment.md`.

```markdown
## Preflight Agent Report

**Verdict:** <emoji> <READY | READY WITH WARNINGS | NOT READY>
**Mode:** <check-only | managed>
**Commit:** `<head SHA>`

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Conflicts | <emoji> | <one-line detail> |
| CI | <emoji> | <pass/fail/pending> |
| Lint | <emoji> | <pass or error count> |
| Type Check | <emoji> | <pass or error count> |
| Unit Tests | <emoji> | <pass or error count> |
| Jira | <emoji> | <key or missing> |
| Test Coverage | <emoji> | <files present or missing> |
| PR Body | <emoji> | <complete or missing sections> |

### Review Findings

<details>
<summary>🟠 Major (N)</summary>

| File | Finding |
|------|---------|
| `path/to/file.tsx:42` | Guard `conditions` before reading `.length` |
| `path/to/other.tsx:15` | Missing null check on API response |

</details>

<details>
<summary>🟡 Minor (N)</summary>

| File | Finding |
|------|---------|
| `path/to/file.scss:8` | Use PF token instead of hardcoded color |

</details>

<details>
<summary>🟢 Nit (N)</summary>

| File | Finding |
|------|---------|
| `path/to/file.tsx:20` | Prefer `const` over `let` |

</details>

---
*Automated by [ODH Dashboard Agent](<workflow run URL>)*
```

Only include severity sections that have findings. Omit empty sections. Only include check rows that were evaluated.

Status emojis: ✅ passed · ❌ failed · ⚠️ warning · ⏭️ covered by CI · ➖ not applicable

## Shell Quoting

Always write comment bodies to a temp file and use `--body-file` or `--input`. Never pass markdown directly as a CLI argument.
