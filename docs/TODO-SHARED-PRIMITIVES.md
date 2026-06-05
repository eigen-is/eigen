# TODO — Shared Primitives Consistency Audit

> **Status: Reviewed + decisions locked 2026-06-05** — an independent Opus review (no session context) verified every
> finding against source; verdicts and corrections are folded into *Review outcome* below, and the
> original claims (F1–F8) are kept intact beneath it as the source record. Compiled 2026-06-05 from an
> analysis of
> [`docs/SHARED-PRIMITIVES.md`](SHARED-PRIMITIVES.md) (the generated index of everything `packages/lib` +
> `packages/ui` export) cross-checked against the rules in [`AGENTS.md`](../AGENTS.md) and
> [`CODE-STANDARDS.md`](CODE-STANDARDS.md).
>
> **Purpose:** catalogue the renames / moves / barrel changes that would make the shared surface more
> consistent and discoverable. Nothing here has been applied to code yet.
>
> **Next step:** a fresh reviewer verifies each finding against source, challenges the recommendations,
> and flags false positives. See *How to review this document* below.

---

## How to review this document

You are reviewing a findings draft. Be skeptical — the goal is correctness, not agreement.

1. **Read the standards first**: [`AGENTS.md`](../AGENTS.md) and [`CODE-STANDARDS.md`](CODE-STANDARDS.md)
   in full. Several findings lean on specific rules in those files; confirm the rule actually says what
   the finding claims.
2. **Verify every claim against source.** Each finding lists `file:line` evidence. Open it. Do not trust
   this document — confirm the duplicate/collision/inconsistency is really there and still present.
3. **Challenge the recommendations.** Especially F1 (the barrel rule) — it's a judgement call with real
   trade-offs. If the reasoning is wrong, say so and why.
4. **Hunt for false positives.** Where a finding says "needs-look", do the look. Where it says "verified",
   re-verify a sample. Flag anything that's actually intentional design (check git blame / nearby docs /
   code comments before declaring something a mistake — some "inconsistencies" are deliberate).
5. **Don't widen scope into a rewrite.** These are consistency/clarity fixes on the *exported surface*,
   not a redesign of the packages.
6. **Output**: for each finding, a verdict — `CONFIRMED` / `PARTIALLY CONFIRMED` / `REJECTED` / `NEEDS
   DECISION` — with evidence, plus any findings this audit missed.

Note: eigen.is is **live with real users** (stickies especially are heavily used) — this is **not** a
free-for-all rename. The audit's changes are *identifier-level only* (type names, type locations, import
paths, a value-preserving constant dedup) and change **no persisted or wire value**, so they need no
migration. But **persisted/wire values are frozen** — never change a string written to the drive DB, a Yjs
doc, SQLite, S3, or the network. See *Live-data / BC safety* in the Decisions section.

---

## Standards these findings rely on

- **AGENTS.md** — "One source of truth per fact … Two lists of one fact drift." / "A primitive isn't
  'shared' until its barrel exports it … deep-importing past a barrel usually means the thing you reached
  for should have been exported." / "reusable types through `@workspace/lib/types/<domain>`."
- **CODE-STANDARDS.md § Code Style** — "Name for grep-ability; don't shadow libraries … don't give three
  different helpers the same name."
- **Project convention (team feedback): no type re-exports through barrels** — import types directly from
  `@workspace/lib/types/<domain>`; domain/value barrels export values only.

---

## Summary

| ID | Finding | Severity | Review verdict |
|----|---------|----------|----------------|
| F1 | `@workspace/ui` barrel isn't a single front door (3 import depths, no principle) | High | CONFIRMED (rec → decide) |
| F2 | `EIGEN_DOC_TYPES` and `EIGEN_DOCUMENT_TYPES` are the same list under two names | High | CONFIRMED — safe quick win |
| F3 | `EigenDocType` type re-exported through the UI value barrel | Medium | CONFIRMED — but the re-export is dead (safe to delete) |
| F4 | `DriveType<Name>` vs `Drive<Category>Type` word-order flip; `eigendoc-config(s).ts` twins | Medium | PARTIAL → decide (files are not accidental twins) |
| F5 | Shared types defined in hook/util files, surfaced via value/domain barrels | Medium | CONFIRMED (scoped — exclude UI Props/context types) |
| F6 | Exported names shadow libraries/globals (`Headers`, `EditorContent`, `Command`, `Bar`/`Bra`/`Ket`) | Medium-Low | PARTIAL (`EditorContent` real; `Headers` has no importers) |
| F7 | Confusing near-duplicate pairs (`useEmail`/`useEmailById`, logos, loaders, comments split) | Low-Medium | CONFIRMED as questions — comments split = DO NOT MOVE |
| F8 | The generated index miscategorises non-components under "Components" | Low (doc) | CONFIRMED — generator fix |

---

## Review outcome (independent Opus review, 2026-06-05)

A fresh reviewer (no session context) read AGENTS.md, CODE-STANDARDS.md, SHARED-PRIMITIVES.md, both
packages' `exports` maps, the `bun run primitives` generator, and every cited `file:line`, and ran
read-only `git log`/`blame` to check intent. Adjudication:

| ID | Verdict | Key adjudication |
|----|---------|------------------|
| F1 | CONFIRMED (rec → decide) | 3 depths real; `DeleteDialog` truly fails from root (strongest point). Tree-shaking cost is **overstated** — apps consume `@workspace/ui` as source and Vite tree-shakes side-effect-free re-exports; only the TipTap `editor` has a real (HMR-graph) reason to stay subpath. The generator *can* see resolved paths, so the `--check` gate is feasible — but land moves first, gate later. |
| F2 | CONFIRMED | Value-identical 5-element lists; no caller depends on divergence. Safe quick win. |
| F3 | CONFIRMED (rationale overstated) | Re-export is real but **dead** — nothing imports `EigenDocType` from `@workspace/ui`. Deleting line 4 is safe and also clears F8's misfiling. |
| F4 | PARTIAL → decide | Word-order flip (A) real; the unions are genuinely distinct, so the rename is clarity-only churn (decide). Files (B) are **not** accidental twins — `eigendoc-configs.ts` imports from `eigendoc-config.ts` (deliberate type/instances split); a merge still removes the footgun. `loginpage.tsx`→`login-page.tsx` trivial. |
| F5 | CONFIRMED (scoped) | All listed domain types verified in non-`types/` files; `types/auth.ts` does not exist yet (create it). **Guardrail:** do NOT widen to UI component Props / local-context types (`*Props`, `LayoutContextType`, `StorageData`, `SlashTargetContext`) — those are component surface, not relocatable domain types. |
| F6 | PARTIAL | `EditorContent`→`FileEditorContent` real, do it. `Command`→`PaletteCommand` latent (no file imports both), optional. **`Headers` has zero importers** — cosmetic only, de-prioritize. `Bar`/`Bra`/`Ket` = team taste. |
| F7 | CONFIRMED as questions | **Comments split = DO NOT MOVE** — deliberate, documented design (COMMENTS.md + unification commit `ad055d42`): `CommentEntry` is the server projection, `CommentCard` the Y.Doc card. `useEmail` (reactive query) vs `useEmailById` (imperative fetch) are distinct, not a dup. Logos/loaders distinct. Cosmetic renames at most. |
| F8 | CONFIRMED | Generator's `classify()` is name+flags only; fixable there. Add `EigenDocDriveContext` (another `createContext` mis-bucketed as a Component) to the list. |

**Verified non-issue confirmed:** the `DEFAULT_MOUNT_ID` double-listing is a legit value re-export.

**Added by the review (fold into the findings):**
- **F5 guardrail** — make the carve-out of UI Props/context types explicit so a codemod doesn't over-reach.
- **F8** — `EigenDocDriveContext` is a second mis-bucketed context const (index line 62).
- **New minor** — `EigenDocAppConfig.driveType` is typed `string` (`eigendoc-config.ts:9`) though always a
  `DriveType*` literal; could be `DrivePathType`. Fold into F4 if touching that file.
- **Do-not-touch** — `DriveContextType` (`types/drive.ts:345`) is a *correct* one-canonical-type example
  backing both `DriveContext` and `EigenDocDriveContext`; leave it during any F4/F5 sweep.
- No other duplicate-fact registries or realized library shadows found across the 720-primitive surface —
  F2 and F6-`EditorContent` are the only realized cases.

### Disposition

**Safe to action now (isolated, ~zero call-site risk):** F2 (collapse to a derived const), F3 (delete the
dead re-export), F8 (generator buckets), F4-B (merge `eigendoc-config(s).ts`, rename `loginpage.tsx`).

**Needs a decision before coding:**
- **F1** — endorse re-export-to-root (fixes the `DeleteDialog` break); decide the subpath allowlist
  (reviewer's read: just the `editor` module; normalize providers to root to match `UploadProvider`);
  defer the CI `--check` gate to a follow-up. Codemod-scale → own branch.
- **F4-A** — rename the `Drive*Type` unions? Clarity-only churn across importers.
- **F5** — relocate the clear domain types (incl. a new `types/auth.ts`), excluding UI Props/context.
  Codemod-scale → own branch.
- **F6** — `EditorContent` rename: yes. `Command`: optional. `Headers`: drop. `Bar`: taste.

**Resolved as no-action:** F7 comments split (documented intentional design); the other F7 pairs are
real-but-distinct (cosmetic renames at most).

---

## Decisions (locked 2026-06-05)

Resolves the "needs a decision" items. Author + reviewer recommendations accepted.

- **F1 — barrel rule: ADOPT** ("root by default, subpath only by exception"). Re-export every reusable
  component/hook from the `@workspace/ui` root, including providers (`PreviewProvider`/`SSEProvider`, to
  match `UploadProvider`) and the generic `/hooks/*`. **Allowlist — stays subpath-only: the TipTap `editor`
  (`LightEditor`) only.** Keep per-folder concern barrels as secondary internal paths; root is canonical.
  **Defer** the `bun run primitives --check` enforcement gate to a follow-up. Also pull the `braket` glyphs
  (`Bar`/`Ket`) **off** the root barrel — they're internal to `AppLogo`/login. Codemod-scale → own branch.
- **F4-A — `Drive*Type` union rename: SKIP.** Pure internal type-alias churn, low payoff. (If ever
  revisited: use the existing `Kind` vocabulary — `DriveCollabKind`/`DriveContainerKind` — and drop the
  `DriveChatType` alias.) F4-**B** (merge `eigendoc-config(s).ts`, rename `loginpage.tsx`, tighten
  `EigenDocAppConfig.driveType`) still proceeds.
- **F5 — type relocation: DO A SUBSET.**
  - **Move:** drive-access trio (`DirectAccessItem`/`InheritedAccessItem`/`DriveAccessItem`) →
    `types/drive.ts`; auth types (`AuthContextType`/`AuthUser`) → new `types/auth.ts`.
  - **Leave (co-location correct):** `EigenColor`/`EigenFont`/`TextPreviewMode` — `typeof CONST` types beside
    their constant; relocating would split type from value.
  - **Skip for now:** `ViewMode`, `LocalCommand`, `FigureLayout`.
  - Guardrail holds: never relocate UI component Props / local-context types.
- **F6 — shadowed names: DO 2 (+1 optional), LEAVE branding.**
  - `EditorContent` → `FileEditorContent` (real TipTap collision): **DO.**
  - `Headers` → `MailHeaders` (zero external importers → near-free; kills a global shadow): **DO.**
  - `Command` → `PaletteCommand`: **optional** (cheap, better grep-ability).
  - `Bar`/`Bra`/`Ket`: **LEAVE** — `Bar` is the `|` in Dirac `⟨bra|ket⟩`, a coherent glyph set, not a
    mis-name. (`Bra`/`braket/bra.tsx` is a stale index entry — regen drops it.)

### Revised action buckets

- **Safe-now branch:** F2, F3, F8, F4-B, plus F6's `EditorContent` + `Headers` renames.
- **Barrel branch:** F1 (moves only; defer the CI gate).
- **Types branch:** F5 subset (drive-access + auth → new `types/auth.ts`). May fold into the barrel branch.
- **Skipped / deferred:** F4-A; F5 constants + optional types; F6 `Command` (optional) + branding.

### Live-data / BC safety (read before touching any constant)

eigen.is is in production and **stickies are heavily used**, so the "pre-release, change freely" assumption
is retired. Every change in this audit is identifier-level and BC-safe, but these are **frozen values** —
rename the *identifier* if you must, never the *value*:

- **Drive type/mime strings** — `DRIVE_TYPE_*` (`'stickies'`, …) and `DRIVE_MIME_*`
  (`'application/eigenstickies'`, …); persisted in the drive DB and used in routes. F2's dedup must keep the
  `EIGEN_DOC_TYPES` / `EIGEN_DOCUMENT_TYPES` array values **byte-identical**.
- **Yjs root keys** — `EIGEN_DOC_TYPE_INFO[*].yjsRoots` (stickies: `columns` / `tasks` / `columnOrder`); the
  live Y.Doc structure of every existing document.
- **DB schemas/columns, S3 storage keys, and `EIGEN_STICKIES_*` color/indicator keys** a note persists.

Rule: a type rename or file move is fine (compile-time only); changing a value already on disk/wire requires
an explicit migration plan — **ask first**.

---

## F1 — `@workspace/ui` is not a single front door  ·  Severity: High  ·  Verified

**Problem.** The same kind of primitive — a plain shared component — is reachable at three different
import depths, with no principle distinguishing them:

| Depth | Examples (from SHARED-PRIMITIVES.md) |
|-------|--------------------------------------|
| root `@workspace/ui` | `ConfirmDialog`, `EmptyState`, `ErrorState`, `LoadingState`, `TooltipButton`, `UserAvatar` |
| `@workspace/ui/components/layout` (layout barrel, **not** re-exported by root) | `LightEditor`, `AttachmentChip`, `ReferenceAttachmentChip`, `SimpleAttachmentChip` |
| `@workspace/ui/components/layout/<x>` (subpath only, via the `/*` wildcard) | `DeleteDialog`, `DangerZone`, `CopyInput`, `InfoBlock`, `LinkedText`, `AlphabeticalList`, `CollapsibleUserList`, `ContextMenuAnchor`, `OwnerInfoPopover`, `UserName`, `UserDetailHero`, `properties-panel/*` |

Hooks have the same problem: the **most broadly reusable** ones (`useListSelection`, `useListDrag`,
`useListDropTarget`, `useKeyboardListNavigation`, `useScrollToIndex`, `useSuggestions`) are at
`@workspace/ui/hooks/*`, while `useUpload`/`useLayout`/`useSidebar` are at root and
`useContextMenu`/`usePreview` at yet other subpaths.

**Smoking gun.** `ConfirmDialog` exports from root `@workspace/ui`, but `DeleteDialog` — its sibling, and
a component **explicitly name-checked in AGENTS.md and CODE-STANDARDS.md as a key shared component** —
only exports from `@workspace/ui/components/layout/delete`. A developer following the docs would write
`import { DeleteDialog } from '@workspace/ui'` and it would fail.

**Evidence.**
- `packages/ui/package.json:45-84` — the `exports` map: `.` → `src/index.ts`, plus `./components/layout`,
  a `./components/layout/*` wildcard, ~16 explicit concern subpaths, and `./hooks/*`.
- `docs/SHARED-PRIMITIVES.md` "Components", "Hooks", "Providers & context" sections — the "Import from"
  column shows the three depths above.
- Several subpath-only components are flat files in `layout/` (`copy-input.tsx`, `info-block.tsx`,
  `linked-text.tsx`, `user-name.tsx`, …) resolved only by the `./components/layout/*` wildcard — they are
  in **no barrel at all**, exactly the invisibility AGENTS.md warns about.

**Recommendation (proposal — challenge this).**
Adopt **"root by default, subpath only by exception"**:

1. Every reusable component/hook/util is re-exported from the package root barrel (`@workspace/ui`).
2. A module stays subpath-only **only if it is on a short, documented allowlist**, justified by either:
   - **heavy peer dependency** — the TipTap `editor` module (`LightEditor`) pulls `@tiptap/*`
     (peerDependencies in `packages/ui/package.json:38-44`); keep it at
     `@workspace/ui/components/layout/editor`; or
   - **app-root provider** mounted once (`PreviewProvider`, `SSEProvider`, possibly `UploadProvider`).
3. The generic `/hooks/*` hooks bubble to root (most reusable, currently least discoverable).
4. **Enforce** via `bun run primitives --check`: fail CI when a primitive resolves to a non-root subpath
   and isn't on the allowlist. *(Implementer: locate the generator behind `bun run primitives` and confirm
   it can see each primitive's resolved import path — this proposal assumes it can.)*

**Why this over the alternatives.**
- *Pure (a) — everything at root:* simplest, but forces TipTap into every `@workspace/ui` consumer's
  module graph (real dev-server/HMR cost). Hence the editor exception.
- *Pure (b) — concern sub-barrels for everything:* reproduces today's failure mode — nobody reliably
  knows the boundary. More rules, same confusion.
- Root is already the de-facto default (~85 components there); this codifies reality.

**Counter-considerations for the reviewer.**
- `packages/ui/package.json:6` sets `"sideEffects": ["*.css"]`, so JS is side-effect-free and Vite
  *should* tree-shake unused re-exports. **Verify whether a fat root barrel actually hurts cold-start/HMR
  here** — if not, even the editor could go to root and the allowlist shrinks toward empty.
- `UploadProvider` is *already* at root while `PreviewProvider`/`SSEProvider` are not — evidence that
  "providers stay subpath" may be inertia, not a real rule. The allowlist might be **just** the TipTap
  editor.
- Concern sub-barrels (e.g. `properties-panel`) have a discoverability upside for "show me all X". Decide
  whether to keep a few as *additional* access paths even if everything also bubbles to root.

**Adjudicated.** Tree-shaking concern **overstated** — apps consume `@workspace/ui` as source and Vite
tree-shakes the side-effect-free re-exports, so a fat root barrel doesn't bloat bundles; only the TipTap
`editor` has a real (HMR-graph) reason to stay subpath. Endorse re-export-to-root + normalize providers to
root (to match `UploadProvider`); land the moves first and **defer the `--check` gate** to a follow-up.
Codemod-scale → own branch. (Verdict: CONFIRMED; allowlist ≈ editor only.)

---

## F2 — `EIGEN_DOC_TYPES` and `EIGEN_DOCUMENT_TYPES` are one list under two names  ·  Severity: High  ·  Verified

**Problem.** `packages/lib/src/types/drive.ts` defines two arrays that resolve to the **identical five
values in the same order** (`'doc','stickies','slides','sheets','chat'`):

- `EIGEN_DOC_TYPES` (`drive.ts:40`) — backs the `EigenDocType` union.
- `EIGEN_DOCUMENT_TYPES` (`drive.ts:188`) — comment: "exposed as an array for SQL IN … Same set as
  `isDocumentType`."

This is the "two lists of one fact drift" AGENTS.md explicitly warns about, and the `DOC` vs `DOCUMENT`
names give no signal that they're the same set.

**Evidence.** `packages/lib/src/types/drive.ts:40` and `:188-194`. The `EIGEN_DOC_TYPE_INFO` keys
(`:65`) and `DRIVE_EXTENSIONS` keys (`:127`) are the same five — `EIGEN_DOC_TYPES` is the canonical key
list.

**Recommendation.** Keep one literal. Either `export const EIGEN_DOCUMENT_TYPES = EIGEN_DOC_TYPES;` or
collapse callers onto a single export with a name that states intent. If a distinction is genuinely
intended, it must be expressed by *derivation*, not a second hand-maintained list.

**Reviewer check.** Confirm the two arrays are value-identical today, and that no caller relies on them
diverging.

---

## F3 — `EigenDocType` type re-exported through the UI value barrel  ·  Severity: Medium  ·  Verified

**Problem.** `packages/ui/src/components/layout/drive/eigendoc-config.ts:4` does
`export type { EigenDocType } from '@workspace/lib/types/drive'`. This re-exports a type through a value
barrel, against the project's no-type-reexports convention. It also surfaces `EigenDocType` as importable
from `@workspace/ui`, colliding in name with the canonical lib type (and the generator misfiles it under
"Utilities & constants" at `SHARED-PRIMITIVES.md` line ~743).

**Evidence.** `packages/ui/src/components/layout/drive/eigendoc-config.ts:1` (already imports the type for
local use) and `:4` (the re-export).

**Recommendation.** Delete the re-export. Consumers import `EigenDocType` from
`@workspace/lib/types/drive` directly.

**Reviewer check.** Grep for `EigenDocType` imported from `@workspace/ui` (or from the eigendoc-config
module) and confirm those call sites can point at `@workspace/lib/types/drive` instead.

**Adjudicated.** The re-export is *dead* — nothing in the repo imports `EigenDocType` from `@workspace/ui`
or the eigendoc-config module, so the name-collision rationale is theoretical. Deleting line 4 is a safe,
zero-call-site change (the file still needs the line-1 import for `EigenDocAppConfig.createType`) and also
clears the F8 misfiling. (Verdict: CONFIRMED — safe quick win.)

---

## F4 — Drive type naming flips word order; near-twin filenames  ·  Severity: Medium  ·  Verified

**Problem A — word order.** In `packages/lib/src/types/drive.ts`:
- single-literal types use `DriveType<Name>`: `DriveTypeDoc`, `DriveTypeChat`, … (`:22-28`)
- category unions use `Drive<Category>Type`: `DriveCollabType`, `DriveChatType`, `DriveContainerType`
  (`:155-157`)

So `DriveTypeChat` (the literal `'chat'`) and `DriveChatType` (a category alias that *equals* chat) differ
only by word order yet mean different things — actively confusing to read and grep.

**Problem B — twin filenames.** `packages/ui/.../drive/eigendoc-config.ts` (singular: `EigenDocAppConfig`,
`eigenDocValidateSearch`, the `EigenDocType` re-export) sits beside `eigendoc-configs.ts` (plural:
`DOCS_CONFIG`, `SHEETS_CONFIG`, `SLIDES_CONFIG`, `STICKIES_CONFIG`). One-character difference; easy to
import the wrong file.

**Recommendation.** Pick one convention for the type names — keep `DriveType<Name>` for literals and
rename the unions to read unambiguously as categories (e.g. `DriveCollabKind` / `DriveContainerKind`, or at
minimum a consistent word order). Merge or clearly rename the two `eigendoc-config(s).ts` files.

**Reviewer check.** Confirm the union types and literal types are genuinely different concepts (not
redundant), then judge whether the rename improves clarity or just churns. Also: `loginpage.tsx`
(`pages/loginpage.tsx`) breaks the kebab-case file convention used everywhere else (`login-route.tsx`,
`loading-screen.tsx`) — minor, fold in if touching that area.

**Adjudicated.** Unions confirmed genuinely distinct, so Problem-A (the `Drive*Type` union rename) is
*clarity-only churn* → **NEEDS DECISION**. Problem B mischaracterised: the files are **not** accidental
twins — `eigendoc-configs.ts` imports `EigenDocAppConfig` from `eigendoc-config.ts` (deliberate
type/instances split); a merge still removes the footgun. The merge + `loginpage.tsx`→`login-page.tsx` are
safe; while touching `eigendoc-config.ts`, also tighten `EigenDocAppConfig.driveType` (`:9`) from `string`
to `DrivePathType`. (Verdict: PARTIAL.)

---

## F5 — Shared types defined in hook/util files, surfaced via value barrels  ·  Severity: Medium  ·  Verified (drive-access)

**Problem.** Several reusable types are declared inside hook/util modules and exported through a *value*
domain barrel rather than from `@workspace/lib/types/<domain>`, against AGENTS.md ("reusable types through
`@workspace/lib/types/<domain>`") and the no-type-reexports convention.

**Clearest case — drive access (verified):** `DirectAccessItem`, `InheritedAccessItem`, `DriveAccessItem`
are defined in `packages/lib/src/core/drive/hooks/use-drive-access.ts:9,16,23` and reach consumers via
`@workspace/lib/drive`. They are full domain types and belong in `packages/lib/src/types/drive.ts`.

**Same smell (verify from index):**
- `AuthContextType`, `AuthUser` — `core/auth/auth-context.tsx` via `@workspace/lib/auth`
- `LocalCommand` — `core/chat/commands.ts` via `@workspace/lib/chat`
- `ViewMode` — `core/calendar/calendar-utils.ts` via `@workspace/lib/calendar`
- `EigenColor`, `EigenFont`, `TextPreviewMode` — `constants/*` via `@workspace/lib/constants`
- `FigureLayout` — `docs/eigendoc/nodes/figure.ts` via `@workspace/lib/docs/eigendoc`

**Recommendation.** Move the type *definitions* to the matching `types/<domain>.ts` and import them from
there. (Note: `types/auth.ts` may not exist yet — creating it is in scope.)

**Reviewer check / open question.** Some of these are tightly coupled to a single module
(`DriveAccessItem` mirrors the hook's return shape). Decide per-type whether relocation genuinely helps or
is dogmatic. Distinguish *types* (should move) from *values* re-exported through barrels (allowed — see
Verified non-issues).

**Adjudicated.** CONFIRMED — all listed types verified as domain types in non-`types/` files; `types/auth.ts`
does not exist yet (create it). **Guardrail — do NOT widen to UI component Props / local-context types**
(`*Props`, `LayoutContextType`, `StorageData`, `SlashTargetContext`): the UI package has no `types/<domain>`
layer and those are a component's own surface, not relocatable domain types. Codemod-scale → own branch.
(Verdict: CONFIRMED, scoped.)

---

## F6 — Exported names shadow libraries/globals  ·  Severity: Medium-Low  ·  Mixed

**Problem.** Names that collide with platform globals or dependencies hurt grep-ability and invite import
mistakes (CODE-STANDARDS.md § Code Style).

- `EditorContent` (`types/drive.ts:354`, **verified**) shadows TipTap's `EditorContent` component — and
  the docs app uses TipTap. Suggest `FileEditorContent`.
- `Headers` (`types/mail.ts`, from index) shadows the global `fetch` `Headers`. Suggest `MailHeaders`.
- `Command` (`types/command-palette.ts`, from index) shadows `cmdk`'s `Command` (a UI dependency used by
  the command palette). Suggest `PaletteCommand`.
- `Bar` / `Bra` / `Ket` (`components/layout/braket/*`, from index) — the bra-ket pun is intentional
  branding, but `Bar` especially is un-grep-able and collides conceptually with toolbars/progress bars.
  At minimum rename the generic `Bar`.

**Recommendation.** Rename the three library/global collisions. Treat `Bra`/`Ket` as branding (leave or
rename per team taste); rename `Bar`.

**Reviewer check.** Confirm each collision is real *in this codebase's import surface* (is the shadowed
symbol actually imported nearby?). Branding names are a judgement call — flag, don't mandate.

**Adjudicated.** Only `EditorContent`→`FileEditorContent` is a *realized* collision (TipTap's
`EditorContent` is imported in the docs/drive editor files alongside the lib type) — do it. `Command`→
`PaletteCommand` is latent (no single file imports both; `cmdk`'s is already aliased as `CommandPrimitive`)
— optional. **`Headers` has zero importers anywhere in the repo** — purely cosmetic, drop/de-prioritize.
`Bar`/`Bra`/`Ket` = **leave** (branding): reading `braket/bar.tsx` shows `Bar` is the `|` glyph in Dirac
`⟨bra|ket⟩`, not a generic. (The index's `Bra`/`braket/bra.tsx` entry is **stale** — the file no longer
exists; a `bun run primitives` regen drops it.) (Verdict: PARTIAL.)

---

## F7 — Confusing near-duplicate pairs  ·  Severity: Low-Medium  ·  Needs-look

Each of these needs a source read before deciding; listed as questions, not conclusions.

- **`useEmail` vs `useEmailById`** (both `core/mail/hooks/use-emails.ts`). If `useEmail` already takes an
  id, one is redundant — or they differ meaningfully and the names should say how. **Read the file.**
- **`AppLogo` vs `EigenLogo`** (`app/app-logo.tsx` vs `braket/eigen-logo.tsx`). Two logo components; names
  don't convey the distinction.
- **`LoadingScreen` vs `LoadingState` vs `EigenLoader`** (`pages/` vs `app/` vs `braket/`). Three
  loading-ish primitives; clarify roles or consolidate.
- **Comments split across two domains.** `useComments`, `useResolveComment` and the `CommentEntry` type
  live under `@workspace/lib/chat` (+ `types/chat.ts`), while a whole `@workspace/lib/comments` domain
  exists (`useCommentCards`, `CommentCard`, `ActiveComments`, `types/comments.ts`). Given the recent
  comments-unification work, decide whether the chat-side comment hooks/types should move into `comments`.
  **Check the comments-unification history before moving anything — this split may be a known, accepted
  state.**

**Adjudicated.** All four are real-but-distinct, not dups. **Comments split = DO NOT MOVE** — deliberate,
documented design (`COMMENTS.md` + unification commit `ad055d42`): `CommentEntry` is the server projection,
`CommentCard` the Y.Doc card. `useEmail` (reactive query) vs `useEmailById` (imperative `fetchQuery`) are
distinct; `AppLogo` (wordmark) vs `EigenLogo` (glyph) and the three loaders are distinct roles. Cosmetic
renames / a clarifying doc-note at most. (Verdict: CONFIRMED as questions — no relocation.)

---

## F8 — The generated index miscategorises primitives  ·  Severity: Low (doc quality)  ·  Verified

**Problem.** `SHARED-PRIMITIVES.md` "Components (103)" mixes real React components with: an error class
(`AppError`), a React context (`CommandPaletteContext`), TipTap node/mark schemas (`CommentMarkSchema`,
`FigureNode`, `SmallMark`), and a type/enum (`SSEventType`). Separately, `EigenDocType` (a type) is filed
under "Utilities & constants". This makes the index less trustworthy as a lookup.

**Recommendation.** Improve the `bun run primitives` generator's classification (e.g. a "Contexts /
schemas / classes" bucket, and don't list `export type`-only names under Components/Utilities). This is a
generator change, not a code-surface change — lowest priority, but cheap.

**Reviewer check.** Locate the generator script and confirm the misclassification is fixable there rather
than being an inherent ambiguity.

**Adjudicated.** Confirmed — `scripts/generate-shared-primitives.ts` `classify()` is name + `SymbolFlags`
only, so classes (`AppError`), context consts (`CommandPaletteContext`, and **`EigenDocDriveContext`** at
index line 62 — add it to the list), enum-like consts (`SSEventType`) and `Mark.create`/`Node.create`
schemas all fall into "Component". Fixable in the generator (detect `createContext`/`Mark.create`/
`Node.create`; exclude `export type`-only names). Generator-only, lowest priority. (Verdict: CONFIRMED.)

---

## Verified non-issues (checked — do not re-flag)

- **`DEFAULT_MOUNT_ID` appears twice in the index** (`@workspace/lib/types` and `@workspace/lib/drive`).
  This is a legitimate **value** re-export: defined once in `packages/lib/src/types/mount.ts:1`, imported
  and re-exported by `packages/lib/src/core/drive/hooks/use-drive.ts:14,21` as a convenience. Single
  source of truth holds; the no-type-reexports rule is about *types*, not values. Optional cleanup only
  (pick a canonical import path); not a defect.

---

## Open questions — resolved by the review

These were the reviewer's brief; all are now answered (see *Review outcome* above). Kept for traceability.

1. **F1 barrel rule** — `sideEffects: ["*.css"]` *does* give clean tree-shaking (apps bundle `@workspace/ui`
   from source), so a fat root barrel doesn't bloat bundles. → Allowlist ≈ the TipTap `editor` only;
   normalize providers to root.
2. **F5 scope** — relocate the clear domain types only; **exclude** UI component Props / local-context
   types (the UI package has no `types/<domain>` layer).
3. **F4 naming** — the `Drive*Type` union rename is clarity-only churn → **still your call** (NEEDS DECISION).
4. **Sequencing** — confirmed: land F2 + F3 + F8 + F4-B first (safe, isolated); F1 and F5 are codemod-scale,
   one branch each.
5. **Did the audit miss anything?** — no other duplicate-fact registries or realized library shadows in the
   720-primitive surface. The only additions: the F5 guardrail, the `EigenDocDriveContext` F8 mis-bucket,
   and the minor `EigenDocAppConfig.driveType: string`.
