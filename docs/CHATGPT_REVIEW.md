# ChatGPT Review of Eigen

## Scope

This review is based on:

- `CLAUDE.md`
- `docs/CONTRIBUTING.md`
- the main architecture docs in `docs/`
- representative backend code in `apps/api`
- representative shared/frontend code in `packages/lib`, `packages/ui`, and app routes
- project tooling and test setup from the monorepo root

This is a deep architectural and product-engineering review, not a line-by-line audit of every file. I focused on the parts that define the project's shape, risk profile, and long-term maintainability.

## Short Summary of Global Setup and Current State

Eigen is an ambitious monorepo for a self-hosted Google Workspace alternative.

Global setup today:

- **Runtime**: Bun
- **Backend**: Elysia + SQLite/Drizzle
- **Frontend**: React 19 + TypeScript + TanStack Router + TanStack Query
- **Shared layers**: `packages/lib` and `packages/ui`
- **Realtime**: Yjs, WebSocket, SSE
- **Structure**: many focused apps under `apps/` sharing one API and one common frontend/business layer

Current state, honestly:

- **Product scope is impressive**. Mail, Drive, Docs, Chat, Calendar, Contacts, Slides, Sheets, Stickies, People, Space, Setup, and Index already exist in one coherent system.
- **The architecture has real ideas behind it**. `ownerId` routing, `Home` singletons, shared hooks, SSE invalidation, and shared UI/layout patterns are not random. Someone has thought carefully about consistency.
- **Documentation is unusually strong** for a project of this size.
- **Backend integration testing is strong** and much better than average for an early-stage product.
- **But the project is starting to feel heavier than its internal boundaries and tooling can safely support**.
- **The biggest risk is not lack of ambition or lack of engineering ability. It is architecture drift**: package boundaries are blurred, responsibilities are accumulating in central files, rules are documented but not consistently enforced, and the repo is growing faster than its guardrails.

My overall read: **this is a serious, promising codebase in active product-building mode, but it is not yet structurally mature enough for its own breadth**.

## What Is Strong

### Product ambition and coherence

- **[Breadth with one mental model]**
  The app suite is broad, but it still feels like one product rather than unrelated demos. The shared app shell, route patterns, ownership model, and file types create a coherent platform.

- **[Clear domain vocabulary]**
  Concepts like `Home`, `ownerId`, mounts, ACL, shared paths, notifications, and SSE are concrete and repeated consistently across docs and code.

### Architecture intent

- **[The `ownerId` model is a very good decision]**
  Requiring `:ownerId` in authenticated routes is a smart long-term choice. It makes ownership explicit everywhere, simplifies future sharding/load-balancing, and gives the system a stable core identity model.

- **[`Home` as a stateful domain boundary is powerful]**
  The per-owner `Home` abstraction is one of the strongest ideas in the project. It groups services, databases, SSE listeners, and lifecycle concerns around an actual domain boundary instead of scattering them globally.

- **[Thin route philosophy is mostly right]**
  `apps/api/src/routes/*.ts` are generally thin and readable. Business logic lives in domain classes instead of being trapped in route handlers.

- **[Realtime architecture is pragmatic]**
  Using SSE primarily for invalidation and notifications, not as a transport for full domain state, is a good tradeoff. It keeps payloads small and avoids inventing a second application protocol.

### Documentation

- **[Docs are a real asset here]**
  `CLAUDE.md`, `CONTRIBUTING.md`, `DATABASE.md`, `STORAGE.md`, `SSE.md`, `LAYOUT.md`, `TESTING.md`, and others form a genuinely useful knowledge base.

- **[The docs reflect actual architecture, not just aspirations]**
  In many projects, docs are decorative. Here they clearly map to real code structure.

- **[The team already does self-audit]**
  `docs/CLEANUP.md` is a sign of strong engineering self-awareness. That is a real strength.

### Testing

- **[API integration test coverage is excellent]**
  The API test setup is one of the best parts of the repo. Real app handling, temporary data roots, auth flows, and broad domain coverage are all strong signs.

- **[Testing targets real behavior]**
  The tests focus on permissions, sharing, cross-domain behavior, setup, storage, calendars, and collaboration instead of only isolated utility functions.

### Frontend consistency

- **[Shared app shell and layout patterns are good]**
  `AppShell`, `EigenApp`, `ColumnLayout`, and shared drive/layout components give the frontend a consistent structure.

- **[Hooks-first data access is the right instinct]**
  Centralizing data fetching and mutation logic in `packages/lib/src/core/[domain]/hooks` is a strong pattern. It reduces app-level duplication and keeps query invalidation logic close to the domain.

## Main Weaknesses

### 1. Package boundaries are currently the biggest architectural weakness

This is the most important structural issue I found.

There is a conceptual separation between:

- `packages/lib` for shared business logic, hooks, and types
- `packages/ui` for UI components
- `apps/api` for backend

But in practice, those boundaries are not cleanly enforced.

Examples:

- **[`packages/lib` depends on `@workspace/ui`]**
  In `packages/lib/package.json`, `@workspace/ui` is a dependency.

- **[`packages/ui` depends on `@workspace/lib`]**
  In `packages/ui/package.json`, `@workspace/lib` is also a dependency.

- **[`packages/lib` imports UI directly]**
  `packages/lib/src/core/auth/auth-context.tsx` imports `LoadingScreen` from `@workspace/ui/components/layout/pages`.

- **[`packages/lib/src/index.ts` is a red flag]**
  It re-exports from `@workspace/ui/core/*`, which is conceptually backwards and looks either dead, broken, or misleading.

- **[`apps/api` imports `@workspace/lib/types`, but that dependency is not explicitly declared in `apps/api/package.json`]**
  This suggests the package graph is partly real and partly implicit.

This means the package split is currently more aspirational than enforced.

Why this matters:

- **[It makes refactoring harder]**
  When boundaries are blurry, every change has hidden coupling.

- **[It reduces trust in the architecture]**
  The code says “lib vs ui vs api”, but the imports say “everything can reach into everything”.

- **[It blocks reuse]**
  A true shared logic package should not need UI components.

- **[It increases build and type-coupling]**
  End-to-end type safety is great, but the current dependency direction risks turning the whole monorepo into one tightly bound unit.

My honest view: **this is currently the worst of both worlds**. The repo pays the complexity cost of multiple packages without getting the full boundary safety benefit.

### 2. The central abstractions are becoming too large

A few files now carry too much responsibility.

Examples:

- `apps/api/src/lib/drive/drive.ts`
- `packages/lib/src/core/drive/hooks/use-drive.ts`
- `packages/ui/src/components/layout/drive/drive-layout.tsx`

`Drive` in particular is doing a lot:

- mount lifecycle
- folder/file CRUD
- collab document creation
- chat creation/invites
- ACL updates and propagation
- thumbnails
- previews
- inline editing
- collaborator emailing
- shared-path synchronization
- SSE emission
- destruction/cleanup

That is a lot of unrelated operational weight in one class.

This is not just a style issue. It creates:

- **[Higher regression risk]**
  Changes in one area affect many others.

- **[Harder onboarding]**
  New contributors need to understand a large percentage of the product just to safely touch one file.

- **[Testing and reasoning cost]**
  Smaller units are easier to protect and evolve.

The same pattern exists on the frontend: some shared hooks and layout components are effective, but they are beginning to act like “god files”.

### 3. Tooling and enforcement are behind the size of the project

The project has good written rules, but weak enforcement.

What I found:

- **[No visible repo-level ESLint config]**
- **[No visible Prettier config]**
- **[No visible Biome config]**
- **[No visible GitHub Actions / CI workflow]**
- **[No clear automated rule enforcement for architectural conventions]**

At the same time, the project has important rules:

- `type` over `interface`
- no direct app-level `useQuery`/`useMutation`
- no `as any`
- theme tokens instead of hardcoded colors
- hooks own mutation error handling

These are good rules. But without automated enforcement, they will drift.

And they already are drifting.

Examples:

- source files in apps still use `interface`
- there are source-level `as any` usages outside generated files
- there are `eslint-disable` escapes in source files
- the package/layering rules are documented more clearly than they are enforced

This repo is too big to rely on memory and discipline alone now.

### 4. Documentation is strong, but information architecture is getting noisy

The docs are a strength, but also becoming a maintenance risk.

The `docs/` folder mixes:

- architecture references
- contribution rules
- cleanup audits
- research notes
- proposals
- TODO design docs
- feature-specific notes

This makes it harder to answer a simple question:

> which docs are authoritative, current, and expected to guide implementation?

There is also an important governance inconsistency:

- project rules say **`LLM.md` is the single source of truth**
- the repo currently uses **`CLAUDE.md`**
- I did not find an `LLM.md`

That is not a minor naming issue. In a repo that explicitly optimizes for AI-assisted development, conflicting authority files are a real process bug.

### 5. Testing is strong on the backend, but weak as a full-product safety net

The API integration tests are strong.

But the project is a full product, not just an API.

What seems missing or underdeveloped:

- **[Frontend unit test strategy]**
  I did not find a clear, repo-level frontend testing strategy for app behavior, shared UI components, or hook contracts.

- **[End-to-end browser smoke tests]**
  For a system with auth, multi-app routing, collaboration, uploads, previews, and permissions, the lack of visible E2E coverage is a meaningful risk.

- **[Contract tests across shared FE/BE boundaries]**
  Treaty gives strong types, but type safety is not the same as behavior safety.

This means the backend can be correct while the user experience still regresses.

### 6. The codebase is simultaneously optimized for speed of building and aiming at high long-term ambition

This tension shows up everywhere.

Examples:

- docs explicitly say data is throwaway during dev and migrations/backward compatibility are not important right now
- the architecture, however, is clearly pointing toward a serious multi-app collaboration platform
- `docs/TODO-SCALABILITY.md` shows large ambitions for scaling, affinity routing, and distributed operation

This is understandable, but it creates an identity problem:

- **Is this primarily a fast-moving product laboratory?**
- **Or is it becoming a production-grade platform foundation?**

Right now the repo tries to be both.

That is workable for a while, but it becomes dangerous once the product breadth grows. The engineering standards you need for “fast local iteration” and “reliable platform base” are not the same.

## What Should Improve, Why, and How

### A. Fix the package architecture first

Why:

- This is the root structural issue.
- If you do not fix this, other improvements will have less effect.

How:

- **[Option 1: make `packages/lib` truly headless]**
  Remove all UI imports from `packages/lib`.
  Move view concerns like loading screens into `packages/ui` or app code.

- **[Option 2: merge `packages/lib` and `packages/ui`]**
  If you do not actually want strict headless/UI separation, merge them into a single frontend platform package and simplify the graph.

- **[Do not keep the current hybrid state]**
  The current state is the least clear option.

- **[Make dependencies explicit and one-directional]**
  `api -> shared-types/core` is fine.
  `ui -> lib` is fine if intentional.
  `lib -> ui` should generally not exist if `lib` is meant to be reusable logic.

- **[Delete or fix suspicious barrels]**
  `packages/lib/src/index.ts` should either become a correct public entrypoint or be removed.

### B. Split the “god files” by responsibility

Why:

- Large central files are already accumulating too much product knowledge.

How:

- **[Split `Drive` by concern]**
  Separate at least:
  - file/folder operations
  - sharing/ACL behavior
  - previews/thumbnails
  - collaboration/chat integration
  - notification/event emission

- **[Split `use-drive.ts`]**
  Separate read hooks, mutation hooks, sharing hooks, and invalidation helpers.

- **[Split orchestration-heavy UI files]**
  `DriveLayout` is still readable, but it is clearly becoming an orchestration hub. Keep it as a shell and move dialog wiring or action wiring into narrower modules.

### C. Add real enforcement, not just written rules

Why:

- The repo has enough people-facing and AI-facing rules that they now need machine enforcement.

How:

- **[Add a real linting strategy]**
  ESLint or Biome, but make it repo-standard.

- **[Enforce architecture rules where possible]**
  For example:
  - ban `@workspace/ui` imports inside `packages/lib`
  - ban direct `useQuery`/`useMutation` imports in apps
  - ban `interface` in selected folders if that is truly policy
  - ban non-generated `as any`

- **[Add CI]**
  At minimum:
  - install
  - typecheck
  - test
  - lint

- **[Differentiate generated files]**
  Exempt `routeTree.gen.ts` and other generated outputs explicitly so source rules remain strict without noise.

### D. Clean up documentation governance

Why:

- The docs are valuable, but they need clearer authority.

How:

- **[Choose one AI authority file]**
  Either keep `CLAUDE.md` or replace it with `LLM.md`, but do not leave both the rules and the repo pointing at different things.

- **[Reorganize `docs/`]**
  Suggested grouping:
  - `docs/architecture/`
  - `docs/guides/`
  - `docs/proposals/`
  - `docs/research/`
  - `docs/audits/`
  - `docs/archive/`

- **[Mark document status clearly]**
  Add a simple status label at the top:
  - authoritative
  - working draft
  - proposal
  - archived

- **[Track audit outcomes]**
  `docs/CLEANUP.md` is useful, but audits should map to tracked tasks or milestones, not just live forever as prose.

### E. Rebalance the quality strategy toward frontend safety too

Why:

- The product experience spans routing, auth, uploads, rich editors, shared UI, previews, and collaboration.
- API coverage alone is not enough.

How:

- **[Add a small E2E smoke suite]**
  Start with a few high-value flows:
  - login
  - create folder/file
  - upload/download
  - open document
  - share item
  - open notification

- **[Add tests around shared hooks and UI primitives]**
  The shared packages are where most reuse happens, so they deserve protection.

- **[Treat major apps differently]**
  Drive, Docs, Mail, Calendar, and Space probably deserve more direct UI-level coverage than the smaller apps.

### F. Decide what kind of maturity stage the project is in

Why:

- The repo is now too large to stay ambiguous forever.

How:

- **[If the goal is still fast product iteration]**
  Accept that clearly, simplify aggressively, merge layers where useful, and optimize for shipping.

- **[If the goal is platform hardening]**
  Invest in boundaries, enforcement, CI, frontend tests, and operational discipline.

My recommendation: **do both, but in phases**.

- next phase: simplify and enforce boundaries
- after that: harden quality and delivery
- only after that: widen scope further

## What Can Be Simplified or Cleaned Up

### Simplification opportunities

- **[Simplify the frontend package story]**
  Either:
  - `lib` = headless logic and hooks, `ui` = presentation only
  - or merge them

- **[Reduce barrel/export ambiguity]**
  Some exports feel accidental rather than intentional. Public surfaces should be deliberate.

- **[Reduce doc sprawl]**
  A smaller set of authoritative docs will improve onboarding more than more documentation will.

- **[Reduce repeated route boilerplate where safe]**
  Not everything needs abstraction, but some route groups are repetitive enough that helper composition could reduce maintenance overhead.

- **[Reduce invalidation sprawl over time]**
  The current “invalidate on success/SSE” model is good for correctness, but broad invalidation can become noisy. Keep the model, but tighten the granularity where it hurts.

### Cleanup opportunities

- **[Remove or repair dead/unclear files]**
  Especially anything like `packages/lib/src/index.ts` that no longer reflects the real package shape.

- **[Normalize dependency declarations]**
  If a package imports another workspace package, declare it explicitly.

- **[Normalize conventions in source code]**
  If `type` over `interface` matters, enforce and gradually migrate. If it does not matter enough, remove the rule. Current half-enforcement creates noise.

- **[Review source-level `as any` usage]**
  Generated files are one thing. Source code is another. The rule is good; the project should either enforce it or soften it.

## Specific Honest Findings

### The best thing in the project

The best thing here is **the combination of product ambition and real architectural intent**.

This is not a pile of disconnected features. It already has the beginnings of a platform model.

### The weakest thing in the project

The weakest thing is **the gap between documented architecture and enforced architecture**.

Your written rules are stronger than your automated boundaries right now.

### The most likely future pain if unchanged

If you keep scaling feature breadth without tightening boundaries and enforcement, you will likely get:

- more cross-package entanglement
- more oversized central files
- slower refactors
- more “safe-looking but risky” changes
- more reliance on local tribal knowledge

### The biggest strategic risk

The biggest strategic risk is **trying to scale product surface faster than internal structure**.

That is a very common way strong early projects become harder to evolve.

## Prioritized Recommendations

### P1 — Do next

- **[Fix package boundaries]**
  Decide whether `packages/lib` is truly headless or whether `lib` and `ui` should be merged.

- **[Add CI + linting + architecture enforcement]**
  The repo has earned this.

- **[Create one authoritative AI/project context file]**
  Resolve `CLAUDE.md` vs `LLM.md`.

- **[Start splitting the biggest domain files]**
  Begin with Drive.

### P2 — Do soon after

- **[Add a minimal E2E smoke suite]**
- **[Reorganize the docs folder]**
- **[Make dependency declarations honest and explicit]**
- **[Clean suspicious barrels and dead exports]**

### P3 — After that

- **[Tighten cache invalidation granularity where it matters]**
- **[Add more frontend/shared-package tests]**
- **[Continue performance work only after boundary cleanup]**

## Suggested Action Plan

### Phase 1 — Clarify the architecture surface

- **[Decide the future of `packages/lib` and `packages/ui`]**
  Make an explicit decision between a truly headless `lib` package and a merged frontend platform package. Do not leave the current circular/hybrid structure in place.

- **[Make the workspace dependency graph honest]**
  Audit workspace dependencies and declare every real package-to-package dependency explicitly. Remove suspicious barrels or entrypoints that no longer reflect the actual architecture.

- **[Resolve `CLAUDE.md` vs `LLM.md`]**
  Pick one authoritative AI/project-context file and make the repo, docs, and contribution rules all point to the same source of truth.

### Phase 2 — Add guardrails

- **[Add a repo-standard lint/config stack]**
  Introduce one enforced formatting/linting toolchain and make it part of normal development, not optional cleanup.

- **[Encode architecture rules in tooling]**
  Add rules for package boundaries, banning direct app-level `useQuery`/`useMutation`, controlling `as any`, and distinguishing generated files from handwritten source.

- **[Add CI for minimum quality gates]**
  Run typecheck, test, and lint on every PR or main-branch change so the written standards are actually enforced.

### Phase 3 — Reduce concentration risk

- **[Refactor the largest domain files first]**
  Start with `apps/api/src/lib/drive/drive.ts`, then `packages/lib/src/core/drive/hooks/use-drive.ts`, then orchestration-heavy UI files like `packages/ui/src/components/layout/drive/drive-layout.tsx`.

- **[Split by responsibility, not by file size alone]**
  Separate CRUD, sharing/ACL, previews, collaboration/chat, invalidation, and notifications into narrower modules with clearer ownership.

### Phase 4 — Improve product-level safety

- **[Add a minimal browser smoke suite]**
  Cover login, file creation, upload/download, open-document, sharing, and notification flows. Keep it small but always green.

- **[Add tests for shared hooks and UI primitives]**
  Protect the reuse layer, because regressions there affect many apps at once.

### Phase 5 — Clean the knowledge surface

- **[Reorganize `docs/`]**
  Separate architecture docs, guides, audits, research, and proposals into clearer folders so authoritative docs are easier to find.

- **[Mark document status explicitly]**
  Add simple labels like authoritative, draft, proposal, or archived so contributors know what to trust.

### Suggested order of execution

- **[Week 1]** Decide package direction, fix authority-file governance, and clean the dependency graph.
- **[Week 2]** Add lint/config/CI guardrails.
- **[Weeks 3-4]** Refactor Drive and the biggest shared frontend files.
- **[Weeks 5-6]** Add E2E smoke coverage and shared-layer tests.
- **[After that]** Resume broader feature expansion on top of a cleaner base.

## Final Verdict

This is a **strong, unusually thoughtful project**.

It already has:

- real product breadth
- strong backend testing
- strong documentation
- good architectural ideas
- a coherent shared-platform direction

But it also clearly shows the pressure of becoming large:

- package boundaries are muddy
- responsibilities are pooling into big central files
- repo rules are stronger than enforcement
- docs are becoming harder to govern
- frontend quality protection lags behind backend quality protection

So my honest conclusion is:

**Eigen is impressive and promising, but the next phase should be consolidation, boundary cleanup, and enforcement rather than just more feature expansion.**

If you do that well, the project can become much easier to scale technically and organizationally.
If you skip that step, the codebase will probably still move fast for a while, but with rising hidden cost.
