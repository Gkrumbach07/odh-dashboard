# Step 4: Fix

Only runs when `--fix` is passed. If `--ci` without `--fix`, skip entirely.

If no `--fix` and no `--ci`, ask the user:
- "Fix failing checks"
- "Done — just wanted the report"

## Fix procedure

1. **Rebase** if conflicts found. Don't push.
2. **Review fixes** — PR: invoke `coderabbit-autofix` (decline commit/push), then fix human threads. Local: fix issues from Step 2 review.
3. **CI/lint/test fixes** — fix specific errors in files changed by this branch. Don't auto-format directories. Don't fix pre-existing issues.
4. **Cleanup** — `/simplify` on changed files, lint those files. Skip if nothing changed.
5. **Commit** — one commit, descriptive message, `Co-Authored-By` + `Signed-off-by`. Never push.

After fixing, re-run lint and type-check on changed files to verify. Print updated table — ⏭️ checks keep original status (nothing pushed), local checks get updated.
