# Proposal: Layout Simplification & Design Consistency

## TLDR

The codebase has ~45 raw color references and ~13 `bg-white` instances that block dark mode and create visual
inconsistency. The research document correctly identifies these and proposes reasonable fixes. This proposal trims
the scope to what actually matters, rejects several over-engineered ideas, and addresses blind spots around
third-party component styling that the research ignores.

---

## Critical Evaluation of the Research

The research document (RESEARCH_LAYOUT_SIMPLIFICATION.md) is well-researched and its claims are verified against
the codebase. Where it falls short:

### Correct and Actionable

- **Raw color audit**: 19 `text-gray-*`, 7 `bg-gray-*`, 13 `bg-white` instances confirmed. File-level attribution
  is accurate.
- **Dialog width zoo**: 8 distinct width values across 16 dialogs confirmed. The `size` prop approach is sound.
- **Sidebar header duplication**: 11 identical blocks confirmed verbatim.
- **`hsl(var(--primary))` bug**: Confirmed. `--primary` is oklch; wrapping it in `hsl()` produces wrong colors.
- **Stickies inline delete dialogs**: Confirmed. Both `card-settings-dialog.tsx` and `column-settings-dialog.tsx`
  rebuild what `DeleteDialog` already provides.
- **Duplicate `useMediaQuery`**: Confirmed in `apps/space/src/hooks/use-media-query.ts`.
- **`eigen-list-item` uses `bg-white`**: Confirmed at line 218 of `globals.css`.
- **`eigen-list-item-selected` uses raw `hsl()`**: Confirmed at line 230 of `globals.css`.
- **Empty component unused**: Confirmed -- zero imports from any app.

### Over-Scoped or Misguided

1. **CSS utility classes (`eigen-center`, `eigen-toolbar`, `eigen-sidebar-header`, etc.)**: The research proposes
   5 new CSS utility classes. For `eigen-sidebar-header`, a React component (`SidebarHeader`) is the right
   abstraction because the pattern includes behavior (close handler, app logo rendering), not just layout. For
   `eigen-center`, a `LoadingCenter` component is better because it couples the centering intent with the loader.
   For `eigen-toolbar` and `eigen-icon-row`, the abstraction is premature -- there are only 3 toolbar variants with
   genuinely different requirements (the stickies toolbar has `justify-between` and `bg-white`, the Column toolbar
   has `border-r`, the standalone Toolbar has neither). Forcing them into one class creates a different kind of
   inconsistency: exception classes on top of a utility class. **Keep toolbars as explicit Tailwind until a clear
   shared pattern emerges.**

2. **Design tokens for spacing and transitions**: The proposal to add `--spacing-toolbar`, `--spacing-sidebar`,
   `--transition-fast`, etc. to `@theme inline` creates indirection without payoff. Nobody is going to write
   `h-toolbar` instead of `h-12` -- the Tailwind class *is* the token. The only tokens that earn their keep are
   ones that change between themes (light/dark) or that are referenced in multiple systems (CSS + JS). Spacing
   values do neither. **Reject spacing and transition tokens. Keep dialog width tokens only.**

3. **ESLint rules for raw colors**: The research proposes `no-restricted-syntax` rules. In practice, these rules
   only catch literal strings in `className` attributes. They miss `cn()` calls, template literals, and variables.
   They produce false positives for intentional uses (document canvas `bg-white`, slide handles). And they add
   friction for every developer on every PR. **Replace with a one-time grep-and-fix pass, then rely on PR review
   and the `SidebarHeader`/`DialogContent` APIs to prevent regression.**

4. **`DialogFormFooter` component**: The proposed API conflates form submission semantics (submit button type, form
   `isSubmitting` state) with dialog chrome. The stickies dialogs use `form.onSubmit` wired to the form element;
   the calendar dialogs use `react-hook-form`. A `DialogFormFooter` that owns the Submit button cannot work with
   both patterns without awkward workarounds. **Instead, standardize the footer *layout* via documentation and the
   existing `DialogFooter`, and make the delete-button-left pattern a documented convention. The real win is
   replacing inline delete dialogs with `DeleteDialog`, not abstracting 3 buttons into a component.**

5. **Component playground**: Out of scope for a layout simplification effort. Useful, but unrelated.

6. **Container queries**: Interesting future direction, but the research provides no evidence of bugs or UX
   problems caused by the current viewport-based approach. **Defer entirely.**

### Blind Spots

1. **Third-party component styling (fortune-sheet, Tiptap)**: The research barely mentions these. Fortune-sheet
   has ~1700 lines of CSS with 50+ hardcoded `#fff`, `#ccc`, `#333`, `#e0e0e0`, `#efefef` references. The Tiptap
   editor CSS (`apps/docs/css/globals.css`) has 400 lines with hardcoded hex colors (`#d1d5db`, `#6b7280`,
   `#f3f4f6`, `#2563eb`, etc.). The sheets app overrides fortune-sheet toolbar with `background: white !important`
   and `border-bottom: 1px solid hsl(var(--border)) !important` -- the latter is the hsl/oklch bug again.
   **Dark mode cannot ship without addressing these third-party styles.** The fortune-sheet component is a fork
   that the project controls, so its CSS can be modified. Tiptap styles are in the project's own globals.css, so
   they can also be updated. But this work is at least as large as fixing the app-level raw colors and should be
   Phase 2, not Phase 1.

2. **The `bg-app` / `text-app` per-app CSS pattern**: Every app has its own `css/globals.css` that maps
   `.bg-app`/`.text-app` to the app's color variable. This is clean and works, but the research does not discuss
   dark mode for these app accent colors. `var(--color-red-600)` on a dark background has poor contrast. Either
   every app needs a dark-mode variant or the app-color system needs to be rethought. This is a design decision,
   not a code decision.

3. **The `eigen-list-item-unread` class**: Uses `bg-red-600/5` and `border-l-red-600` -- more hardcoded colors
   that will need semantic equivalents for dark mode.

4. **Specificity risk of `@layer base` classes**: The `eigen-list-item` classes are in `@layer base`, which is
   the lowest-specificity layer. This works now because Tailwind utility classes in `@layer utilities` naturally
   override them. But adding more `eigen-*` classes to `@layer base` means they can be overridden by any utility,
   which may cause confusion when someone adds a conflicting Tailwind class alongside an `eigen-*` class.
   This is acceptable for the existing patterns but should not be extended to many more classes.

---

## The Actual Problems to Fix (Prioritized)

### P0 -- Bugs

1. **`hsl(var(--primary))` in `.drag-badge`** -- renders wrong color. Fix: `var(--color-primary)`.
2. **`hsl(var(--border))` in `apps/sheets/css/globals.css`** -- renders wrong color. Fix: `var(--color-border)`.

### P1 -- Dark Mode Blockers (App Code)

3. **19 `text-gray-*` instances** across 12 files -- replace with `text-foreground` or `text-muted-foreground`.
4. **13 `bg-white` instances** across 11 files (minus intentional canvas uses in docs/slides) -- replace with
   `bg-background`.
5. **7 `bg-gray-*` instances** across 5 files -- replace with `bg-muted` or `bg-muted/50`.
6. **`eigen-list-item` uses `bg-white`** -- change to `bg-background`.
7. **`eigen-list-item-selected` uses raw `hsl(210 100% 93%)`** -- needs a semantic token or oklch value.

### P2 -- Dark Mode Blockers (Third-Party / Content CSS)

8. **Tiptap editor CSS** (`apps/docs/css/globals.css`) -- 400 lines of hardcoded hex colors for document chrome
   (borders, code blocks, selections). Document *content* colors (e.g., syntax highlighting) can stay hardcoded
   since the editor page background is intentionally white.
9. **Fortune-sheet CSS** (`packages/fortune-sheet/src/components/*/index.css`) -- 50+ hardcoded color references.
   This is the largest dark mode remediation task.
10. **Sheets app overrides** (`apps/sheets/css/globals.css`) -- `background: white !important` on toolbar/fx-editor.

### P3 -- Consistency / Deduplication

11. **Dialog width inconsistency** -- add `size` prop to `DialogContent`.
12. **11 duplicated sidebar headers** -- extract `SidebarHeader` component.
13. **Stickies inline delete dialogs** (2 instances) -- replace with shared `DeleteDialog`.
14. **Duplicate `useMediaQuery` hook** in space app -- delete and import from `@workspace/lib`.
15. **Icon ordering inconsistency** -- normalize `w-4 h-4` to `h-4 w-4`.

### P4 -- Cleanup

16. **Test safelist hack removal** -- the 12 self-referencing classes may be unnecessary with `@source`.
17. **Unused `Empty` component** -- either adopt it in apps or remove it. Do not leave dead code.

---

## Design Token Specification

### Additions to `globals.css`

Only add tokens that serve a concrete purpose (referenced in component code or vary between themes).

```css
/* In :root block, alongside existing tokens: */
:root {
    /* Selected list item -- currently raw hsl, needs semantic name for dark mode */
    --selected: oklch(0.932 0.032 255);       /* light: soft blue highlight */
    --selected-hover: oklch(0.9 0.04 255);    /* light: slightly darker on hover */
}

.dark {
    --selected: oklch(0.35 0.06 255);         /* dark: muted blue highlight */
    --selected-hover: oklch(0.4 0.07 255);    /* dark: slightly lighter on hover */
}
```

```css
/* In @theme inline block: */
--color-selected: var(--selected);
--color-selected-hover: var(--selected-hover);

/* Dialog width tokens (concrete, referenced by DialogContent component) */
--width-dialog-xs: 22.5rem;   /* 360px */
--width-dialog-sm: 26.5rem;   /* 424px */
--width-dialog-md: 31.25rem;  /* 500px */
--width-dialog-lg: 43.75rem;  /* 700px */
```

**Rejected tokens**: `--spacing-toolbar`, `--spacing-sidebar`, `--spacing-field`, `--spacing-inline`,
`--transition-fast`, `--transition-normal`, `--transition-slow`. Tailwind classes already serve as the token
layer for spacing and the few transitions in the codebase are fine as inline values.

---

## Components to Create/Modify

### New: `SidebarHeader`

Location: `packages/ui/src/components/layout/sidebar/sidebar-header.tsx`

```tsx
import {X} from 'lucide-react';
import {Button} from '../../button';
import {AppLogo} from '../app/app-logo';

type SidebarHeaderProps = {
    appName: string;
    onClose: () => void;
}

export function SidebarHeader({appName, onClose}: SidebarHeaderProps) {
    return (
        <div className="flex items-center h-12 bg-app px-4">
            <Button variant="ghost" size="icon" onClick={onClose}
                    className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                <X className="h-5 w-5"/>
                <span className="sr-only">Close menu</span>
            </Button>
            <AppLogo appName={appName}/>
        </div>
    );
}
```

Replaces: 11 identical blocks across all sidebar files.

### New: `LoadingCenter`

Location: `packages/ui/src/components/layout/loading-center.tsx`

```tsx
import {EigenLoader} from './braket/eigen-loader';

export function LoadingCenter() {
    return (
        <div className="flex items-center justify-center h-full w-full">
            <EigenLoader/>
        </div>
    );
}
```

Replaces: 5+ inconsistent loading wrapper patterns.

### Modify: `DialogContent` -- add `size` prop

Location: `packages/ui/src/components/dialog.tsx`

```tsx
type DialogSize = 'xs' | 'sm' | 'md' | 'lg';

const dialogSizeMap: Record<DialogSize, string> = {
    xs: 'sm:max-w-[22.5rem]',
    sm: 'sm:max-w-[26.5rem]',
    md: 'sm:max-w-[31.25rem]',
    lg: 'sm:max-w-[43.75rem]',
};

function DialogContent({
    className,
    children,
    showCloseButton = true,
    size,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
    size?: DialogSize;
}) {
    return (
        <DialogPortal data-slot="dialog-portal">
            <DialogOverlay/>
            <DialogPrimitive.Content
                data-slot="dialog-content"
                className={cn(
                    "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
                    size ? dialogSizeMap[size] : "sm:max-w-lg",
                    className
                )}
                {...props}
            >
                {children}
                {showCloseButton && (
                    /* ... existing close button ... */
                )}
            </DialogPrimitive.Content>
        </DialogPortal>
    );
}
```

The `className` escape hatch is intentionally preserved after the size class so consumers can still override if
needed -- but the `size` prop is the primary API.

Dialog migration mapping:

| Current Width                        | `size` | Dialogs                                                                 |
|--------------------------------------|--------|-------------------------------------------------------------------------|
| `sm:max-w-[360px]`                   | `xs`   | `RecurringActionDialog`                                                 |
| `sm:max-w-[400px]`, `[425px]`, `md`  | `sm`   | `LabelDialog`, `SharedCalendarConfigDialog`, `AddCard/ColumnDialog`, `CardSettingsDialog`, `ColumnSettingsDialog`, `CommentDialog`, `EditorToolbar` (find) |
| `sm:max-w-[450px]`, `[500px]`        | `md`   | `EventDetailDialog`, `Create/EditEventDialog`, `CalendarConfigDialog`, `CardDialog` |
| `sm:max-w-[700px]`                   | `lg`   | `DriveAccessDialog`                                                     |
| default (no override)                | omit   | `DeleteDialog`                                                          |

### Modify: `globals.css` -- fix list item classes

```css
.eigen-list-item {
    @apply bg-background cursor-pointer select-none;
}

.eigen-list-item.eigen-list-item-selected {
    background-color: var(--color-selected);
}

.eigen-list-item.eigen-list-item-selected:hover {
    background-color: var(--color-selected-hover);
}

.eigen-list-item-selected.eigen-list-item-active {
    background-color: var(--color-selected-hover);
}
```

### Modify: `globals.css` -- fix drag-badge

```css
.drag-badge {
    /* ... existing positioning ... */
    background: var(--color-primary);
    /* ... rest ... */
}
```

### Not Creating

- **`DialogFormFooter`**: The footer pattern varies legitimately between dialogs (some have delete, some don't;
  some use `react-hook-form`, some use raw `onSubmit`). Abstracting 3 buttons into a component saves ~10 lines per
  dialog but creates a rigid API that will accumulate props. Document the convention instead.
- **`IconRow`**: Only used in calendar's event-detail-dialog. Not cross-app enough to justify a shared component.
- **CSS utility classes (`eigen-toolbar`, `eigen-icon-muted`, `eigen-icon-row`)**: The patterns they capture are
  not identical enough. Toolbars have different justify/background/border combinations. Icon rows have different
  gaps and alignment.
- **`TooltipButton` CVA variants**: The current `className` default of `"h-8 w-8"` works and is overridable. A
  CVA variant for two sizes is over-engineering.

---

## Dialog Standardization

### Width

Use the `size` prop. No raw `sm:max-w-[Npx]` on `DialogContent`.

### Footer Convention (documented, not componentized)

Standard dialog footers follow this layout inside `DialogFooter`:

```
[Delete (destructive, mr-auto)] [Cancel (outline)] [Submit (default)]
```

- **Delete** button: left-aligned via `className="mr-auto"`. Only present when the dialog is editing an existing
  item that can be deleted. Opens `DeleteDialog` -- never an inline confirmation.
- **Cancel** button: `variant="outline"`. Calls `onClose` or `onOpenChange(false)`.
- **Submit** button: `type="submit"` or primary action. Shows loading text when `isLoading`.
- **Button order**: destructive left, cancel center-right, submit right. This matches the existing calendar
  pattern which is the most polished.

### Delete Confirmations

All delete actions use the shared `DeleteDialog` from
`packages/ui/src/components/layout/delete/delete-dialog.tsx`. The two stickies dialogs that inline their own
delete confirmation should be migrated.

---

## Tailwind Class Reduction Strategy

### Do

1. **Replace raw colors with semantic tokens**: Mechanical find-and-replace. This is the highest-impact change.
   The mapping is straightforward:

   | Raw Class        | Semantic Replacement   | Notes                                       |
   |------------------|------------------------|---------------------------------------------|
   | `text-gray-900`  | `text-foreground`      |                                              |
   | `text-gray-700`  | `text-foreground`      |                                              |
   | `text-gray-600`  | `text-muted-foreground`|                                              |
   | `text-gray-500`  | `text-muted-foreground`|                                              |
   | `text-gray-400`  | `text-muted-foreground`|                                              |
   | `bg-white`       | `bg-background`        | Except docs editor page and slide handles   |
   | `bg-gray-50`     | `bg-muted/50`          |                                              |
   | `bg-gray-100`    | `bg-muted`             |                                              |
   | `bg-gray-200`    | `bg-muted`             |                                              |
   | `divide-gray-100`| `divide-border`        |                                              |
   | `border-gray-300`| `border-border`        | Often redundant -- `*` rule already applies |

2. **Normalize icon class ordering**: Change `w-4 h-4` to `h-4 w-4` in the ~41 instances (stickies/sheets/slides
   toolbars and contacts list). Pure consistency, zero visual change.

3. **Replace `className="sm:max-w-[Npx]"` on dialogs** with the `size` prop once it exists.

4. **Comment intentional raw colors**: Where `bg-white` is genuinely correct (document canvas, slide object
   handles), add `{/* intentional: document/canvas background */}` so future audits skip them.

### Do Not

1. **Do not extract CSS utility classes for patterns with fewer than 5 identical instances**. The sidebar header
   (11 instances) earns a React component. The toolbar pattern (3 instances, all different) does not earn a CSS
   class.

2. **Do not ban all raw Tailwind colors via ESLint**. Some contexts legitimately need specific colors (branded
   app colors, chart accent colors, syntax highlighting). A blanket rule creates friction and exception-management
   overhead that outweighs the benefit.

3. **Do not replace `mr-2` with `gap-2` globally**. The 128 instances of `mr-2` are in varied contexts. Some are
   between an icon and a label inside a flex parent (where `gap-2` on the parent is better). Others are between
   sibling elements where margin is correct. Each case needs individual judgment.

---

## Enforcement Approach

### What Will Actually Work

1. **API design over lint rules**: The `DialogContent` `size` prop makes the right choice the default. Developers
   will use `size="md"` because it shows up in autocomplete. Arbitrary widths require the less-discoverable
   `className` override. Same principle applies to `SidebarHeader` -- using it is easier than copying the 6-line
   block.

2. **PR review convention**: Add a single line to the PR review habits: "Check that new UI code uses semantic
   color tokens (`text-foreground`, `bg-background`, `bg-muted`, etc.) instead of raw Tailwind grays." This is
   easy to check visually in a diff.

3. **One-time codemod + grep verification**: After the migration, run a grep for `text-gray-`, `bg-gray-`,
   `bg-white` in `apps/` to confirm zero results (minus documented exceptions). This can be a CI check if desired
   -- a simple shell script is more maintainable than ESLint AST rules.

### What Will Not Work

- ESLint `no-restricted-syntax` for className values: too many false negatives (cn, template literals) and false
  positives (intentional uses).
- Mandating `h-` before `w-` via linting: the effort to write and maintain the rule exceeds the cost of the
  inconsistency.
- Banning the `className` prop on `DialogContent`: it is a necessary escape hatch.

---

## Concrete File Changes

### Phase 1

| File | Change |
|------|--------|
| `packages/ui/src/styles/globals.css` | Fix `.eigen-list-item` (`bg-white` -> `bg-background`), fix `.eigen-list-item-selected` (hsl -> `var(--color-selected)`), fix `.drag-badge` (`hsl(var(--primary))` -> `var(--color-primary)`), add `--selected`/`--selected-hover` tokens to `:root` and `.dark`, add `--color-selected`/`--color-selected-hover` and `--width-dialog-*` to `@theme inline` |
| `apps/sheets/css/globals.css` | Fix `hsl(var(--border))` -> `var(--color-border)` in 2 places, fix `background: white` -> `background: var(--color-background)` in 2 places |
| `apps/mail/src/components/mail/email-list.tsx` | Replace 6x `text-gray-*` with semantic tokens, replace 2x `bg-white` with `bg-background`, replace `divide-gray-100` with `divide-border` |
| `apps/mail/src/components/mail/email-detail.tsx` | Replace `text-gray-500` -> `text-muted-foreground`, replace `bg-white` -> `bg-background` |
| `apps/stickies/src/components/stickies/column.tsx` | Replace `text-gray-600` -> `text-muted-foreground`, `hover:bg-gray-100` -> `hover:bg-muted` |
| `apps/stickies/src/components/stickies/card-settings-dialog.tsx` | Replace `text-gray-500` -> `text-muted-foreground`, replace inline delete dialog with `DeleteDialog` |
| `apps/stickies/src/components/stickies/column-settings-dialog.tsx` | Replace `text-gray-500` -> `text-muted-foreground`, replace inline delete dialog with `DeleteDialog` |
| `apps/stickies/src/components/stickies/card-dialog.tsx` | Replace `text-gray-700` -> `text-foreground` |
| `apps/stickies/src/components/stickies/toolbar.tsx` | Replace `bg-white` -> `bg-background`, normalize `w-4 h-4` -> `h-4 w-4` |
| `apps/space/src/routes/_auth.index.tsx` | Replace 2x `text-gray-500` -> `text-muted-foreground`, `bg-white` -> `bg-background` |
| `apps/index/src/routes/blog.index.tsx` | Replace `text-gray-500`, `text-gray-700`, `bg-gray-50`, `border-gray-300` |
| `apps/index/src/components/BlogPost.tsx` | Replace `bg-gray-200` -> `bg-muted`, `border-gray-300` -> `border-border` |
| `apps/index/src/components/MediaGrid.tsx` | Replace `bg-gray-100` -> `bg-muted`, `text-gray-600` -> `text-muted-foreground` |
| `apps/index/src/components/MediaPreview.tsx` | Replace `bg-white` -> `bg-background` |
| `apps/drive/src/components/drive/file-preview.tsx` | Replace 2x `bg-white` -> `bg-background` |
| `apps/contacts/src/components/contacts/contacts-list.tsx` | Replace `bg-white` -> `bg-background` in inputClassName |
| `apps/people/src/components/people/members-list.tsx` | Replace `bg-white` -> `bg-background` in inputClassName |
| `apps/space/src/hooks/use-media-query.ts` | Delete file |
| Apps importing from `apps/space/src/hooks/use-media-query.ts` | Update import to `@workspace/lib/media` |

### Phase 2

| File | Change |
|------|--------|
| `packages/ui/src/components/dialog.tsx` | Add `size` prop to `DialogContent` with `xs`/`sm`/`md`/`lg` map |
| `packages/ui/src/components/layout/sidebar/sidebar-header.tsx` | New file: `SidebarHeader` component |
| `packages/ui/src/components/layout/loading-center.tsx` | New file: `LoadingCenter` component |
| 11 sidebar files | Replace sidebar header block with `<SidebarHeader>` |
| 11 dialog files | Replace `className="sm:max-w-[Npx]"` with `size` prop |
| 5+ loading state files | Replace wrapper div + EigenLoader with `<LoadingCenter>` |

### Phase 3

| File | Change |
|------|--------|
| `apps/docs/css/globals.css` | Audit Tiptap styles for dark-mode safety. Replace hex colors on chrome elements (borders, table headers, selections) with semantic tokens or CSS custom properties. Leave syntax highlighting and document-content colors as-is. |
| `packages/fortune-sheet/src/components/*/index.css` | Replace `#fff`, `#ccc`, `#333`, `#efefef`, `#e0e0e0` with CSS custom properties. This is a significant effort (~50 color references across 4 files) and should be scoped to a dedicated PR. |
| `apps/sheets/css/globals.css` | Replace `background: white !important` with `background: var(--color-background) !important` |
| `packages/ui/src/styles/globals.css` | Test removal of the 12 self-referencing safelist classes. Rebuild and verify app colors still render. If any break, refactor the dynamic class composition site to use CSS custom properties. |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Semantic token replacement changes visual appearance | Low | Low | `text-foreground` maps to the same near-black as `text-gray-900` in light mode. `text-muted-foreground` is close to `text-gray-500`. Visually identical or imperceptibly different. Verify by visual comparison. |
| `bg-background` on input fields changes appearance in some browsers | Low | Low | `bg-background` resolves to white in light mode, same as `bg-white`. Test in Chrome, Firefox, Safari. |
| Removing safelist hack breaks dynamic app colors | Medium | Medium | Test by removing the block, rebuilding, and checking every app's sidebar/topbar color. If broken, the fix is to stop using `text-${color}-600` template literals and use `style={{ color: var(--app-${id}-color) }}` instead. |
| Fortune-sheet CSS changes break spreadsheet UI | Medium | High | Fortune-sheet is complex forked third-party code. Changes should be made in a dedicated PR with thorough manual testing of all sheet interactions (context menus, filters, tab bar, overlays). |
| `SidebarHeader` component misses edge cases in specific sidebars | Low | Low | All 11 sidebar headers are genuinely identical. The only variation is the `appName` prop. |
| Dialog `size` prop doesn't cover a future dialog width need | Low | Low | `className` escape hatch is preserved. A fifth size can be added if needed. |

---

## Phases

### Phase 1: Fix Bugs and Replace Raw Colors (1-2 PRs)

**Scope**: P0 bugs + P1 raw color replacements + P3 duplicate hook deletion + P3 icon ordering.

**Effort**: ~80 lines changed across ~20 files. All mechanical replacements.

**Risk**: Near zero. No behavioral changes, no new abstractions. Can be verified with typecheck + visual spot-check.

**Verification**: `bun run typecheck && bun run test`. Then grep `apps/` for `text-gray-`, `bg-gray-`, `bg-white`
to confirm only documented exceptions remain.

### Phase 2: Component Extractions (2-3 PRs)

**Scope**: P3 items -- `DialogContent` size prop, `SidebarHeader`, `LoadingCenter`, stickies delete dialog
migration.

**Effort**: ~150 lines of new shared code, ~200 lines removed from apps.

**Risk**: Low. New components are opt-in. Old patterns still work. Each extraction is a self-contained PR.

**PR split**:
- PR 1: `DialogContent` size prop + migrate all 11 dialogs
- PR 2: `SidebarHeader` + migrate all 11 sidebars
- PR 3: `LoadingCenter` + migrate loading states + stickies `DeleteDialog` migration

### Phase 3: Third-Party Component Dark Mode (3-4 PRs)

**Scope**: P2 items -- Tiptap CSS, fortune-sheet CSS, sheets overrides.

**Effort**: Large. Fortune-sheet alone has ~50 color references across 4 CSS files.

**Risk**: Medium. Third-party component CSS is harder to reason about. Changes need thorough manual testing.

**Prerequisite**: Dark mode toggle mechanism must exist (even if hidden behind a flag) to verify the changes work.

### Phase 4: Cleanup (1 PR)

**Scope**: P4 items -- test safelist hack removal, decide on unused `Empty` component.

**Effort**: Small. Remove code, test, verify.

**Risk**: Low for safelist (easily reversible). Low for Empty (either adopt or delete).

---

## What This Proposal Deliberately Omits

- **Transition tokens**: Not enough transition usage to justify a token layer.
- **Spacing tokens**: Tailwind classes are the spacing tokens.
- **ESLint enforcement**: One-time fix + PR review is sufficient. Lint rules for CSS classes have poor
  signal-to-noise ratio.
- **Component playground**: Useful but orthogonal to this effort. Can be proposed separately.
- **Container queries**: No current UX problems that they solve. Can be adopted incrementally when specific
  components need them.
- **`DialogFormFooter`**: The variety of dialog footer patterns is legitimate. Documenting the convention is
  better than creating a rigid component API.
- **CSS utility classes beyond `eigen-list-item`**: Most proposed classes (`eigen-toolbar`, `eigen-icon-row`) do
  not capture a truly repeated identical pattern.
