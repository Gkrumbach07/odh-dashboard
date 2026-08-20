<!--
Agentic PR description (Problem / Solution / Evidence).

This is not the default GitHub template. Open a PR with
?template=agentic.md or paste this file. The classic template remains
.github/pull_request_template.md.

Write in the present tense. Keep this body matching the current head —
a comment does not replace an edit here. Review does not scrape CI logs;
put proof under Evidence.

Required headings must exist and have real content (not only these HTML
comments, TBD, N/A, or none). Until they do, review skips the agent.
Optional sections may be deleted when they do not apply.
-->

<!-- REQUIRED. Who hits the problem, when, and what is wrong or missing.
Concrete enough to check against the diff and, if linked, issue AC.
Detailed repro is optional. Do not use N/A. -->
## Problem



<!-- REQUIRED. What this PR ships and why this approach. Call out important
non-goals and constraints. Do not list files. When relevant, fold in:
security / RBAC / secrets; API / contract impact and who must update;
migration / data / operator steps. Omit those notes when they do not apply. -->
## Solution



<!-- OPTIONAL. Who is affected and how, including "none / internal only".
Used for blast radius and whether UX, docs, or release notes are in play. -->
## User / product impact



<!-- OPTIONAL. Tracker link(s) and the relationship to this PR, or say this
change has no tracker. A link is not required. When a link is present,
the description must stay coherent with the ask / AC — the PR body is
still the source of truth for review. -->
## Product ask / tracking



<!-- REQUIRED. Inspectable artifacts, not a promise that tests exist.
Prefer command output, redacted log snippets, Actions links, data samples,
screenshots, cluster notes. Pin SHAs where you can. Behavior-sensitive
changes need real behavior proof, not only unit/build green. Deliberate
departures from repo norms: justify here (or in Solution with a pointer
here). Intentional follow-ups belong here so they are not treated as
accidental gaps. Redact secrets. Do not use N/A. -->
## Evidence



<!-- OPTIONAL. What you tested (automated and manual), what you did not,
why gaps are OK, and pointers to new or updated tests. -->
## Test plan

