# Frontend Refactoring Plan

## Current State

Each frontend app (mail, drive, contacts, docs, stickies, space, index) contains significant code duplication across boilerplate files. This document catalogs the duplication and outlines a pragmatic cleanup plan.

## Duplication Map

### 1. `main.tsx` — 7 near-identical files

Mail, drive, docs, stickies, space are byte-for-byte identical except for `basepath` and `appName`. Contacts adds `LabelProvider`. Index sets up providers manually (doesn't use `EigenApp`).

**Bugs found:**
- `contacts/main.tsx` has `declare module '@tanstack/react-router'` duplicated twice
- `index/main.tsx` has the same duplicate `declare module` block
- `index/main.tsx` creates `QueryClient` inside the `App()` render function (new instance every render)

### 2. `__root.tsx` — 6 copies of the same pattern

Every app defines the same `SidebarContext`, `MyRouterContext`, and root component with `Topbar` + `SidebarContext.Provider` + `Outlet`. Minor variations:
- **docs/stickies**: add `useMatch` to conditionally hide mobile menu when viewing a document
- **contacts/space**: extract a named `RootComponent` (others use inline arrow)
- **contacts**: wraps `Outlet` in `<div className="flex-1 overflow-hidden">`
- **space**: wraps `Outlet` in `<div className="flex-1 overflow-auto">`

### 3. `_auth.tsx` — The sidebar layout pattern (biggest duplication)

5 apps (mail, drive, contacts, space + docs/stickies via `_auth._sidebar.tsx`) copy-paste the exact same responsive sidebar layout:

```
<div className="flex flex-1 w-full h-full overflow-hidden">
    <div className={isMobile ? overlay : block, isTablet ? w-16 : w-64, border-r}>
        <AppSpecificSidebar condensed={isTablet} isMobile={isMobile} onClose={...} />
    </div>
    {isMobile && sidebarOpen && <backdrop />}
    <main className="flex-1 flex h-full overflow-hidden">
        <Outlet />
    </main>
</div>
```

Only the sidebar component differs. Drive/docs/stickies add `DriveContext.Provider` + root folder loading.

### 4. `login.tsx` — 6 identical files

Only difference is the `fallback` path (`/box/inbox`, `/`, `/book/all`, etc.).

### 5. `css/globals.css` — identical 8-line pattern per app

Each maps `.bg-app` and `.text-app` to a CSS variable like `var(--app-mail-color)`.

### 6. Boilerplate files — identical across apps

`components.json`, `index.html`, `css.d.ts`, `tsconfig.json` are pure copies.

### 7. Mobile sidebar header — duplicated in every sidebar component

Every sidebar repeats the same mobile header block with close button and `AppLogo`.

### 8. Space sidebar bug

`space-sidebar.tsx` shows `<AppLogo appName="drive"/>` instead of `"space"`.

---

## Cleanup Plan

### A. Quick fixes ✅

| # | What | Where |
|---|------|-------|
| A1 | Fix Space sidebar showing "drive" logo | `apps/space/src/components/space/space-sidebar.tsx` |
| A2 | Remove duplicate `declare module` in contacts/main.tsx | `apps/contacts/src/main.tsx` |
| A3 | Remove duplicate `declare module` in index/main.tsx | `apps/index/src/main.tsx` |
| A4 | Fix `QueryClient` created inside render in index | `apps/index/src/main.tsx` |

### B. Shared root layout

Move `SidebarContext` and `MyRouterContext` to `packages/ui`. Create a shared `RootLayout` component that each app's `__root.tsx` can use, reducing each to ~5 lines.

### C. Shared AppLayout (highest impact)

Create a generic `AppLayout` component in `packages/ui` that handles:
- Mobile/tablet/desktop responsive sidebar logic
- Sidebar open/close state from `SidebarContext`
- Backdrop overlay on mobile
- The flex layout structure

Each app passes its sidebar as a prop. Reduces 60-100 line `_auth.tsx` files to ~10 lines.

### D. Login route factory (future)

Create a shared function that generates the login route given a fallback path.

### E. Dynamic app CSS (future)

Set `--app-color` dynamically in `EigenApp` based on `appName` instead of per-app CSS files.

### F. Sidebar mobile header component (future)

Extract the mobile header into a shared `SidebarMobileHeader` component.

### G. Template main.tsx (future)

Create a bootstrap factory so each app's `main.tsx` is ~5 lines.

---

## Estimated Impact

| Item | Files affected | Lines saved (est.) |
|------|---------------|-------------------|
| A. Quick fixes | 3 files | ~15 |
| B. Shared root layout | 6 `__root.tsx` | ~200 |
| C. Shared AppLayout | 6 `_auth.tsx` | ~350 |
| D. Login route factory | 6 `login.tsx` | ~80 |
| E. Dynamic app CSS | 10 `globals.css` | ~70 |
| F. Sidebar mobile header | 5 sidebars | ~50 |
| G. Template main.tsx | 7 `main.tsx` | ~250 |

**Total: ~1,000 lines of duplicated code eliminated.**
