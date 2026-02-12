# Unified Layout System Refactoring Plan

Refactor the scattered, duplicated layout code across all FE apps into a single declarative column-based layout system in `packages/ui`, with three visual modes: column mode (toolbar in topbar), document mode (secondary toolbar row), and settings mode.

---

## Current State (Problems)

### What exists today
| Component | Location | Role |
|-----------|----------|------|
| `EigenApp` | `packages/ui` | Provider wrapper (Query, Auth, SSE, Upload, Tooltip, AppContext) |
| `RootLayout` | `packages/ui` | Topbar + Outlet + SidebarContext. Ad-hoc props: `hideMenuOnRoute`, `outletWrapper` |
| `Topbar` | `packages/ui` | App logo, burger menu, user dropdown. No awareness of column toolbars |
| `AppLayout` | `packages/ui` | Sidebar (responsive) + `<main>` with Outlet |
| `AppContext` | `packages/ui` | Just `appName` string |
| `DriveLayout` | `packages/ui` | Drive-specific 2/3-column layout with its own mobile logic |

### Per-app layout patterns
| App | Columns | How it works |
|-----|---------|-------------|
| **Mail** | sidebar \| email-list \| email-detail | `_auth.tsx` uses `AppLayout` for sidebar. Route manually builds 2-col flex layout with `isMobile`/`isTablet` checks, each column has its own h-12 toolbar |
| **Drive** | sidebar \| file-list \| file-detail | `_auth.tsx` uses `AppLayout`. Route delegates to `DriveLayout` which has its own responsive logic |
| **Contacts** | sidebar \| contacts-list \| contact-detail | Same as mail: manual flex columns, manual mobile checks, per-column toolbars |
| **Docs** | sidebar+list OR full-width editor | Two layout modes via `_auth._sidebar.tsx` (with `AppLayout`) and `_auth.doc.*` (no sidebar, `EditorToolbar` below topbar). `__root.tsx` uses `hideMenuOnRoute` hack |
| **Stickies** | sidebar+list OR full-width board | Identical pattern to Docs. `StickiesToolbar` below topbar |
| **Space** | sidebar \| content | `AppLayout` + scrollable outlet wrapper via `outletWrapper` prop in `__root.tsx` |

### Key problems
1. **Duplicated responsive logic** — `isMobile`/`isTablet`/`useIsMobile()` scattered in every route and component
2. **Manual column layouts** — Each app builds its own flex containers, widths, show/hide logic
3. **Toolbars embedded in content** — Each detail/list component renders its own `h-12 border-b` bar. Wastes vertical space on desktop
4. **`__root.tsx` copy-pasted** 6 times with minor variations (`hideMenuOnRoute`, `outletWrapper`)
5. **`_auth.tsx` duplicated** — Same auth redirect + `AppLayout` + sidebar pattern in every app
6. **Docs/Stickies share identical** `_auth._sidebar.tsx` with `DriveContext` boilerplate
7. **No back-navigation system** — Mobile back buttons are manually wired per component
8. **`RootLayout` has ad-hoc escape hatches** — `hideMenuOnRoute`, `outletWrapper` exist because it can't handle the full-screen editor mode cleanly

---

## Three Visual Modes

### 1. Column mode (Mail, Contacts, Drive) — 1 row on desktop

Column toolbars render **inside the topbar**, aligned with columns below. Saves 48px vs current.

```
Desktop:
┌─────────────────────────────────────────────────────────────────┐
│ [Logo]  │  [col1 toolbar]  │  [col2 toolbar]       │ [User ▼] │  ← bg-app, h-12
├─────────┼──────────────────┼───────────────────────-┼──────────┤
│ Sidebar │  Column 1        │  Column 2              │          │
│         │  (email list)    │  (email detail)        │          │
│         │                  │                        │          │
└─────────┴──────────────────┴────────────────────────┴──────────┘
```

- Search bars in toolbar get `bg-white/15` styling (like Slack/Teams on colored header)
- Breadcrumbs (Drive) render in the toolbar slot for the list column
- Action icons (reply, delete, etc.) are white ghost buttons on the colored bg
- Empty toolbar slot = empty space above the column (fine)

### 2. Document mode (Docs editor, Stickies board) — 2 rows on desktop

Full-width, no sidebar. Two rows: app chrome (bg-app) + document toolbar (bg-white).

```
Desktop:
┌─────────────────────────────────────────────────────────────────┐
│ [Logo]  │        (document title)                   │ [User ▼] │  ← bg-app, h-12
├─────────┴───────────────────────────────────────────┴──────────┤
│ [File ▼] [Undo] [Redo] │ [formatting tools...]     │ [Share]  │  ← bg-white, h-12
├────────────────────────────────────────────────────────────────-┤
│                                                                 │
│  Editor / Board content (full width)                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Docs and Stickies share the same 2-row structure** for visual consistency
- Row 2 layout: File menu + Undo/Redo on the left, Share on the right, tools in the middle
- Stickies row 2 is sparser (File, Undo/Redo, Share — no formatting buttons), but structurally identical
- Formatting buttons need white bg for readable active/pressed states
- Row 2 content is provided via `secondaryToolbar` prop on `Column`

### 3. Settings mode (Space) — 1 row on desktop

```
Desktop:
┌─────────────────────────────────────────────────────────────────┐
│ [Logo]  │                                           │ [User ▼] │  ← bg-app, h-12
├─────────┼───────────────────────────────────────────┴──────────┤
│ Sidebar │  Content (scrollable)                                 │
└─────────┴───────────────────────────────────────────────────────┘
```

### Mobile — all modes: 2 rows

```
Mobile (all apps):
┌──────────────────────────────┐
│ [☰] [Logo]         [User ▼] │  ← bg-app, h-12
├──────────────────────────────┤
│ [← Back] [toolbar actions]   │  ← bg-white, h-12
├──────────────────────────────┤
│                              │
│  Active column content       │
│  (one column at a time)      │
│                              │
└──────────────────────────────┘
```

- Only one column visible, navigated via `activeColumn` state
- `backTo` prop on Column triggers the back button
- Sidebar opens as overlay from burger icon

---

## Proposed Architecture

### Core idea
Replace `RootLayout` + `AppLayout` + per-app column logic with a single **`AppShell`** that handles all responsive behavior, toolbar placement, and navigation.

### Component hierarchy
```
EigenApp (providers — stays as-is)
  └── Router
        └── __root → AppShell
              ├── Topbar (bg-app)
              │     ├── Left: logo + burger (mobile)
              │     ├── Center: column toolbar slots (desktop, column mode)
              │     └── Right: user dropdown
              ├── SecondaryToolbar (bg-white, document mode only on desktop; all modes on mobile)
              ├── Sidebar (collapsible/overlay, column + settings modes only)
              └── ColumnArea
                    ├── Column 0 (e.g., email list)
                    ├── Column 1 (e.g., email detail)
                    └── ...
```

### New components (all in `packages/ui/src/components/layout/`)

#### 1. `AppShell`
Replaces `RootLayout` + `AppLayout`. Single entry point for every app.

```tsx
// In __root.tsx of any app:
<AppShell
  appName="mail"
  sidebar={<MailSidebar />}
  sidebarMode="collapsible"        // "collapsible" | "hidden" | "none"
>
  <Outlet />
</AppShell>
```

Responsibilities:
- Renders `Topbar` (with merged toolbar slots on desktop in column mode)
- Renders `SecondaryToolbar` when needed (document mode desktop, all modes mobile)
- Manages sidebar state (open/closed/collapsed)
- Provides `LayoutContext` to children

#### 2. `ColumnLayout` + `Column`
Declarative multi-column layout used inside route components.

```tsx
// Column mode example (Mail):
<ColumnLayout>
  <Column id="list" width="400px" toolbar={<SearchBar />}>
    <EmailList />
  </Column>
  <Column id="detail" width="flex" toolbar={<EmailActions />} backTo="list">
    <EmailDetail />
  </Column>
</ColumnLayout>

// Document mode example (Docs editor):
<ColumnLayout>
  <Column
    id="editor"
    width="flex"
    toolbar={<DocTitle />}
    secondaryToolbar={<EditorFormattingToolbar />}
  >
    <CollaborativeEditor />
  </Column>
</ColumnLayout>

// Document mode example (Stickies board):
<ColumnLayout>
  <Column
    id="board"
    width="flex"
    toolbar={<BoardTitle />}
    secondaryToolbar={<StickiesToolbar />}
  >
    <StickiesBoard />
  </Column>
</ColumnLayout>
```

**Column props:**
| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique column identifier |
| `width` | `string` | CSS width (`"400px"`) or `"flex"` |
| `toolbar` | `ReactNode` | Renders in topbar (desktop column mode) or mobile toolbar |
| `secondaryToolbar` | `ReactNode` | Optional. Renders as bg-white row below topbar (desktop document mode). On mobile, replaces `toolbar` in the mobile toolbar bar |
| `backTo` | `string` | Column id to navigate to when back button is pressed (mobile) |

**Desktop behavior (column mode):**
- All columns visible side-by-side
- Each column's `toolbar` is rendered in the topbar, aligned with the column
- No `secondaryToolbar` row (saves 48px)

**Desktop behavior (document mode):**
- Single column, full width, no sidebar
- `toolbar` renders in the topbar (e.g., document title)
- `secondaryToolbar` renders as a white h-12 row below the topbar

**Mobile behavior (all modes):**
- One column visible at a time
- Active column's `toolbar` (or `secondaryToolbar` if present) renders as mobile toolbar
- `backTo` shows a back button

#### 3. `LayoutContext` (replaces `SidebarContext` + `AppContext`)
```ts
type LayoutContextType = {
  appName: string;
  setAppName: (name: string) => void;
  // Sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarMode: 'collapsible' | 'hidden' | 'none';
  // Responsive
  isMobile: boolean;
  isTablet: boolean;
  // Column navigation (mobile)
  activeColumn: string | null;
  navigateToColumn: (id: string) => void;
  goBack: () => void;
  // Toolbar registration (used internally by Column)
  registerToolbar: (columnId: string, content: ReactNode) => void;
  unregisterToolbar: (columnId: string) => void;
  registerSecondaryToolbar: (columnId: string, content: ReactNode) => void;
  unregisterSecondaryToolbar: (columnId: string) => void;
}
```

#### 4. Updated `Topbar`
- Left: app logo + burger menu (mobile only)
- Center: column toolbar slots (desktop, column mode) OR document title (document mode)
- Right: user dropdown
- On mobile: just logo + burger + user dropdown

#### 5. `SecondaryToolbar`
- Desktop document mode: renders the active column's `secondaryToolbar` (bg-white, h-12)
- Mobile (all modes): renders the active column's toolbar + back button (bg-white, h-12)
- Settings mode desktop: not rendered

---

## File Structure (final state)

```
packages/ui/src/components/layout/
  app-shell.tsx              ← NEW: replaces root-layout + app-layout
  layout-context.tsx         ← NEW: replaces app-context + sidebar-context
  column-layout.tsx          ← NEW: ColumnLayout + Column components
  secondary-toolbar.tsx      ← NEW: white toolbar bar (desktop doc mode + mobile)
  topbar.tsx                 ← REWRITE: add column toolbar slots
  sidebar/
    sidebar-container.tsx    ← NEW: responsive sidebar wrapper (overlay/collapse logic)
    sidebar-item.tsx         ← KEEP
    sidebar-section.tsx      ← KEEP
  eigen-app.tsx              ← KEEP (providers)
  app-logo.tsx               ← KEEP
  login-route.tsx            ← KEEP

  # DELETE:
  root-layout.tsx            ← replaced by app-shell
  app-layout.tsx             ← replaced by app-shell
  app-context.tsx            ← replaced by layout-context
```

---

## Per-App Migration

### All apps: `__root.tsx`
Before (6 variations with ad-hoc props):
```tsx
export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: () => <RootLayout rootRoute={Route} hideMenuOnRoute={!!routeMatch} />,
});
```
After (uniform):
```tsx
export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: () => <AppShell appName="mail" sidebar={<MailSidebar />}><Outlet /></AppShell>,
});
```

### All apps: `_auth.tsx`
Auth redirect stays. `AppLayout` wrapper removed (sidebar is in `AppShell`). Just renders `<Outlet />`.

### Mail: `_auth.$filterType.$filterId.tsx`
Replace 300+ line manual flex layout with:
```tsx
<ColumnLayout>
  <Column id="list" width="400px" toolbar={<SearchBar />}>
    <EmailList />
  </Column>
  <Column id="detail" width="flex" toolbar={<EmailActions />} backTo="list">
    <EmailDetail />
  </Column>
</ColumnLayout>
```
- Search bar renders in topbar on desktop (bg-white/15 on colored bg)
- Email action buttons (reply, forward, delete) render in topbar aligned with detail column

### Contacts: `_auth.$filterType.$filterId.tsx`
Same pattern as mail — `ColumnLayout` + 2 `Column`s.

### Drive: `_auth.fs.$ownerId.$mountId.$pathId.tsx`
Refactor `DriveLayout` internals to use `ColumnLayout`. Breadcrumb goes in list column's `toolbar`.

### Docs: `_auth.doc.$ownerId.$mountId.$pathId.tsx`
```tsx
<ColumnLayout>
  <Column
    id="editor"
    width="flex"
    toolbar={<DocTitle />}
    secondaryToolbar={<EditorFormattingToolbar />}
  >
    <CollaborativeEditor />
  </Column>
</ColumnLayout>
```
- `AppShell` uses `sidebarMode="none"` for this route
- Topbar row 1: logo + doc title + user dropdown (bg-app)
- Row 2: File + Undo/Redo + formatting tools + Share (bg-white)

### Stickies: `_auth.board.$ownerId.$mountId.$pathId.tsx`
```tsx
<ColumnLayout>
  <Column
    id="board"
    width="flex"
    toolbar={<BoardTitle />}
    secondaryToolbar={<StickiesToolbar />}
  >
    <StickiesBoard />
  </Column>
</ColumnLayout>
```
- Same 2-row structure as Docs for visual consistency
- Row 2 is sparser (File, Undo/Redo, Share) but identical layout

### Docs/Stickies: file-browser routes (`_auth._sidebar.*`)
These use `sidebarMode="collapsible"` — sidebar + single column with file list. No `secondaryToolbar`.

### Space
Simple: sidebar + single content column with no toolbar. Trivial migration.

---

## Restrictions & Rules

1. **Columns don't nest** — `ColumnLayout` is always a flat list of `Column` children
2. **Max 2 content columns** (sidebar excluded) — sidebar + up to 2 content columns
3. **Topbar height is fixed** — Always h-12 (48px). No growing. Toolbar content must fit.
4. **Column `width`** — either a fixed CSS value (`"400px"`, `"350px"`) or `"flex"` (takes remaining space). Only one column should be `"flex"`
5. **Mobile shows one column** — use `activeColumn` state + `backTo` for navigation
6. **Sidebar is always the leftmost element** — it's part of `AppShell`, not a `Column`
7. **No `isMobile`/`isTablet` in app code** — use `LayoutContext` or let `ColumnLayout` handle it
8. **`secondaryToolbar` only for document-mode apps** — Docs and Stickies use it; column-mode apps don't

---

## Implementation Order

1. **`layout-context.tsx`** — new context combining sidebar, app, responsive, toolbar registration
2. **`sidebar-container.tsx`** — extract sidebar responsive logic from current `app-layout.tsx`
3. **`column-layout.tsx`** + **`Column`** — declarative column system with `toolbar` + `secondaryToolbar`
4. **`secondary-toolbar.tsx`** — white toolbar bar (desktop document mode + all mobile)
5. **`topbar.tsx` rewrite** — add column toolbar slots for desktop column mode
6. **`app-shell.tsx`** — assemble everything: topbar + secondary-toolbar + sidebar + column area
7. **Migrate Mail** — first app, validates the system (most complex multi-col layout)
8. **Migrate Contacts** — similar to mail, quick
9. **Migrate Drive** — refactor `DriveLayout` internals
10. **Migrate Docs** — dual-mode (sidebar+list vs full editor with secondaryToolbar)
11. **Migrate Stickies** — same structure as docs
12. **Migrate Space** — simplest, sidebar + content
13. **Delete old components** — `root-layout.tsx`, `app-layout.tsx`, `app-context.tsx`
14. **Run typecheck** — verify everything compiles

---

## Design Decisions

1. **Three visual modes** — Column mode (1 topbar row, toolbars in topbar), Document mode (2 rows: topbar + white secondary toolbar), Settings mode (1 topbar row, no toolbars)
2. **Toolbar alignment** — Strict column-alignment: each column's toolbar slot in the topbar uses the exact same width as the column below
3. **Toolbar content is unrestricted** — Can contain action buttons, search fields, breadcrumbs, or editor formatting tools. Topbar height stays fixed at h-12
4. **Docs and Stickies are visually consistent** — Both use 2-row layout with identical structure (File + tools left, Share right). Stickies is sparser but same layout
5. **Column widths are static** — Fixed per-app widths. Future-proofed for drag-resize: just swap static width for stateful width + drag handle. No architecture change needed
6. **No animations** — Mobile column transitions are instant show/hide. Future-proofed: `activeColumn` + `goBack()` already know direction for later `AnimatePresence` / CSS transitions
7. **Keep it simple** — Minimal API surface. `Column` with `toolbar` + optional `secondaryToolbar` is the only new concept apps need to learn
