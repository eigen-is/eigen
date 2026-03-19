# Code Review: packages/ui

## Summary

`packages/ui` provides the shared component library: app shell, layout system, providers, list hooks, sidebar, drive UI,
chat components, labels, and shadcn/ui primitives. The architecture is well-designed -- `AppShell` + `ColumnLayout`
provide a consistent responsive pattern, providers are cleanly stacked, and list hooks are composable. The main concerns
are XSS vulnerabilities in two components, several `"use client"` directives, hardcoded colors in a few places, and
some components that are over-fetching data by calling multiple hooks internally.

## Critical Issues

### 1. `DeleteDialog` renders user-provided `itemName` as raw HTML

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/delete/delete-dialog.tsx`, lines
27-28, 36
**Issue**: `formattedDescription` interpolates `itemName` into an HTML string with `<b>` tags and then renders it
unsafely via `dangerouslySetInnerHTML`. File/folder names are user-controlled content. A malicious filename containing
script-executing HTML attributes would execute JavaScript when another user opens the delete dialog.
**Impact**: Stored XSS -- an attacker can upload a file with a malicious name, and any user who attempts to delete it
triggers script execution in their browser.
**Fix**: Replace with React elements:

```tsx
<DialogDescription>
    {description} <strong>{itemName}</strong>? This action cannot be undone.
</DialogDescription>
```

### 2. `ShadowContent` assigns untrusted HTML to DOM without sanitization

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/shadow-content.tsx`, line 51
**Issue**: When `contentType === "html"`, the component assigns raw HTML content directly to a DOM element. This is used
for rendering email bodies. Shadow DOM provides style isolation but NOT script isolation -- event handlers in HTML
attributes (e.g., `onerror`, `onload`, `onmouseover`) execute in the main document context.
**Impact**: XSS via malicious email content. Any received email with crafted HTML can execute arbitrary JavaScript.
**Fix**: Integrate DOMPurify (or equivalent) to sanitize HTML before DOM insertion.

### 3. `ShadowContent` uses `@ts-ignore` and `as any` to store shadow root

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/shadow-content.tsx`, lines 32-42
**Issue**: The component stores the shadow root in `(hostElement as any)._shadowRoot` and suppresses TypeScript errors
with `@ts-ignore`. CLAUDE.md: "Never use `as any`." This pattern creates a hidden property on a DOM element, making
the code hard to reason about.
**Impact**: Type safety violation. If the ref or element type changes, this will silently break.
**Fix**: Use a `useRef<ShadowRoot | null>(null)` alongside the host ref to store the shadow root reference, eliminating
both the `as any` cast and the `@ts-ignore`.

## Pattern Violations

### 4. `"use client"` directives across 8 files

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/sse-provider/sse-provider.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-provider.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-container.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/preview-provider/preview-provider.tsx`, line
  1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-avatar.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, line 1
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, line 1

**Issue**: CLAUDE.md: "No `"use client"` directives -- this is a Vite project, not Next.js. The directive is a no-op."
**Fix**: Remove all `"use client"` directives from these files.

### 5. `interface` instead of `type` in multiple files

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, line 16
  (`interface EigenAppProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/topbar.tsx`, lines 28, 30
  (`interface TopbarProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/app-logo.tsx`, line 9
  (`interface AppLogoProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/labels/label-provider.tsx`, lines 7, 28
  (`interface LabelContextType`, `interface LabelProviderProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/labels/label-dialog.tsx`, line 36
  (`interface LabelDialogProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/shadow-content.tsx`, line 4
  (`interface ShadowContentProps`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/context-menu/context-menu-anchor.tsx`, line 4
  (`interface ContextMenuAnchorProps`)

**Issue**: CLAUDE.md: "Always `type` over `interface` -- except when methods are needed." None of these need methods.
**Fix**: Convert all to `type` aliases.

### 6. Hardcoded colors in `StorageUsage` and `MountForm`

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/home/usage.tsx`, lines 21-22
  (`"bg-red-500"`, `"bg-yellow-500"`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/mount/mount-form.tsx`, line 220
  (`"text-green-600 dark:text-green-400"`)

**Issue**: CLAUDE.md: "Use theme tokens, not hardcoded colors -- use `text-muted-foreground`, `bg-muted`, `border` etc.
instead of `text-gray-500`, `bg-blue-50`. Hardcoded colors break dark mode."
**Impact**: These colors may not render well in dark mode. The `bg-red-500` for storage warnings and `text-green-600`
for
S3 connection success use raw Tailwind color values that don't adapt to the theme.
**Fix**: Use `text-destructive` / `bg-destructive` for error/warning states and define success token or use existing
theme tokens with opacity for success states.

### 7. `any` types in AppShell and Topbar

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/app-shell.tsx`, line 12
  (`(...args: any[]) => any`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/topbar.tsx`, line 28
  (`type NavigateFunction = (...args: any[]) => any`)

**Issue**: CLAUDE.md: "Never use `as any`." While these are in type annotations rather than casts, using `any` defeats
TypeScript's type checking for the navigate function.
**Fix**: Use `unknown` or import TanStack Router's actual navigate type.

## Security Concerns

### 8. `uploadWithProgress` ignores custom headers

**File**:
`/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx`,
lines 28-30
**Issue**: The `headers` parameter is accepted but the code that sets them is commented out. The function accepts a
`headers` param (renamed to `_headers`) but never applies them to the XHR request.
**Impact**: Any security headers (e.g., CSRF tokens) that callers expect to be sent are silently dropped. Currently,
`withCredentials: true` sends cookies, but if header-based auth is ever needed, this would be a security hole.
**Fix**: Either apply the headers or remove the parameter to avoid false confidence.

### 9. `ContextMenuAnchor` position state is unused

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/context-menu/use-context-menu.ts`
**Issue**: The context menu state stores `position: {x: e.clientX, y: e.clientY}` from the mouse event. However,
`ContextMenuAnchor` (context-menu-anchor.tsx) uses a hidden `DropdownMenuTrigger` and doesn't actually position at those
coordinates -- the position state appears unused.
**Impact**: No security issue, but unused state suggests incomplete implementation. If the position is meant to anchor
the menu at click coordinates, this isn't working.
**Fix**: Either use the position coordinates (e.g., with CSS transform on the anchor) or remove the position state.

## Data Integrity

### 10. `UploadProvider` `removeUpload` reads from closure that could go stale

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-provider.tsx`,
lines 86-90
**Issue**: The `removeUpload` function inside `contextValue` reads `uploads` from the outer closure. But `contextValue`
is never memoized -- it's created fresh on every render -- so the `uploads` reference is always current. However, if
this
is ever wrapped in `useMemo` or `useCallback`, it will capture a stale `uploads` value.
**Impact**: Currently works, but fragile. Any future performance optimization (adding `useMemo` around `contextValue`)
would break the cancel-on-remove logic.
**Fix**: Use functional updater to find the upload inside the `setUploads` callback, or use a ref for the uploads array.

### 11. `PreviewProvider` navigation is bounded correctly but buttons may not be disabled

**File**:
`/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/preview-provider/preview-provider.tsx`,
lines 56-64
**Issue**: When navigating siblings, `nextIdx < 0 || nextIdx >= prev.siblings.length` causes early return (no
navigation). The `hasPrev`/`hasNext` props are computed (lines 81-82) and should disable the buttons. This is correctly
implemented as long as `FilePreview` properly disables the navigation buttons when `hasPrev`/`hasNext` are `false`.
**Impact**: Minor UX concern -- verify `FilePreview` uses these props.
**Fix**: Verify that `FilePreview` disables or hides Prev/Next buttons when `hasPrev`/`hasNext` are `false`.

### 12. `SidebarContainer` z-index ordering may block overlay click on mobile

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/sidebar/sidebar-container.tsx`,
lines 26-42
**Issue**: The sidebar content div uses `z-50` and the overlay div uses `z-40`. On mobile, the sidebar content covers
the full screen (`fixed inset-0`), which means the overlay (behind it at lower z-index) is unreachable. The sidebar
content itself handles closing via the `SidebarHeader`'s X button, but clicking on the overlay to dismiss is a common
mobile pattern that appears broken here.
**Impact**: On mobile, clicking outside the sidebar to close it may not work because the sidebar div covers the overlay.
**Fix**: Restructure so the sidebar content doesn't cover the full viewport, or swap z-indices, or add a click handler
inside the sidebar container that closes on clicks outside the sidebar content area.

## Code Quality

### 13. Triplicated user-resolution logic in `UserAvatar`, `UserItem`, `UserName`

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-avatar.tsx`, lines 33-44
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, lines 35-48
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, lines 32-43

**Issue**: All three components independently:

1. Call `useContacts()` to get all contacts
2. Call `usePublicUser()` with `userId || email`
3. Call `usePublicConfig()` and `usePeopleTeams(org?.orgId)` for team name resolution
4. Compute `displayName` with identical fallback chains

This is ~15 lines of identical logic repeated 3 times, plus 4 network-backed hooks fired per component instance.
**Impact**: Maintenance risk (must update 3 files for name resolution changes) and potential performance overhead (when
`UserItem` renders alongside `UserAvatar`, 8 hooks fire for a single user display).
**Fix**: Extract a `useResolvedUser(userId?, email?)` hook returning
`{displayName, resolvedEmail, avatarSrc, isLoading}`
and share across all three components.

### 14. `UserItem` and `UserName` have unused `autoFetch` and `imageUrl` props

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, line 22 (`autoFetch`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, lines 13-14
  (`imageUrl`, `autoFetch`)

**Issue**: These props are declared in the type but never used in the component body.
**Impact**: Dead code. Contributors may pass these props expecting them to do something.
**Fix**: Remove unused props from the type definitions.

### 15. `EigenApp` creates `QueryClient` at module scope

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, line 21
**Issue**: `const queryClient = new QueryClient()` is created at module scope, outside the component. While this works
in a single-app SPA, it means all apps share the same `QueryClient` instance if they're loaded in the same JS context
(e.g., in tests or micro-frontend setups). TanStack Query recommends creating it inside the component (with `useRef` or
`useState`) to avoid shared state across React trees.
**Impact**: Low in production (each app is a separate page load), but could cause test interference.
**Fix**: Create inside the component: `const [queryClient] = useState(() => new QueryClient())`.

### 16. `Toolbar` component has redundant fixed height

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/toolbar/toolbar.tsx`, line 5
**Issue**: `Toolbar` sets `h-12` but `Column` already wraps the toolbar slot in a `h-12` div (column-layout.tsx line
36).
This double-height constraint is redundant.
**Impact**: No visual issue since both are `h-12`, but if one changes, the other may fight it.
**Fix**: Remove `h-12` from `Toolbar` since the `Column` wrapper already constrains it.

### 17. `AppLogo` renders inline component `LogoContent` inside render body

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/app-logo.tsx`, line 40
**Issue**: `const LogoContent = () => (...)` is defined inside the `AppLogo` render body. This creates a new component
reference on every render, causing React to unmount and remount the subtree each time.
**Impact**: Subtle -- may cause focus loss, animation restarts, or flickering in the logo area.
**Fix**: Move `LogoContent` outside the component or inline the JSX directly (since it's only used once in each branch).

### 18. `printElement` uses `setTimeout` with magic number

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/lib/printElement.ts`, line 21
**Issue**: `setTimeout(() => { window.print(); ... }, 450)` uses a 450ms delay with no explanation of why this specific
duration was chosen. This is fragile -- on slower machines, the DOM may not be ready.
**Impact**: Print may fire before the cloned element is fully laid out, especially on complex documents.
**Fix**: Add a comment explaining the delay (waiting for layout recalculation) or use `requestAnimationFrame` for a more
reliable approach.

### 19. Duplicate re-export in `packages/ui/src/index.ts`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/index.ts`, lines 7 and 9
**Issue**: `export * from './components/layout/user-item'` appears on both line 7 and line 9. This is harmless (JS
ignores duplicate re-exports) but clutters the barrel file.
**Fix**: Remove the duplicate line.

### 20. `useIsMobile` duplicated between packages

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/media/hooks/use-media-query.ts`, line 28 (`useIsMobile`)
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/hooks/use-mobile.ts` (re-exports from lib)

**Issue**: `packages/ui/src/hooks/use-mobile.ts` simply re-exports from `@workspace/lib/media`. The `app-logo.tsx`
imports from `../../../hooks/` (the ui version) while `app-shell.tsx` imports from `@workspace/lib/media` (the lib
version). Both resolve to the same code, but having two import paths for the same hook is confusing.
**Impact**: No functional issue, but two import paths for one hook.
**Fix**: Standardize on one import path. Since the canonical location is `packages/lib`, import from
`@workspace/lib/media` everywhere and remove the re-export from `packages/ui/src/hooks/use-mobile.ts`.

## Architecture

### 21. `UserAvatar`/`UserItem`/`UserName` call `useContacts()` -- fetches ALL contacts for name resolution

**Files**:

- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-avatar.tsx`, line 33
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-item.tsx`, line 35
- `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/user-name.tsx`, line 32

**Issue**: Every `UserAvatar`, `UserItem`, and `UserName` instance calls `useContacts()`, which fetches the entire
contacts list. On a page that displays a list of users (e.g., ACL list, chat messages), this triggers the contacts
query once per React render cycle. While TanStack Query deduplicates concurrent requests and caches the result, the
first render of a page with many user components will fire the contacts query, which may return a large payload.
**Impact**: Performance -- downloading the full contacts list just to check if one email matches a contact name is
inefficient. For pages with many user components, this is wasteful.
**Fix**: Consider a lookup hook that accepts a single email and checks the cached contacts list, or use a dedicated
"resolve user by email" API endpoint that the server can optimize.

### 22. Provider nesting order means `ThemeProvider` depends on `AuthProvider`

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/eigen-app.tsx`, lines 36-37
**Issue**: `ThemeProvider` is inside `AuthProvider`, and it calls `useSpaceSettings()` which calls
`useAuth()` internally. This means theme is only applied after authentication completes. During the loading screen
(while `AuthProvider` is checking the session), no theme is applied.
**Impact**: Users see an unstyled (light mode) loading screen even if their preference is dark mode, followed by a
flash when the theme applies after auth resolves.
**Fix**: Read theme preference from a cookie or localStorage before auth resolves, apply it immediately, then sync with
server settings once auth completes.

### 23. `UploadProvider` `contextValue` is not memoized

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/upload-provider/upload-provider.tsx`,
lines 33-92
**Issue**: The `contextValue` object is created fresh on every render because it's not wrapped in `useMemo`. This means
all consumers of `useUpload()` re-render on every `UploadProvider` state change, even if the upload functions haven't
changed.
**Impact**: Unnecessary re-renders of all upload consumers whenever any upload's progress updates. Since `createUpload`
and `removeUpload` reference `uploads` state, memoization requires careful dependency tracking, but the `createUpload`
function doesn't actually read `uploads` and could be memoized separately.
**Fix**: Split stable functions (createUpload) into a ref-based pattern and memoize the context value.

### 24. `ColumnLayout` uses string-based `mobileColumn` matching

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/app/column-layout.tsx`, line 25
**Issue**: `if (isMobile && mobileColumn !== null && mobileColumn !== id) return null` compares string IDs. If a
developer misspells the `id` on a `Column` or `mobileColumn` on `ColumnLayout`, columns silently disappear on mobile
with no error or warning.
**Impact**: Silent breakage on mobile. Hard to debug since it works fine on desktop.
**Fix**: In development mode, log a warning if `mobileColumn` doesn't match any child `Column` `id`.

## Positive Patterns

- **`AppShell` + `ColumnLayout`** provide an excellent responsive pattern. Desktop shows all columns; mobile shows only
  the selected one with back navigation. Simple API, powerful result.
- **List hooks are composable** -- `useListSelection` + `useKeyboardListNavigation` + `useListDrag` + `useContextMenu`
  can be combined incrementally. Each hook is independent and well-typed.
- **Provider stack in `EigenApp`** is clean and well-ordered. Auth -> SSE -> Upload -> Preview -> Toaster is a logical
  dependency chain.
- **`SidebarItem`** smartly supports both `Link` (for navigation) and `Button` (for actions) rendering through a single
  `to` prop check. Active state handling via TanStack Router's `activeProps` is elegant.
- **`DroppableSidebarItem`** is a clean composition -- wraps `SidebarItem` with drop target behavior without modifying
  the original component.
- **CSS class-based list styling** (`eigen-list-item`, `eigen-list-item-active`, etc.) in `globals.css` provides
  consistent list appearance across all apps while keeping components style-agnostic.
- **`PreviewProvider`** handles sibling navigation, aspect ratio preservation, and preview mode detection cleanly.
- **`useListSelection`** correctly handles anchor-based range selection with Shift+Click, a commonly misimplemented
  feature.
- **Theme token usage** is generally consistent -- `text-muted-foreground`, `bg-muted`, `text-foreground` are used
  throughout most components.

## Recommendations

### P0 (Fix immediately -- bugs or security issues)

1. **Sanitize HTML in `DeleteDialog`** (item 1) -- replace with React elements
2. **Sanitize HTML in `ShadowContent`** (item 2) -- integrate DOMPurify
3. **Remove `as any` and `@ts-ignore` in `ShadowContent`** (item 3) -- use refs instead

### P1 (Fix soon -- pattern violations and maintainability)

4. **Remove `"use client"` directives** (item 4) -- 8 files, simple cleanup
5. **Convert `interface` to `type`** (item 5) -- 7+ interfaces to convert
6. **Replace hardcoded colors with theme tokens** (item 6) -- `StorageUsage`, `MountForm`
7. **Fix `any` types in `AppShell`/`Topbar`** (item 7)
8. **Extract `useResolvedUser` hook** (item 13) -- eliminates triplicated logic
9. **Remove unused props from `UserItem`/`UserName`** (item 14)
10. **Fix `AppLogo` inline component** (item 17)
11. **Memoize `UploadProvider` context value** (item 23)

### P2 (Nice to have -- cleanup and consistency)

12. **Apply or remove `headers` parameter in `uploadWithProgress`** (item 8)
13. **Move `QueryClient` creation inside component** (item 15)
14. **Remove duplicate re-export in `index.ts`** (item 19)
15. **Standardize `useIsMobile` import path** (item 20)
16. **Fix sidebar z-index overlap on mobile** (item 12)
17. **Add dev-mode warning for mismatched `mobileColumn` IDs** (item 24)
18. **Apply theme before auth resolves** (item 22)
19. **Fix `Toolbar` redundant height** (item 16)
20. **Add comment or fix `printElement` timeout** (item 18)
