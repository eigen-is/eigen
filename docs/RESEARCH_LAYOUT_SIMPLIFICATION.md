# Research: Layout Simplification & Design Consistency

> Simplifying Eigen's layout system, reducing Tailwind class bloat, enforcing visual consistency across all apps,
> and preparing the token system for dark mode.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Dark Mode Readiness](#dark-mode-readiness)
3. [Design Token Proposal](#design-token-proposal)
4. [Component Abstraction Strategy](#component-abstraction-strategy)
5. [Dialog & Modal Standardization](#dialog--modal-standardization)
6. [Tailwind Class Reduction Strategies](#tailwind-class-reduction-strategies)
7. [Animation & Transition Consistency](#animation--transition-consistency)
8. [Responsive Design](#responsive-design)
9. [Enforcement Mechanisms](#enforcement-mechanisms)
10. [Specific Components to Create or Modify](#specific-components-to-create-or-modify)
11. [Before/After Examples](#beforeafter-examples)
12. [Cross-Cutting Concerns](#cross-cutting-concerns)
13. [Component Playground](#component-playground)
14. [Migration Approach](#migration-approach)
15. [Implementation Phases](#implementation-phases)

---

## Current State Analysis

### What Works Well

- **AppShell / ColumnLayout / Column** provide a consistent structural skeleton across all apps
  (`packages/ui/src/components/layout/app/app-shell.tsx`,
  `packages/ui/src/components/layout/app/column-layout.tsx`).
- **shadcn/ui components** in `packages/ui/src/components/` give a shared primitive layer (Button with CVA variants,
  Dialog, Input, Select, Card, Empty, Field, etc.).
- **`cn()` helper** (`packages/ui/src/lib/utils.ts`) uses `clsx` + `tailwind-merge` for class deduplication.
- **App color CSS properties** (`--app-mail-color`, `--app-drive-color`, etc.) defined centrally in
  `packages/ui/src/styles/globals.css` with `bg-app`/`text-app` utility classes.
- **List CSS classes** (`eigen-list-item`, `eigen-list-item-active`) in `globals.css` demonstrate extracted patterns.
- **Button** and **EmptyMedia** already use CVA -- a pattern to extend to more components.
- **Dark mode tokens already exist.** The `.dark` block in `globals.css` defines oklch values for all semantic tokens
  (`--background`, `--foreground`, `--muted`, `--border`, etc.). The infrastructure is ready; the blocker is app code
  bypassing these tokens.
- The `@source` directive in `globals.css` already scans `apps/**/*.{ts,tsx}`, so Tailwind can discover dynamically
  composed classes. The safelist hack (see Problem 11) may already be partially redundant.

### Problem Areas

#### 1. Hardcoded Colors Instead of Semantic Tokens

Multiple apps use raw Tailwind color classes instead of the semantic tokens defined in `globals.css`.

**Verified examples (grepped from codebase):**

```
# Mail -- 6 instances of gray-* in email-list.tsx alone
apps/mail/src/components/mail/email-list.tsx:
  "text-sm font-medium text-gray-900"       -> text-foreground
  "text-xs text-gray-500"                    -> text-muted-foreground
  "text-sm truncate mt-0.5 text-gray-700"   -> text-foreground
  "divide-y divide-gray-100"                 -> divide-border
  "text-gray-400" (paperclip icon)           -> text-muted-foreground
  "text-gray-500" (empty state)              -> text-muted-foreground

apps/mail/src/components/mail/email-detail.tsx:
  "text-xs text-gray-500"                    -> text-muted-foreground

# Stickies -- mixes gray-* with semantic
apps/stickies/src/components/stickies/column.tsx:
  "text-sm text-gray-600 hover:bg-gray-100"  -> text-muted-foreground hover:bg-muted

apps/stickies/src/components/stickies/card-settings-dialog.tsx:
  "text-sm text-gray-500" (delete warning)   -> text-muted-foreground

apps/stickies/src/components/stickies/column-settings-dialog.tsx:
  "text-sm text-gray-500" (delete warning)   -> text-muted-foreground

apps/stickies/src/components/stickies/card-dialog.tsx:
  "text-sm text-gray-700"                     -> text-foreground

# Space
apps/space/src/routes/_auth.index.tsx:
  "text-xs text-gray-500"                    -> text-muted-foreground
  "text-sm text-gray-500"                    -> text-muted-foreground

# Index (landing page / blog)
apps/index/src/routes/blog.index.tsx:
  "text-sm text-gray-500", "text-gray-700"   -> text-muted-foreground, text-foreground
  "bg-gray-50"                               -> bg-muted/50
  "border-gray-300"                          -> border-border

apps/index/src/components/BlogPost.tsx:
  "bg-gray-200" (code blocks)               -> bg-muted
  "border-gray-300" (blockquote)             -> border-border

apps/index/src/components/MediaGrid.tsx:
  "bg-gray-100", "text-gray-600"            -> bg-muted, text-muted-foreground
```

Every raw `gray-*` class is a dark-mode breakage point. The semantic tokens (`text-foreground`,
`text-muted-foreground`, `bg-muted`, `border-border`) already have dark-mode values in the `.dark` block.

#### 2. `bg-white` Instead of `bg-background`

13 instances of `bg-white` found across app code (excluding docs/slides where white backgrounds may be intentional for
document canvases):

```
apps/mail/src/components/mail/email-list.tsx:     "bg-white"  (2 instances: search input, list container)
apps/mail/src/components/mail/email-detail.tsx:   "bg-white"  (detail container)
apps/stickies/src/components/stickies/toolbar.tsx: "bg-white" (toolbar)
apps/contacts/src/components/contacts/contacts-list.tsx: inputClassName="h-8 bg-white"
apps/people/src/components/people/members-list.tsx:      inputClassName="h-8 bg-white"
apps/space/src/routes/_auth.index.tsx:             "bg-white"  (footer)
apps/drive/src/components/drive/file-preview.tsx:  "bg-white"  (preview container, 2 instances)
apps/index/src/components/MediaPreview.tsx:         "bg-white"  (preview container)
packages/ui/src/styles/globals.css:                .eigen-list-item { @apply bg-white }
```

`bg-background` maps to white in light mode and to the dark surface color in dark mode.

#### 3. Dialog Width Inconsistency

Every dialog uses a different width value. Full audit from codebase grep:

| Dialog                       | Width                  | File |
|------------------------------|------------------------|------|
| `DeleteDialog`               | default (`sm:max-w-lg` = 32rem) | `packages/ui/src/components/layout/delete/delete-dialog.tsx` |
| `LabelDialog`                | `sm:max-w-[425px]`     | `packages/ui/src/components/layout/labels/label-dialog.tsx` |
| `CreateEventDialog`          | `sm:max-w-[500px]`     | `apps/calendar/src/components/create-event-dialog.tsx` |
| `EditEventDialog`            | `sm:max-w-[500px]`     | `apps/calendar/src/components/edit-event-dialog.tsx` |
| `EventDetailDialog`          | `sm:max-w-[450px]`     | `apps/calendar/src/components/event-detail-dialog.tsx` |
| `RecurringActionDialog`      | `sm:max-w-[360px]`     | `apps/calendar/src/components/recurring-action-dialog.tsx` |
| `CalendarConfigDialog`       | `sm:max-w-[500px]`     | `apps/calendar/src/components/calendar-config-dialog.tsx` |
| `SharedCalendarConfigDialog` | `sm:max-w-[400px]`     | `apps/calendar/src/components/shared-calendar-config-dialog.tsx` |
| `DriveAccessDialog`          | `sm:max-w-[700px]`     | `packages/ui/src/components/layout/drive/drive-access-dialog.tsx` |
| `CardSettingsDialog`         | `sm:max-w-md` (28rem)  | `apps/stickies/src/components/stickies/card-settings-dialog.tsx` |
| `ColumnSettingsDialog`       | `sm:max-w-md` (28rem)  | `apps/stickies/src/components/stickies/column-settings-dialog.tsx` |
| `CardDialog`                 | `sm:max-w-[500px]`     | `apps/stickies/src/components/stickies/card-dialog.tsx` |
| `AddCardDialog`              | `sm:max-w-[425px]`     | `apps/stickies/src/components/stickies/add-card-dialog.tsx` |
| `AddColumnDialog`            | `sm:max-w-[425px]`     | `apps/stickies/src/components/stickies/add-column-dialog.tsx` |
| `EditorToolbar` (find)       | `sm:max-w-md` (28rem)  | `apps/docs/src/components/docs/editor-toolbar.tsx` |
| `CommentDialog`              | `sm:max-w-md` / `sm:max-w-lg` | `apps/docs/src/components/docs/comment-dialog.tsx` |

That is 8 distinct width values (360px, 400px, 425px, 450px, 500px, 28rem, 32rem, 700px). A `size` prop with 4 named
sizes would cover all cases.

#### 4. Dialog Footer Pattern Inconsistency

Five conflicting footer patterns found:

- **Standard**: Cancel (outline) + Save (primary) -- `CreateEventDialog`, `EditEventDialog`
- **With delete**: Delete (destructive, `mr-auto`) + Cancel (outline, `mr-2`) + Save (primary) -- `LabelDialog`,
  `CalendarConfigDialog`
- **Stickies variant**: Delete (destructive) on left, then `div.flex.gap-2` wrapping Cancel + Save -- inconsistent
  with the calendar approach (`mr-auto` vs wrapper div) -- `CardSettingsDialog`, `ColumnSettingsDialog`
- **Detail view**: Action icons (ghost) on left + Close (outline) on right -- `EventDetailDialog`
- **Delete confirmation**: Cancel (outline) + Delete (destructive) -- `DeleteDialog`

#### 5. Inline Delete Confirmations Instead of Shared `DeleteDialog`

Both `CardSettingsDialog` and `ColumnSettingsDialog` in stickies build their own inline delete confirmation dialogs
with raw `text-gray-500` text, instead of using the shared `DeleteDialog` component from
`packages/ui/src/components/layout/delete/delete-dialog.tsx`. The `LabelDialog` and `CalendarConfigDialog` correctly
use the shared component.

#### 6. Inconsistent Toolbar Patterns

Three separate toolbar implementations:

**`Toolbar` component** (`packages/ui/src/components/layout/toolbar/toolbar.tsx`):
```tsx
<div className="flex items-center justify-between w-full gap-1 no-print h-12">
```
Missing: `px-4`, `border-b`, `shrink-0`. No background color.

**`Column` toolbar wrapper** (`packages/ui/src/components/layout/app/column-layout.tsx`):
```tsx
<div className="h-12 flex items-center px-4 border-b shrink-0 border-r">
```
Has padding and borders, but no background or `no-print`.

**Stickies toolbar** (`apps/stickies/src/components/stickies/toolbar.tsx`):
```tsx
<div className="bg-white h-12 flex items-center justify-between px-4 border-b no-print">
```
Hardcodes `bg-white`, adds `justify-between`, skips `shrink-0`.

The `Toolbar` component is used inside `Column` but `Column` wraps it with its own div, making the `Toolbar` component
effectively a no-op wrapper.

#### 7. Sidebar Header Duplication

The same block is copy-pasted across **11 sidebar files** (not 5 as previously stated). Each includes:

```tsx
<div className="flex items-center h-12 bg-app px-4">
    <Button variant="ghost" size="icon" onClick={onClose}
            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
        <X className="h-5 w-5"/>
        <span className="sr-only">Close menu</span>
    </Button>
    <AppLogo appName="..."/>
</div>
```

Files: `drive-sidebar.tsx`, `mail/email-sidebar.tsx`, `contacts/contacts-sidebar.tsx`,
`stickies/sidebar.tsx`, `space/space-sidebar.tsx`, `people/people-sidebar.tsx`,
`calendar/calendar-sidebar.tsx`, `docs/docs-sidebar.tsx`, `slides/slides-sidebar.tsx`,
`sheets/sheets-sidebar.tsx`, `chat/chat-sidebar.tsx`.

This is a strong case for a `SidebarHeader` component -- it would eliminate ~55 lines of duplication.

#### 8. Icon Size Inconsistency

Icons are sized via multiple mechanisms:

- `className="h-4 w-4"` -- standard, most common
- `className="h-5 w-5"` -- sidebar close buttons (11 instances, all identical)
- `className="h-3 w-3"` -- small indicators (`contact-edit.tsx`, `editor-toolbar.tsx`)
- `size={16}` -- Lucide `size` prop (`stickies/column.tsx` Plus icon)
- `className="w-4 h-4 mr-2"` -- context menu icons in stickies/sheets toolbars (reversed `w-h` order)

The `w-4 h-4` ordering (vs `h-4 w-4`) appears in stickies and sheets toolbars. The inconsistency makes
find-and-replace harder.

#### 9. Spacing Scale Drift

Gap and padding values vary without a clear scale:

- Dialog form gaps: `space-y-4` (calendar), `grid gap-4 py-4` (stickies card settings), `grid gap-2` (stickies inside grid)
- Icon-to-label gaps: `gap-3` (calendar event detail), `gap-2` (stickies), `gap-1` (toolbar buttons)
- List item padding: varies per app
- `mr-2` appears 99 times across 29 files -- many could be replaced with `gap-2` on the parent

#### 10. Loading State Inconsistency

`EigenLoader` (`packages/ui/src/components/layout/braket/eigen-loader.tsx`) is used across 10+ apps but wrapped
differently each time:

```tsx
// drive (2 files)
<div className="flex items-center justify-center h-full w-full"><EigenLoader/></div>

// people
<div className="h-full flex items-center justify-center"><EigenLoader/></div>

// calendar
<EigenLoader/>  // bare, no wrapper

// drive shared view
return <EigenLoader/>;  // bare, inline return
```

Some apps center it, some don't. The `EigenLoader` component itself has no centering -- it just renders the bra/ket
animation inline.

#### 11. The `text-*-600` Safelist Hack

12 self-referencing classes in `globals.css` under `@layer base`:

```css
.text-teal-600 { @apply text-teal-600; }
.text-red-600 { @apply text-red-600; }
/* ... 10 more, one per app color */
```

These force Tailwind to include colors used dynamically (e.g., when composing `text-${color}-600` at runtime).
However, `globals.css` already has `@source "../../../apps/**/*.{ts,tsx}"` which should cover statically analyzable
class usage. The hack may only be needed for truly dynamic composition (template literals). Worth testing removal.

#### 12. `hsl()` / `oklch()` Color Space Mismatch

The `.drag-badge` class in `globals.css` uses `hsl(var(--primary))` but `--primary` is defined as an oklch value
(`oklch(0.208 0.042 265.755)`). This will render incorrectly. Similarly, `apps/sheets/css/globals.css` uses
`hsl(var(--border))`. These need to be updated to use the Tailwind theme color directly (e.g.,
`background: var(--color-primary)`) or the oklch value.

#### 13. Duplicate `useMediaQuery` Hook

`useMediaQuery` is defined in two places:
- `packages/lib/src/core/media/hooks/use-media-query.ts` (canonical, exports `useIsMobile`, `useIsTablet`, `useIsDesktop`)
- `apps/space/src/hooks/use-media-query.ts` (duplicate, only `useMediaQuery`)

The space app should import from `@workspace/lib/media`.

#### 14. Unused `Empty` Component

The `Empty` component family (`Empty`, `EmptyHeader`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`, `EmptyMedia`)
exists in `packages/ui/src/components/empty.tsx` with CVA variants, but no app imports it. Apps either show bare
text for empty states or use custom implementations.

---

## Dark Mode Readiness

### Current State

The token infrastructure for dark mode is complete:

```css
/* globals.css already has both light and dark values */
:root {
    --background: oklch(1 0 0);           /* white */
    --foreground: oklch(0.129 0.042 264.695); /* near-black */
    --muted: oklch(0.968 0.007 247.896);
    /* ... 20+ tokens */
}

.dark {
    --background: oklch(0.129 0.042 264.695); /* near-black */
    --foreground: oklch(0.984 0.003 247.858); /* near-white */
    --muted: oklch(0.279 0.041 260.031);
    /* ... matching dark values */
}
```

The `@custom-variant dark (&:is(.dark *))` directive means adding `class="dark"` to a parent element will flip all
semantic colors. Tailwind 4's `dark:` variant is wired up and ready.

### What Blocks Dark Mode

1. **~40 instances of raw `gray-*` and `bg-white`** in app code that bypass semantic tokens (see Problems 1-2).
2. **`eigen-list-item` uses `bg-white`** instead of `bg-background`.
3. **`eigen-list-item-selected` uses raw HSL** (`hsl(210 100% 93%)`) instead of a semantic token.
4. **`drag-badge` uses `hsl(var(--primary))`** which is wrong (tokens are oklch).
5. **App colors** (`--app-mail-color` etc.) reference Tailwind palette colors (`var(--color-red-600)`) which are
   constant across light/dark. These branded colors may be fine as-is, or may need a dark-mode muted variant
   (e.g., `--app-mail-color-dark: var(--color-red-400)`).

### Token System and Dark Mode

The semantic token system enables dark mode through indirection:

```
Component uses: bg-background
  -> Tailwind resolves: --color-background -> var(--background)
    -> Light: oklch(1 0 0) (white)
    -> Dark:  oklch(0.129 0.042 264.695) (near-black)
```

Any component using `bg-background` instead of `bg-white` gets dark mode for free. The fix is mechanical: replace
raw colors with semantic tokens, and dark mode works everywhere those tokens are used.

---

## Design Token Proposal

### Current Token Layer

Tokens are defined in two layers in `packages/ui/src/styles/globals.css`:

1. **CSS custom properties** in `:root` / `.dark` -- the semantic values (oklch colors, radius).
2. **`@theme inline`** -- maps properties to Tailwind's theme namespace (`--color-*`, `--radius-*`, `--animate-*`).

The `@theme inline` directive is the Tailwind CSS 4 way to define design tokens. It replaces the old
`tailwind.config.ts` `theme.extend` approach. The `inline` keyword means tokens are defined in CSS rather than a
separate config file, keeping everything in one place.

**What exists:** Color tokens (20+ semantic colors with light/dark variants), radius tokens (sm/md/lg/xl),
accordion animations.

**What is missing:** Spacing scale, dialog widths, transition presets, z-index scale.

### Proposed Token Extensions

Add to the existing `@theme inline` block in `packages/ui/src/styles/globals.css`:

```css
@theme inline {
    /* === Existing color + radius + animation tokens (keep as-is) === */

    /* === Layout spacing === */
    --spacing-toolbar: 3rem;           /* 48px - h-12 toolbar height */
    --spacing-sidebar: 16rem;          /* 256px - w-64 full sidebar */
    --spacing-sidebar-condensed: 4rem; /* 64px - w-16 condensed sidebar */
    --spacing-section: 1.5rem;         /* 24px - vertical section spacing */
    --spacing-field: 1rem;             /* 16px - gap between form fields */
    --spacing-inline: 0.75rem;         /* 12px - gap between icon and label */

    /* === Dialog widths === */
    --width-dialog-xs: 22.5rem;  /* 360px - confirmations, simple choices */
    --width-dialog-sm: 26.5rem;  /* 424px - simple forms */
    --width-dialog-md: 31.25rem; /* 500px - standard forms */
    --width-dialog-lg: 43.75rem; /* 700px - complex dialogs */

    /* === Transition presets === */
    --transition-fast: 150ms ease;
    --transition-normal: 200ms ease;
    --transition-slow: 300ms ease;
}
```

These tokens become usable as Tailwind utilities: `w-dialog-md`, `h-toolbar`, `transition-normal`, etc.

**Note on z-index:** Tailwind CSS 4 does not support `--z-*` tokens in `@theme`. Z-index values are better
standardized via CSS custom properties in `:root` outside `@theme`, or just documented as conventions (Radix/shadcn
already handle z-index for overlays, modals, and popovers internally).

### App Color Token Pattern

App colors are already centrally defined in `globals.css` under `@layer base`:

```css
:root {
    --app-space-color: var(--color-teal-600);
    --app-mail-color: var(--color-red-600);
    --app-contacts-color: var(--color-sky-600);
    /* ... 12 more */
}
```

No per-app `css/globals.css` files exist for color mapping (confirmed by glob search). The `bg-app`/`text-app`
utilities are applied by each app setting a CSS class or property. This pattern is clean and should be documented.

For dark mode, consider adding a muted variant: `--app-mail-color-muted: var(--color-red-400)` for use in dark
backgrounds where `red-600` would lack contrast.

---

## Component Abstraction Strategy

### Principle

Apps should not assemble raw Tailwind for patterns that repeat across apps. Instead, apps import a component or a
CSS class. One-off layouts specific to a single app (calendar grid, slides canvas, sheets formula bar) stay inline.

### Strategy Tiers

#### Tier 1: CSS Utility Classes (repeated micro-patterns)

Defined in `packages/ui/src/styles/globals.css` under `@layer base`. Already done for `eigen-list-item`. Extend to:

| Class | Pattern | Usage Count |
|-------|---------|-------------|
| `.eigen-center` | `flex items-center justify-center h-full w-full` | 5+ loading states |
| `.eigen-toolbar` | `h-12 flex items-center px-4 border-b shrink-0` | 3+ toolbar variants |
| `.eigen-sidebar-header` | `flex items-center h-12 bg-app px-4` | 11 sidebar files |
| `.eigen-icon-muted` | `h-4 w-4 text-muted-foreground shrink-0` | 10+ icon rows |
| `.eigen-icon-row` | `flex items-start gap-3 text-sm` | 5+ dialog detail rows |

**Why CSS classes, not components?** These are layout affordances, not interactive components. A CSS class is lighter,
more composable, and does not add a React wrapper element.

#### Tier 2: Shared React Components (stateful or complex)

Already exist: `Button`, `Dialog`, `Toolbar`, `TooltipButton`, `DeleteDialog`, `Empty`. Extend to:

| Component | Purpose | Replaces |
|-----------|---------|----------|
| `DialogContent` with `size` prop | Named dialog widths | 16 raw `sm:max-w-*` overrides |
| `DialogFormFooter` | Standardized form footer | ~5 inconsistent footer implementations |
| `SidebarHeader` | Mobile sidebar header with close + logo | 11 copy-pasted blocks |
| `LoadingCenter` | Centered `EigenLoader` | 5+ inconsistent wrapper divs |
| `IconRow` | Icon + content row for detail dialogs | 5+ repeated patterns in calendar |

#### Tier 3: CVA Variants on Existing Components

Already used by: `Button` (6 variants), `EmptyMedia` (2 variants). Extend to:

- `DialogContent` -- size variants (xs/sm/md/lg)
- `TooltipButton` -- size variants (currently defaults `className="h-8 w-8"`, sometimes overridden)

### What NOT to Abstract

- One-off layouts specific to a single app (calendar grid cells, slides canvas/object system, sheets formula bar,
  docs editor chrome, chat message bubbles).
- Application-specific business logic rendering.
- Components used in only one place.

---

## Dialog & Modal Standardization

### Proposed Size System

Add a `size` prop to `DialogContent` in `packages/ui/src/components/dialog.tsx`:

```tsx
type DialogSize = 'xs' | 'sm' | 'md' | 'lg';

const dialogSizeClasses: Record<DialogSize, string> = {
    xs: 'sm:max-w-[360px]',   // Confirmations, simple choices
    sm: 'sm:max-w-[425px]',   // Simple forms (label, rename, add card/column)
    md: 'sm:max-w-[500px]',   // Standard forms (event, calendar config, card dialog)
    lg: 'sm:max-w-[700px]',   // Complex content (sharing, access control)
};
```

The default `sm:max-w-lg` (512px) from shadcn becomes the fallback when no `size` is specified, preserving backward
compatibility.

Migration mapping:

| Current Width | Maps To | Dialogs |
|---------------|---------|---------|
| `sm:max-w-[360px]` | `xs` | `RecurringActionDialog` |
| `sm:max-w-[400px]`, `sm:max-w-[425px]`, `sm:max-w-md` | `sm` | `LabelDialog`, `SharedCalendarConfigDialog`, `AddCardDialog`, `AddColumnDialog`, `CardSettingsDialog`, `ColumnSettingsDialog` |
| `sm:max-w-[450px]`, `sm:max-w-[500px]` | `md` | `EventDetailDialog`, `CreateEventDialog`, `EditEventDialog`, `CalendarConfigDialog`, `CardDialog` |
| `sm:max-w-[700px]` | `lg` | `DriveAccessDialog` |
| default (no override) | (no prop needed) | `DeleteDialog`, `CommentDialog` |

### Standardized Footer Component

```tsx
type DialogFormFooterProps = {
    onCancel: () => void;
    onDelete?: () => void;
    isLoading?: boolean;
    submitLabel?: string;
    submitDisabled?: boolean;
}

export function DialogFormFooter({
    onCancel,
    onDelete,
    isLoading = false,
    submitLabel = 'Save',
    submitDisabled = false,
}: DialogFormFooterProps) {
    return (
        <DialogFooter>
            {onDelete && (
                <Button type="button" variant="destructive" onClick={onDelete}
                        disabled={isLoading} className="mr-auto">
                    Delete
                </Button>
            )}
            <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
                Cancel
            </Button>
            <Button type="submit" disabled={isLoading || submitDisabled}>
                {isLoading ? 'Saving...' : submitLabel}
            </Button>
        </DialogFooter>
    );
}
```

This replaces the stickies pattern (wrapper div with `gap-2`) and the calendar pattern (`mr-2` on Cancel, `mr-auto`
on Delete) with one consistent layout.

### Dialog Checklist

- [ ] Uses `size` prop instead of raw `sm:max-w-[Npx]`
- [ ] Uses `DialogFormFooter` or `DialogFooter` with standard button ordering
- [ ] Delete confirmations use the shared `DeleteDialog` component (not inline dialog)
- [ ] `isLoading` state disables all buttons and shows loading text on submit
- [ ] Dialog title uses `DialogTitle` (not raw `<h2>`)

---

## Tailwind Class Reduction Strategies

### Strategy 1: Replace Hardcoded Colors with Semantic Tokens

Highest-impact change. Enables dark mode and unifies visual identity.

| Find | Replace With | Notes |
|------|-------------|-------|
| `text-gray-900` | `text-foreground` | |
| `text-gray-700` | `text-foreground` | |
| `text-gray-600` | `text-muted-foreground` | |
| `text-gray-500` | `text-muted-foreground` | |
| `text-gray-400` | `text-muted-foreground` | |
| `bg-white` | `bg-background` | Except docs/slides document canvas |
| `bg-gray-50` | `bg-muted/50` | |
| `bg-gray-100` | `bg-muted` | |
| `bg-gray-200` | `bg-muted` | Code blocks in blog |
| `divide-gray-100` | `divide-border` | |
| `border-gray-300` | `border-border` | Already default via `* { @apply border-border }` |

**Exceptions:** `apps/docs/src/components/docs/editor.tsx` uses `bg-white` for the document page -- this is
intentional (the editor renders a white page regardless of theme). `apps/slides/src/components/slides/slide-object.tsx`
uses `bg-white` for resize handles -- also intentional. These should be annotated with comments.

### Strategy 2: Extract Repeated Class Combinations

| Pattern | Current Usage | Proposed |
|---------|---------------|----------|
| `flex items-center justify-center h-full w-full` | Loading states (5+ files) | `.eigen-center` |
| `h-12 flex items-center px-4 border-b shrink-0` | Toolbar/header bars (3+ places) | `.eigen-toolbar` |
| `flex items-center h-12 bg-app px-4` | Sidebar headers (11 files) | `.eigen-sidebar-header` |
| `h-4 w-4 text-muted-foreground shrink-0` | Form/detail icons (10+ uses) | `.eigen-icon-muted` |
| `flex items-start gap-3 text-sm` | Icon+text rows (5+ uses) | `.eigen-icon-row` |

### Strategy 3: Normalize Icon Sizing

Convention:

| Size | Class | Use |
|------|-------|-----|
| Small | `h-3 w-3` | Badges, inline indicators, dropdown chevrons |
| Standard | `h-4 w-4` | Most UI icons, toolbar buttons, context menus |
| Large | `h-5 w-5` | Sidebar close buttons, topbar actions |

Rules:
- Always use Tailwind classes, never Lucide's `size` prop.
- Always order `h-` before `w-` for consistency and searchability.
- The `w-4 h-4 mr-2` pattern in stickies/sheets toolbar menus should become `h-4 w-4 mr-2`.

### Strategy 4: Eliminate the Safelist Hack

The 12 self-referencing classes can likely be removed because `globals.css` already has `@source` directives that
scan all app source files. To verify:

1. Remove the `.text-teal-600 { @apply text-teal-600; }` block.
2. Build and check if the classes are still included.
3. If any are missing, the dynamic composition site needs refactoring to use CSS custom properties:

```tsx
// Instead of: className={`text-${appInfo.color}-600`} (not statically analyzable)
// Use: style={{ color: `var(--app-${appInfo.id}-color)` }}
```

The CSS custom properties (`--app-space-color`, etc.) are already defined and ready for this.

### Strategy 5: Fix Color Space Mismatch

Replace `hsl(var(--primary))` with the correct reference:

```css
/* Before */
.drag-badge { background: hsl(var(--primary)); }

/* After */
.drag-badge { background: var(--color-primary); }
```

Same fix needed in `apps/sheets/css/globals.css` where `hsl(var(--border))` should become `var(--color-border)`.

---

## Animation & Transition Consistency

### Current State

Transitions are used sparingly and inconsistently:

- `transition-colors` -- calendar sidebar checkboxes, month/week view hover states (6 files)
- `transition-shadow` -- space card hover (`hover:shadow-md transition-shadow`)
- `transition-transform duration-200` -- media grid image hover scale
- `transition-colors duration-200 ease-in-out` -- fa2 toggle switch (verbose, could use shorthand)
- `animate-in fade-in` / `animate-in zoom-in-95` -- file preview overlays (via `tailwindcss-animate` plugin)

No transition is applied to sidebar expand/collapse, column resize, or most hover states.

### Proposed Conventions

1. **Hover state transitions** should use `transition-colors` (no explicit duration -- Tailwind default 150ms is fine).
2. **Layout transitions** (sidebar collapse, panel resize) should use `transition-all duration-200` or the proposed
   `--transition-normal` token.
3. **Entry/exit animations** should use the existing `tailwindcss-animate` plugin (`animate-in`, `fade-in`,
   `zoom-in-95`). Dialogs already get this from shadcn's `DialogContent`.
4. **Avoid `transition-all`** for simple color/opacity changes -- it is heavier and can cause layout jank if an
   element also has dimensional changes.

### Token-Based Transitions

If tokens are adopted, components can reference them:

```css
/* In @theme inline */
--transition-fast: 150ms ease;
--transition-normal: 200ms ease;
--transition-slow: 300ms ease;
```

Usage: `style={{ transition: 'var(--transition-normal)' }}` or via a Tailwind utility if Tailwind 4 supports
`--transition-*` tokens (it does via `@theme`).

---

## Responsive Design

### Current Approach

Responsive behavior uses viewport-based media queries:

- `useIsMobile()` (max-width: 768px) and `useIsTablet()` (769-1024px) from
  `packages/lib/src/core/media/hooks/use-media-query.ts`
- `AppShell` passes `isMobile`/`isTablet` via `LayoutContext`
- `ColumnLayout` hides non-active columns on mobile via `mobileColumn` prop
- Sidebar collapses to drawer on mobile via `SidebarContainer`

This is a top-down approach: the shell decides the layout mode, and all children adapt.

### Container Queries

CSS container queries are already used in two shadcn components:
- `FieldGroup` (`packages/ui/src/components/field.tsx`): `@container/field-group`
- `CardHeader` (`packages/ui/src/components/card.tsx`): `@container/card-header`

Container queries allow components to respond to their own available width rather than the viewport width.
This is valuable for components that appear in different contexts (e.g., a contact card in a sidebar vs. a
full-width panel).

**Candidates for container queries:**

- **Drive file grid** -- item size based on container width, not viewport
- **Calendar event chips** -- show/hide details based on cell width
- **Sidebar sections** -- adjust layout based on sidebar width (full vs. condensed)
- **Preview panels** -- any content rendered inside a resizable column

**How to adopt:**

```css
/* On the container */
.drive-grid-container { container-type: inline-size; }

/* On children */
@container (min-width: 400px) {
    .drive-grid-item { /* wider layout */ }
}
```

Or with Tailwind 4's `@container` variant: `@container-[min-width:400px]:grid-cols-3`.

### Duplicate Hook Cleanup

The `useMediaQuery` hook in `apps/space/src/hooks/use-media-query.ts` is a duplicate of the one in
`packages/lib/src/core/media/hooks/use-media-query.ts`. The space app should import from `@workspace/lib/media`.

---

## Enforcement Mechanisms

### 1. ESLint Rules

**No raw gray colors:**
```js
'no-restricted-syntax': ['warn', {
    selector: 'JSXAttribute[name.name="className"][value.value=/text-gray-|bg-gray-|border-gray-|divide-gray-/]',
    message: 'Use semantic tokens (text-foreground, text-muted-foreground, bg-muted, border-border).'
}]
```

**No bg-white:**
Same pattern, flagging `bg-white` and suggesting `bg-background`.

**No raw dialog widths:**
Flag `sm:max-w-[` on `DialogContent` and suggest the `size` prop.

Note: these rules will not catch classes inside template literals or `cn()` calls with dynamic segments. They are a
first line of defense, not a guarantee.

### 2. TypeScript API Design

Make the component API guide developers to the right choice:

```tsx
type DialogContentProps = {
    size?: 'xs' | 'sm' | 'md' | 'lg';
    className?: string; // escape hatch
}
```

The `size` prop is discoverable via autocomplete. Arbitrary widths require the less obvious `className` override.

### 3. PR Review Checklist

- [ ] No `text-gray-*`, `bg-gray-*`, or `bg-white` in app code (use semantic tokens)
- [ ] Dialog sizes use the `size` prop
- [ ] New shared patterns extracted to `packages/ui/` if used in 2+ apps
- [ ] Icons use `h-N w-N` classes (not Lucide `size` prop), ordered `h-` before `w-`
- [ ] Transitions use `transition-colors` (not `transition-all`) for simple state changes
- [ ] Delete confirmations use the shared `DeleteDialog` component

### 4. Component Boundaries

Enforce that apps import layout primitives from `packages/ui/`, not from each other:

- Apps may not import components from other apps.
- All shared UI lives in `packages/ui/src/components/`.
- All shared hooks live in `packages/lib/src/`.

Enforceable with ESLint `no-restricted-imports` targeting cross-app imports.

---

## Specific Components to Create or Modify

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `DialogFormFooter` | `packages/ui/src/components/dialog.tsx` | Standardized form dialog footer |
| `SidebarHeader` | `packages/ui/src/components/layout/sidebar/sidebar-header.tsx` | Mobile sidebar header (close + AppLogo) -- eliminates 11 duplicates |
| `LoadingCenter` | `packages/ui/src/components/layout/loading-center.tsx` | Centered `EigenLoader` with `.eigen-center` wrapper |
| `IconRow` | `packages/ui/src/components/layout/icon-row.tsx` | Icon + content row for detail dialogs |

### Components to Modify

| Component | File | Change |
|-----------|------|--------|
| `DialogContent` | `packages/ui/src/components/dialog.tsx` | Add `size` prop (xs/sm/md/lg) with CVA |
| `Toolbar` | `packages/ui/src/components/layout/toolbar/toolbar.tsx` | Add `px-4`, `border-b`, `shrink-0` to match `Column`'s toolbar wrapper |
| `Column` | `packages/ui/src/components/layout/app/column-layout.tsx` | Remove inline toolbar styles, use `Toolbar` or `.eigen-toolbar` |
| `TooltipButton` | `packages/ui/src/components/layout/toolbar/tooltip-button.tsx` | Add CVA size variant instead of `className="h-8 w-8"` default |
| `eigen-list-item` | `packages/ui/src/styles/globals.css` | `bg-white` -> `bg-background` |
| `eigen-list-item-selected` | `packages/ui/src/styles/globals.css` | `hsl(210 100% 93%)` -> semantic token or oklch |
| `drag-badge` | `packages/ui/src/styles/globals.css` | `hsl(var(--primary))` -> `var(--color-primary)` |

### CSS Classes to Add

Add to `packages/ui/src/styles/globals.css` under `@layer base`:

```css
.eigen-center {
    @apply flex items-center justify-center h-full w-full;
}

.eigen-toolbar {
    @apply h-12 flex items-center px-4 border-b shrink-0;
}

.eigen-sidebar-header {
    @apply flex items-center h-12 bg-app px-4;
}

.eigen-icon-muted {
    @apply h-4 w-4 text-muted-foreground shrink-0;
}

.eigen-icon-row {
    @apply flex items-start gap-3 text-sm;
}
```

---

## Before/After Examples

### Example 1: Dialog Width

```tsx
// BEFORE
<DialogContent className="sm:max-w-[500px]">

// AFTER
<DialogContent size="md">
```

### Example 2: Dialog Footer

```tsx
// BEFORE (CalendarConfigDialog -- 15 lines with inconsistent spacing classes)
<DialogFooter className="flex justify-end">
    {isEditMode && !calendar.isDefault && (
        <Button type="button" variant="destructive"
                onClick={() => setShowDeleteConfirmation(true)}
                disabled={isLoading} className="mr-auto">
            Delete
        </Button>
    )}
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}
            className="mr-2" disabled={isLoading}>
        Cancel
    </Button>
    <Button type="submit" disabled={isLoading || form.formState.isSubmitting}>
        {isLoading ? 'Saving...' : 'Save'}
    </Button>
</DialogFooter>

// AFTER (3 lines)
<DialogFormFooter
    onCancel={() => onOpenChange(false)}
    onDelete={isEditMode && !calendar.isDefault ? () => setShowDeleteConfirmation(true) : undefined}
    isLoading={isLoading}
    submitDisabled={form.formState.isSubmitting}
/>
```

### Example 3: Sidebar Header

```tsx
// BEFORE (repeated in 11 sidebar files)
{isMobile && (
    <div className="flex items-center h-12 bg-app px-4">
        <Button variant="ghost" size="icon" onClick={onClose}
                className="mr-2 text-white hover:bg-primary/20 hover:text-white">
            <X className="h-5 w-5"/>
            <span className="sr-only">Close menu</span>
        </Button>
        <AppLogo appName="mail"/>
    </div>
)}

// AFTER
{isMobile && <SidebarHeader appName="mail" onClose={onClose} />}
```

### Example 4: Loading State

```tsx
// BEFORE (varies per file)
<div className="flex items-center justify-center h-full w-full"><EigenLoader/></div>
<div className="h-full flex items-center justify-center"><EigenLoader/></div>
<EigenLoader/>

// AFTER
<LoadingCenter />
```

### Example 5: Inline Delete to Shared DeleteDialog

```tsx
// BEFORE (card-settings-dialog.tsx -- 20 lines of inline delete dialog)
<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
    <DialogContent>
        <DialogHeader><DialogTitle>Delete Card</DialogTitle></DialogHeader>
        <div className="py-4">
            <p className="text-sm text-gray-500">
                This will permanently delete the card. This action cannot be undone.
            </p>
        </div>
        <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

// AFTER (using shared component)
<DeleteDialog
    open={isDeleteDialogOpen}
    onOpenChange={setIsDeleteDialogOpen}
    title="Delete Card"
    description="This will permanently delete the card"
    onDelete={handleDelete}
/>
```

---

## Cross-Cutting Concerns

Layout standardization affects the other research areas. This section maps dependencies.

### Vector App (RESEARCH_VECTOR.md)

The vector/drawing app will need:
- **Canvas-specific `bg-white`**: The drawing canvas should remain white (or configurable). This is a legitimate
  exception to the `bg-background` rule, same as the docs editor page. Mark with a `/* intentional: canvas bg */`
  comment.
- **Toolbar consistency**: The vector toolbar should use the shared `Toolbar` component or `.eigen-toolbar` class,
  not a custom implementation like stickies did.
- **Dialog patterns**: Shape properties dialog, export dialog, etc. should use `DialogContent size="md"` and
  `DialogFormFooter` from day one.

### Graphs & Charts (RESEARCH_GRAPHS.md)

- **Color tokens**: Chart colors should use the existing `--chart-1` through `--chart-5` CSS tokens (already defined
  in both light and dark variants). This ensures charts adapt to dark mode.
- **Embed rendering**: Charts embedded in docs/slides need to respect the host app's theme tokens, not hardcode
  colors.

### File Previews (RESEARCH_PREVIEWS.md)

- **Preview overlay**: `FilePreview` in `apps/drive/src/components/drive/file-preview.tsx` uses `bg-white` for the
  preview container and builds its own overlay instead of using `Dialog`. If the preview system is rebuilt, it should
  use `bg-background` for the container and the standard animation tokens (`animate-in`, `fade-in`).
- **`MediaPreview`** in `apps/index/src/components/MediaPreview.tsx` is a near-duplicate of `FilePreview` -- these
  should be unified.

### Copy-Paste (RESEARCH_COPY_PASTE.md)

- No direct layout dependency, but pasted content that renders in the UI (e.g., rich text preview) should use
  semantic tokens for any chrome/borders.

### Inline Editing (RESEARCH_INLINE_EDITING.md)

- The Tiptap editor chrome (toolbar, status bar) should use shared toolbar patterns.
- Document content area is intentionally `bg-white` (page simulation) -- this is a valid exception.

### General Principle

New features should use the shared component vocabulary from day one. The cost of extracting patterns later is higher
than using them upfront. The research documents should reference the layout conventions established here.

---

## Component Playground

### Current State

No Storybook, Ladle, or Histoire configuration exists in the project. Shared components in `packages/ui/` are only
visible when used in an app.

### Recommendation

A component playground would help with:
- Visualizing all shared components in one place (Button variants, Dialog sizes, Empty states, etc.)
- Testing dark mode toggle without wiring up the full app
- Documenting component APIs with live examples
- Catching visual regressions

### Options

**Storybook**: Industry standard, large ecosystem, but heavy install. Works with Vite.

**Ladle**: Lighter alternative, Vite-native. Minimal config. Good fit for a monorepo where bundle size matters.

**Custom route**: Add a `/playground` route to an existing app (e.g., `apps/space`) that renders all shared
components. Zero new dependencies but limited tooling.

**Recommended approach**: Start with a custom playground route in `apps/space` or a dedicated `apps/playground` app.
This avoids new dependencies and works within the existing monorepo build system. If component documentation needs
grow, migrate to Ladle.

A playground would also serve as a visual regression test surface: screenshot comparisons of the playground page can
catch unintended style changes.

---

## Migration Approach

### Principles

1. **Non-breaking.** Old `className` overrides continue to work. New props are optional.
2. **No visual changes.** Output must look identical. Visual improvements are separate PRs.
3. **One pattern at a time.** Each PR addresses one category of change.
4. **Typecheck and test.** Per CLAUDE.md: `bun run typecheck` and `bun run test` after every change.

### Per-Pattern Migration Steps

1. Add the new API (prop, component, or CSS class) with backward compatibility.
2. Update all call sites in one PR.
3. (Optional) Add an ESLint rule to prevent regression.
4. Document in the relevant `docs/` file.

---

## Implementation Phases

### Phase 1: Foundation (Low Risk, High Impact)

**Goal:** Fix the most impactful inconsistencies without changing component APIs.

1. **Replace raw gray colors with semantic tokens** across all apps (~40 instances).
2. **Replace `bg-white` with `bg-background`** in app code (~13 instances, excluding intentional canvas uses).
3. **Fix `eigen-list-item`** to use `bg-background` instead of `bg-white`.
4. **Fix `eigen-list-item-selected`** to use oklch or a semantic token instead of raw HSL.
5. **Fix `drag-badge`** to use `var(--color-primary)` instead of `hsl(var(--primary))`.
6. **Fix `hsl(var(--border))`** in `apps/sheets/css/globals.css`.
7. **Normalize icon class ordering**: `w-4 h-4` -> `h-4 w-4` in stickies/sheets toolbars.
8. **Add CSS utility classes** (`.eigen-center`, `.eigen-toolbar`, `.eigen-sidebar-header`, `.eigen-icon-row`,
   `.eigen-icon-muted`) to `globals.css`.
9. **Remove duplicate `useMediaQuery`** in `apps/space/src/hooks/use-media-query.ts`.

**Estimated scope:** ~80 lines changed across 15-20 files. Zero behavioral risk.

### Phase 2: Component Improvements (Medium Risk)

**Goal:** Add size prop to Dialog, create shared footer and sidebar header.

1. **Add `size` prop to `DialogContent`** (xs/sm/md/lg). Keep `className` working.
2. **Create `DialogFormFooter`** component in `dialog.tsx`.
3. **Create `SidebarHeader`** component -- replaces 11 copy-pasted blocks.
4. **Create `LoadingCenter`** component.
5. **Reconcile `Toolbar` and `Column` toolbar styles.**
6. **Migrate dialogs** to use `size` prop and `DialogFormFooter`.
7. **Replace inline delete confirmations** in stickies with shared `DeleteDialog`.
8. **Migrate sidebar headers** to use `SidebarHeader`.

**Estimated scope:** ~200 lines of new shared code, ~150 lines removed from apps.

### Phase 3: Token Expansion (Low Risk)

**Goal:** Extend the design token system.

1. **Add spacing and dialog width tokens** to `@theme inline`.
2. **Add transition tokens** for consistent animation timing.
3. **Test removal of safelist hack** -- remove the 12 self-referencing classes, rebuild, verify.
4. **Document all tokens** in `docs/LAYOUT.md`.

**Estimated scope:** ~30 lines in globals.css, ~20 lines across components.

### Phase 4: Enforcement & Tooling (Ongoing)

**Goal:** Prevent drift and improve developer experience.

1. **Add ESLint rules** for raw gray colors, `bg-white`, and direct dialog width overrides.
2. **Update PR review checklist.**
3. **Update CLAUDE.md** with new patterns and rules.
4. **Update `docs/LAYOUT.md`** and `docs/LAYOUT-SHARED-COMPONENTS.md`.**
5. **Create component playground** (custom route or dedicated app).

---

## Summary

The Eigen codebase has a solid structural foundation (AppShell, ColumnLayout, Column, shadcn primitives) and a
complete dark-mode token system. The blockers are:

1. **~50 instances of raw colors** (`gray-*`, `bg-white`, `hsl()`) bypassing semantic tokens -- the single biggest
   dark-mode blocker and consistency issue.
2. **8 different dialog width values** and 5 conflicting footer patterns -- a `size` prop and `DialogFormFooter`
   component fix this.
3. **11 identical sidebar header blocks** -- a `SidebarHeader` component eliminates the duplication.
4. **3 divergent toolbar implementations** -- reconciling `Toolbar`, `Column`'s wrapper, and stickies' custom
   toolbar.

Phase 1 (semantic color migration + CSS classes) is mechanical and can be done in a single session. Phase 2
(components) requires more care but reduces significant duplication. Phases 3-4 prevent future drift.

No architectural changes are needed. The existing layout system is well-designed. The improvements fill gaps below the
structural layer: consistent tokens, standardized component variants, and extracted repeated patterns.
