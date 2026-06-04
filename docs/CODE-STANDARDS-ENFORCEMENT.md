# Enforcing Standards & Improving Discoverability

Companion to [CODE-STANDARDS.md](CODE-STANDARDS.md) (the rules) and
[CODE-QUALITY-AUDIT.md](CODE-QUALITY-AUDIT.md) (a 2026-06-04 snapshot of where the rules are drifting).
This document is about the **mechanism**: how to make the standards self-enforcing with tooling (mostly
Biome 2.4) and — more importantly — how to make the shared primitives discoverable enough that the right
answer is the *easy* answer.

Guiding principle: **prefer making the correct path the path of least resistance over policing the wrong
one.** A linter catches regressions; discoverability prevents them from being written. Both matter, but the
second is the real fix for the dominant problem.

## The two failure modes (from the audit)

The audit's 43 findings collapse into two mechanisms, and both are amplified by LLM-assisted development:

1. **Drift** — small convention violations: inline `invalidateQueries` bypassing the `invalidate*()`
   helpers, `as Type` casts on Eden responses, query hooks missing `staleTime`/`enabled`, bare
   `throw new Error` where `ApiError` belongs, hand-rolled `en-US` date formatting. Individually trivial;
   collectively the leading indicator of decay. **Root cause: the rules live in prose, not in CI.**
2. **Re-derivation** — the same component / hook / scaffold rebuilt per app and then diverging: the 4×
   EigenDoc editor route, the two byte-identical storage classes, the comment-lifecycle wiring, the
   contact-input state machine. **Root cause: the shared primitive doesn't exist yet, or isn't
   discoverable — so rebuilding is cheaper than finding.** This is *the* AI-slop vector: an LLM (and a
   busy human) re-creates what it can't see.

Enforcement attacks #1. Discoverability attacks #2.

## Current state

Biome **2.4.9**, `recommended` rules + formatting, with a handful of rules turned off
(`noNonNullAssertion`, `noDescendingSpecificity`, `useLiteralKeys`, `noAssignInExpressions`, a11y). No
`noRestrictedImports`, no `overrides`, no GritQL plugins, no cross-file fitness checks, no generated
catalog. That's a lot of unused headroom.

> **On upgrading:** everything below works on 2.4.9 — GritQL plugins, `noRestrictedImports`, and `overrides`
> all shipped in Biome 2.x. Upgrading is therefore *optional* and only buys newer/promoted rules (Biome
> ships rules frequently). Worth bumping periodically; not a prerequisite for this plan.

## The enforcement ladder (defence in depth)

| Tier | Mechanism | Catches | Cost |
|------|-----------|---------|------|
| 0 | Formatter (Biome) | style noise | done |
| 1 | Built-in Biome rules | `any`, dead imports/vars, `import type`, hook deps | trivial |
| 2 | `overrides` + `noRestrictedImports` | **architectural seams** (layering, React-free engine, `cn()`) | low |
| 3 | GritQL plugins | project-specific structural rules built-ins can't express | medium |
| 4 | Fitness-function tests/tools | cross-file + semantic (dead *exports*, duplication, route/key conventions) | medium |
| 5 | Discoverability | stops re-derivation at the source | ongoing |

Climb it roughly in order: each tier is higher-effort and catches what the tier below can't.

---

## Tier 1 — Built-in Biome rules

Flip on the high-value rules that map directly to audit findings. Most are autofixable, so adoption is a
mechanical `biome check --write` plus a review of the diff.

| Rule (group) | Enforces | Audit finding it closes | Suggested level |
|--------------|----------|-------------------------|-----------------|
| `noExplicitAny` (suspicious) | bans `any`, incl. `x as any` | `as any` casts | error |
| `noUnusedImports` (correctness) | dead imports | dead-code vein | error (autofix) |
| `noUnusedVariables` (correctness) | dead locals | dead-code vein | error (autofix) |
| `useImportType` (style) | `import type` for type-only imports | typing standard | error (autofix) |
| `useExhaustiveDependencies` (correctness) | missing hook deps | latent React bugs | warn |
| `noUndeclaredDependencies` (correctness) | imports not in `package.json` | phantom deps | warn |

```jsonc
// biome.jsonc → linter.rules (additive)
"suspicious": { "noExplicitAny": "error" },
"correctness": {
  "noUnusedImports": "error",
  "noUnusedVariables": "error",
  "useExhaustiveDependencies": "warn"
},
"style": { "useImportType": "error" }
```

Two judgment calls to make deliberately, not by default:

- **`noNonNullAssertion`** is currently off. Project memory prefers runtime guards over `!`. Consider
  `"warn"` scoped to `packages/lib/**` (via an override) to nudge the shared layer without flooding the
  apps. Leave off if it proves noisy — this is a nudge, not a mandate.
- **`useNamingConvention`** enforces *casing* but not the *semantic* prefixes that actually aid discovery
  (`use*`, `Eigen*`, `*Dialog`). Turn it on only if the casing churn is worth it; the prefixes belong in
  Tier 5, not here.

---

## Tier 2 — Import boundaries (the architectural seams)

This is the highest-leverage, lowest-false-positive tier: it makes the layering rules in AGENTS.md
*mechanical*.

**Key fact about Biome's `noRestrictedImports`:** it matches on the **imported module only**, *not* on the
importing file (unlike ESLint's `import/no-restricted-paths`). So "files under X may not import Y" is
expressed by wrapping the rule in an **`overrides` entry scoped to X** with `includes`. That combination is
how you encode every seam below.

| Seam to enforce | Where | Ban |
|-----------------|-------|-----|
| **Engine stays React-free** (backend imports it) | `packages/sheet/src/engine/**` | `react`, `react-dom` |
| **`lib` never imports `sheet`** (one-way rule) | `packages/lib/**` | `@workspace/sheet`, `@workspace/sheet/*` |
| **Only `cn()` may import `clsx`/`tailwind-merge`** | everywhere except the `cn` util | `clsx`, `tailwind-merge` |
| **App components don't fetch directly** | `apps/*/src/**` | `useQuery`/`useMutation` from `@tanstack/react-query` |
| **Toasts live in hooks** | everywhere except `packages/lib/**/hooks/**` | `toast` from `sonner` |

```jsonc
// biome.jsonc → top level
"overrides": [
  {
    // The sheet engine is imported by apps/api — it MUST stay React-free.
    // (See CODE-QUALITY-AUDIT.md → "packages/sheet Package Boundary".)
    "includes": ["packages/sheet/src/engine/**"],
    "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "paths": {
      "react": { "message": "engine/ is imported by the backend and must stay React-free." },
      "react-dom": { "message": "engine/ is imported by the backend and must stay React-free." }
    } } } } } }
  },
  {
    // Dependency direction is one-way: sheet → lib, never the reverse.
    "includes": ["packages/lib/**"],
    "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
      { "group": ["@workspace/sheet", "@workspace/sheet/**"],
        "message": "lib must not import sheet (would pull React into the backend). Put shared sheet types in packages/lib/src/sheets/types.ts." }
    ] } } } } }
  },
  {
    // Data fetching belongs in packages/lib/src/core/<domain>/hooks/, not app components.
    "includes": ["apps/*/src/**"],
    "linter": { "rules": { "style": { "noRestrictedImports": { "level": "warn", "options": { "paths": {
      "@tanstack/react-query": {
        "message": "Move useQuery/useMutation into packages/lib/src/core/<domain>/hooks/.",
        "importNames": ["useQuery", "useMutation", "useInfiniteQuery"]
      }
    } } } } } }
  }
]
```

For the `cn()` rule, ban `clsx`/`tailwind-merge` globally in `linter.rules.style.noRestrictedImports`, then
add one override turning the rule `"off"` for the single file that defines `cn()`. Start the app-fetch and
toast seams at `"warn"` — a few legitimate app-level `useQuery` calls may exist; review them, whitelist or
relocate, then ratchet to `error`.

---

## Tier 3 — GritQL plugins (project-specific structural rules)

Biome 2.x runs custom lint rules written in **GritQL**: declare a `plugins` array in `biome.jsonc` pointing
at `.grit` files that match AST patterns and call `register_diagnostic`. Use this for the structural rules
no built-in expresses. (Biome is **not type-aware**, so these are syntactic/structural heuristics — good for
the patterns below, not for anything needing cross-file type information.)

| Plugin idea | Pattern | Audit finding |
|-------------|---------|---------------|
| `useQuery` missing `staleTime` | `useQuery({…})` object arg with no `staleTime` key | missing-staleTime hooks |
| Native confirm/alert | `window.confirm(…)`, `confirm(…)`, `alert(…)` | `window.confirm('…Discard?')` |
| Locale-less dates | `.toLocaleDateString(…)`/`.toLocaleString(…)` without a leading `'en'` arg | hand-rolled `en-US` dates |
| Bare HTTP error | `throw new Error(…)` under `apps/api/src/routes/**` & `lib/**` | bare error vs `ApiError` (warn — internal invariants legitimately use `Error`) |
| Inline invalidation | `queryClient.invalidateQueries(…)` outside `**/hooks/**` & SSE handlers | bypassing `invalidate*()` helpers |
| Type re-export through barrel | `export type` / `export { type … }` in `packages/lib/src/core/**/index.ts` | no type re-exports through barrels |

```jsonc
// biome.jsonc → top level
"plugins": ["./biome/rules/no-native-confirm.grit"]
```

```grit
// biome/rules/no-native-confirm.grit  — ILLUSTRATIVE; verify syntax against the installed Biome 2.4 plugin docs
language js

`window.confirm($message)` where {
  register_diagnostic(
    span = $message,
    message = "Use the shared <ConfirmDialog> (packages/ui) instead of window.confirm()."
  )
}
```

Keep this tier small and high-signal. Each plugin is a maintained artifact; only write one when the pattern
recurs and a built-in can't catch it.

---

## Tier 4 — Fitness functions (what Biome can't see)

Biome is fast because it's single-file and not type-aware. The rest needs cheap CI checks:

- **`knip`** — unused *exports*, files, and dependencies across the monorepo. Biome only sees unused
  symbols *within* a file; knip is what catches the audit's whole dead-code vein (`combobox.tsx` + its
  `@base-ui/react` dep, `useFileUpload`, `FormulaEngine.evaluateAll()`, the three unreachable mail
  endpoints). Run in CI, report-only first, then fail-on-new.
- **`jscpd`** (copy-paste detector) — flags new duplication over a threshold so the *next* 4×-scaffold gets
  caught at PR time, not six months later. Treat it as **radar, not a wall**: the philosophy says don't
  extract single-use helpers, so some duplication is fine. Report in CI; don't hard-block.
- **A tiny convention test** (`bun test`) — assert the things that are semantic but cheap to scan:
  every authenticated route file has `:ownerId` as its second path segment; every query-key factory
  threads `ownerId`. A 40-line test closes two recurring pitfalls that no linter can.
- **`tsc --noEmit`** — already in `bun run check`. Keep it: Biome ≠ typecheck, and `as`-cast / type-chain
  issues only surface here.

---

## Tier 5 — Discoverability (the real fix for re-derivation)

Tiers 1–4 stop regressions. This tier stops the duplication being written at all, and it matters most for
the AI-slop concern, because **LLMs re-create what they can't find.** Make the right thing findable and the
slop largely stops accruing.

1. **Shrink the surface — one canonical way.** Every dedup in the audit *is* discoverability work:
   collapsing the 4 editor routes into `useEigenDocEditorRoute`, the two storage classes into one base,
   `AddCardDialog`+`CardSettingsDialog` into one `CardFormDialog` — each removes a wrong answer. Always pair
   a new shared primitive with deletion of the local copies; fewer alternatives means the right one is
   unmissable.
2. **A generated primitive catalog.** Auto-generate `docs/SHARED-PRIMITIVES.md` from the exports of
   `packages/ui` and `packages/lib` (name, file, one-line purpose). Regenerate + diff-check in CI so it
   can never go stale. This is the authoritative "before you build X, look here" index — the existing
   AGENTS.md *Key UI Components* table is the seed, but hand-maintained tables rot; generate it instead.
   It serves humans browsing and the LLM that AGENTS.md already instructs to "check existing code first."
3. **Scaffolds / generators — the positive counterpart to lint.** A `bun run new:hook <domain>` /
   `new:eigendoc-route` that emits the *conforming* skeleton (query keys with `ownerId`, `enabled` +
   `staleTime`, an `invalidate*()` fn, `onMutationError`). When the correct shape is the starting point,
   there's nothing to copy-paste-and-drift — this directly kills the 4×-scaffold failure mode at its root.
4. **Naming for grep-ability.** Codify the prefixes already in use (`use*`, `Eigen*`, `*Dialog`,
   `*Provider`, `invalidate*`) so a whole category is one `grep` away. (Casing is enforceable via
   `useNamingConvention`; the semantic prefixes stay a documented convention + review check.)
5. **Keep AGENTS.md / CODE-STANDARDS.md as the LLM's entry point.** They already do the heavy lifting — the
   BAD/GOOD examples are genuinely good. The cheapest high-payoff additions: a one-line pointer to the
   generated catalog, and a "search before you build" instruction near the top. This is the single
   best ROI move for reducing LLM-generated duplication.

---

## Rollout — ratchet, don't break the build

- Land in waves. Start every new rule at **`warn`**, autofix what's autofixable (`biome check --write`),
  and commit the mechanical churn in its own commit so review is trivial.
- Grandfather existing violations **per-directory** with `overrides` (rule off in legacy paths, on
  elsewhere), then burn the list down and flip to `error`. Never red-CI the whole repo on day one.
- Suggested order (impact ÷ effort): Tier-1 autofixables + `noExplicitAny` → the three import boundaries
  (engine-React-free, lib-no-sheet, `cn()`-only) → `knip` in CI → generated `SHARED-PRIMITIVES.md` +
  AGENTS pointer → GritQL (`staleTime`/confirm/dates) → scaffolds.
- Watch the **ignore budget**: the count of `// biome-ignore` comments is a drift gauge. A rule with
  hundreds of ignores is the wrong rule (or signals a refactor), not a reason to add more ignores.
- Keep Biome **fast** — that's a feature. Relegate the slow, cross-file checks (`knip`, `jscpd`) to CI;
  keep the pre-commit / editor path on Biome alone.

## What NOT to enforce

- **Anything needing human judgment** — "is *this* abstraction over-engineered?", "is *this* deviation
  justified?". A linter that fires on judgment calls trains people to ignore the linter.
- **Rules that fight "flat, direct, simple."** Don't mandate barrels everywhere, don't force discriminated
  unions, don't add ceremony. The standards reward less structure, not more.
- **High-false-positive rules.** Trust is the linter's capital; one noisy rule discredits the whole config.
- **Duplication as a hard gate.** `jscpd` is radar. Some duplication is correct by the project's own
  philosophy; let humans decide which.

## TL;DR

The drift (Tier 1–3 Biome) is the cheap, immediate win — turn on the autofixables and the three import
boundaries this week. The duplication (Tier 5 discoverability) is the deeper and more important fix, because
it's the one that addresses *why* AI-assisted development re-derives instead of reusing. Lint stops the
bleeding; a generated catalog + scaffolds + a "search first" instruction is how the shared codebase actually
becomes the strength it's meant to be.
