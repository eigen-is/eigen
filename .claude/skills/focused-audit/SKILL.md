---
name: focused-audit
description: Use when auditing one area of Eigen (a lib domain, a route group, a protocol server, a package) before a feature builds on it, when picking the next area from ROADMAP § Focused audits, or when a layer feels too risky to extend as it is. Covers choosing the scope, the cleanup, the cold review, the one fix round and the scoped re-review. Not for reviewing a branch's own diff, which the orchestrate skill covers.
---

# Focused audit

Audit a layer right before a feature builds on it: its findings are cheapest to fix then, and the feature lands on code that meets the bar. The open areas are listed in [ROADMAP.md § Focused audits](../../../docs/ROADMAP.md#focused-audits); take the one the next feature touches.

## Scope

One area per audit: a lib domain with its route, its `packages/lib` hooks and its `types/<domain>.ts`, or one protocol server, or one package. Code that exists for the area but lives in other modules is in scope and moves into the area. Two areas that solve the same problem, such as the WebDAV and CalDAV servers, are audited side by side so their differences show.

Start with the risk-seam files, where a bug costs data or access: ACL checks, locks, persisted formats, cross-home calls, and parsers or routes that take untrusted bytes.

## The recipe

1. **Clean up** the area with the [source-file skill](../source-file/SKILL.md), every step of it, held to the [CODE-STANDARDS.md](../../../docs/CODE-STANDARDS.md) bar: renames, top-down order, moves to the right module ([ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)), splits, honest types, visibility and imports, not only headers and comments. The report is the skill's per-file table. Risk findings are reported, not fixed: a cleanup that also changes behavior can't be reviewed as a cleanup.
2. **A cold review** of the result by an agent that did not do the cleanup, held to [REVIEW-STANDARD.md](../../../docs/REVIEW-STANDARD.md), with the cleanup's risk findings as leads to confirm or reject.
3. **One fix round.** Each fix starts with a test that fails on the old code. A finding whose fix is a new route, migration, package or design choice goes to the owner first (AGENTS.md § Critical Rules), and a finding left unfixed becomes a ROADMAP row.
4. **A scoped re-review** of the fix diff only: fixes bring regressions of their own.

Seats and models follow the [orchestrate skill](../orchestrate/SKILL.md): reviewers run on the strongest model, mechanical seats on the cheapest.

## Closing

- Docs in the same cycle: gotchas found go into the domain doc via the [domain-doc skill](../domain-doc/SKILL.md).
- Remove the area from ROADMAP § Focused audits in the same commit; a part left open stays as a shorter bullet.
- `bun run check` passes before the merge.
