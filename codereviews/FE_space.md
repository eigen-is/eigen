# Frontend Code Review: Space App (User Settings & Profile)

## Summary

The Space app provides user-facing account management: profile editing, password changes, 2FA setup, data export, and
an app launcher home page. It has 7 route files, 6 components, and a sidebar. The app is relatively small and
straightforward. Overall quality is decent, but there are several notable issues around code hygiene, data fetching
patterns, and a few architectural deviations.

## Architecture Compliance

**Passing:**
- No direct `useQuery`/`useMutation` imports in app code -- all data hooks come from `@workspace/lib`.
- Proper `AppShell` + `SidebarSection` + `SidebarItem` layout usage.
- Auth guard in `_auth.tsx` with redirect-to-login pattern.
- Login route uses the shared `createLoginRouteOptions()` factory.
- `EigenApp` provider stack in `main.tsx`.

**Deviations:**
- Profile editor (`profile-editor.tsx`) fetches contact data with a manual `useEffect` + `getMeContact()` call instead
  of using a TanStack Query hook. This bypasses the cache and SSE invalidation entirely.
- `"use client"` directive appears in 3 component files (`fa2.tsx`, `login-fa2.tsx`, `change-password.tsx`). This is a
  Next.js/RSC directive that has no meaning in Vite+React and is dead code.
- `interface` used in 3 non-generated files where `type` is prescribed by project rules.

## Issues Found

### Critical

None.

### Important

1. **Profile editor uses imperative fetch instead of a query hook**
   `apps/space/src/components/space/profile-editor.tsx`, lines 48-65.
   `getMeContact()` is called inside a `useEffect` with manual `isLoading`/`error` state. This means:
   - No cache sharing with other components that might need the same contact.
   - No automatic refetch on SSE events.
   - No stale-while-revalidate behavior.
   This should be a `useQuery`-based hook in `packages/lib/src/core/contacts/hooks/`.

2. **Dutch TODO comment left in production code**
   `apps/space/src/components/space/login-fa2.tsx`, line 62:
   `// TODO: Reinder, dit moet misschien anders`
   Violates the "English everywhere" rule. Also indicates the `window.location.reload()` approach for post-2FA
   login may not be the intended long-term solution.

3. **Debug `console.log` statements left in route handlers**
   - `apps/space/src/routes/_auth.security.2fa.tsx`, line 32: `console.log(result.error)` -- logs error object
     on 2FA init failure, but the toast already shows the error. This is debug output.
   - `apps/space/src/routes/_auth.security.password.tsx`, line 14: `console.log(result)` -- logs the entire
     password change result. Likely leftover debug code.

4. **`"use client"` directives are meaningless in this project**
   `apps/space/src/components/space/fa2.tsx:1`, `login-fa2.tsx:1`, `change-password.tsx:1`.
   The project uses Vite, not Next.js. These directives have no effect and should be removed.

5. **App icon rendering is hardcoded SVG path instead of using actual app icons**
   `apps/space/src/routes/_auth.index.tsx`, lines 46-60.
   Every app card renders the same SVG (a `<>` code bracket icon) regardless of the actual app. The `app.icon`
   field from the apps list is ignored. This means all apps display identical icons on the home page.

### Minor

1. **`interface` used where `type` is preferred**
   - `apps/space/src/routes/_auth.index.tsx:10` -- `interface AppItem`
   - `apps/space/src/routes/__root.tsx:6` -- `interface MyRouterContext`
   - `apps/space/src/components/space/space-sidebar.tsx:8` -- `interface SpaceSidebarProps`
   The project convention is `type` over `interface` except when methods are needed.
   Note: `MyRouterContext` may be acceptable since it follows TanStack Router conventions.

2. **Avatar upload has potential double-processing of response**
   `apps/space/src/components/space/profile-editor.tsx`, lines 169-195.
   `uploadWithProgress` is given an `onSuccess` callback that calls `setAvatar(response)`, but then after the
   await, the code also checks `if (response.ok)` and calls `setAvatar(responseData)`. If `onSuccess` fires first,
   the avatar is set twice. The two code paths could conflict.

3. **Password change handler doesn't await the promise**
   `apps/space/src/routes/_auth.security.password.tsx`, line 13.
   `handlePasswordChange` is async and calls `onPasswordChange` which returns a promise, but the `navigate` after
   `toast.success` does not explicitly return the navigate promise. Minor -- the 350ms delay mitigates this.

4. **Magic number 350ms appears in multiple places**
   `_auth.security.2fa.tsx:52`, `_auth.security.password.tsx:19`, `login-fa2.tsx:60`.
   The artificial delay before navigation is copy-pasted across 3 files. Should be extracted to a constant or utility.

5. **`min-h-screen` used alongside flex layout**
   Routes `_auth.data.tsx`, `_auth.security.2fa.tsx`, `_auth.security.password.tsx`, `_auth.user.tsx` all use
   `min-h-screen` which may cause overflow issues when combined with the AppShell's own height management.

## Recommendations

1. Create a `useMeContact()` hook in `packages/lib/src/core/contacts/hooks/` and use it in the profile editor
   instead of the manual `useEffect` fetch pattern.
2. Remove all `"use client"` directives from the three component files.
3. Remove `console.log` debug statements from the 2FA and password routes.
4. Fix the app icon rendering on the home page to use actual per-app icons from the `apps` list.
5. Resolve the Dutch TODO in `login-fa2.tsx` and replace `window.location.reload()` with proper auth state refresh.
6. Replace `interface` with `type` in non-generated files per project convention.
7. Extract the 350ms navigation delay pattern into a shared utility (e.g., `delayedNavigate`).
