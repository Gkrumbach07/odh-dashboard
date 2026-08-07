---
name: pr-review-odh-extensions
description: >-
  Additional sub-agents for the PR review orchestrator specific to
  ODH Dashboard conventions (style, RBAC, Jira AC evaluation).
---

# ODH Review Extensions

This skill adds ODH-specific sub-agents to the upstream pr-review
orchestrator. The sub-agents in `sub-agents/` are discovered
alongside the upstream ones during the triage step.

## Sub-agents

| Sub-agent | Dispatch | Dimensions |
|-----------|----------|------------|
| `odh-style` | parallel | PF priority order, wrapper compliance, class naming, hardcoded tokens |
| `odh-rbac` | parallel | Missing SSAR gates, fail-open patterns, isAdmin misuse, graceful degradation |
| `odh-jira-eval` | parallel | Jira acceptance criteria coverage |
