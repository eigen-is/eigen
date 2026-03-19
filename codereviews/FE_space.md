# Frontend Review: Space App (User Settings, Profile)

**Scope:** `apps/space/`, `packages/lib/src/core/space/`
**Reviewed:** 2026-03-19

The Space app handles user account management: profile editing, password changes, 2FA setup, data export, and an app
launcher home page. It has 8 route files, 6 components, a sidebar, and `main.tsx`. Shared library support lives in
`packages/lib/src/core/space/` (settings hooks + SSE handler) and `packages/lib/src/core/contacts/hooks/` (profile
data).

Architecture compliance is generally good: proper `AppShell` + `SidebarSection` + `SidebarItem` usage, auth guard in
`_auth.tsx`, login route via shared `createLoginRouteOptions()` factory, correct `EigenApp` provider stack, and the
`useUpdateContact` hook from `packages/lib` is used for mutations. Several issues from the 2026-03-18 review have been
fixed (revokeOtherSessions passthrough, missing await in onSubmit, avatar double-processing, TOTP string splitting,
invalid Tailwind class, Dutch comment, hardcoded info box colors, debug console.log statements). The remaining issues
and newly discovered ones are documented below.

---

## Critical Issues

### C1. `enableTwoFactor` toggle is cosmetic -- the backend always enables 2FA

**File:** `apps/space/src/routes/_auth.security.2fa.tsx:41-48`

The `handleVerifyTotp` function accepts an `enableTwoFactor: boolean` parameter from the form, but it is only used to
construct the toast message string:

```ts
toast.success('Two-factor authentication ' + (enableTwoFactor ? 'enabled' : 'disabled'));
```

The parameter is never passed to `authClient.twoFactor.verifyTotp()` on line 43-44, which only receives `{ code }`.
The `verifyTotp` call unconditionally enables 2FA on the backend. A user who toggles the switch to OFF, enters their
code, and submits will see "Two-factor authentication disabled" in the toast -- while 2FA is actually enabled on their
account.

**Impact:** The UI lies to the user. Someone who believes they disabled 2FA will be locked out on their next login if
they discard their authenticator app.

**Fix:** Either remove the `enableTwoFactor` toggle entirely (since `verifyTotp` always enables), or -- if the backend
supports a disable flow -- pass the flag to the API. The current UI presents a control that cannot fulfill its promise.

---

## Important Issues

### I1. Profile editor uses imperative fetch instead of a query hook

**File:** `apps/space/src/components/space/profile-editor.tsx:48-65`
**Carried from previous review.**

`getMeContact()` is called inside a `useEffect` with manual `isLoading`/`error`/`contact` state. This bypasses
TanStack Query's cache, stale-while-revalidate, and SSE-driven invalidation. The project rule "Never use
`useQuery`/`useMutation` directly in apps" is satisfied (no direct `useQuery`), but the spirit of the rule -- that all
data fetching goes through shared hooks in `packages/lib` -- is violated.

**Impact:** No cache sharing, no automatic refetch on data changes, manual state management that duplicates what
TanStack Query provides.

**Fix:** Create a `useMeContact()` hook in `packages/lib/src/core/contacts/hooks/use-contacts.ts` wrapping
`getMeContact` in `useQuery`, and use it in the profile editor.

### I2. Custom toggle div is inaccessible -- should use the existing Switch component

**File:** `apps/space/src/components/space/fa2.tsx:283-290`
**Carried from previous review.**

The 2FA verification step renders a hand-crafted toggle using a plain `<div>` with an `onClick` handler. This div has:
- No `role="switch"` attribute.
- No `tabIndex`, so it cannot be focused via keyboard.
- No `onKeyDown` handler for Space/Enter.
- No `aria-checked` attribute.

The project already has a proper accessible `Switch` component at `packages/ui/src/components/switch.tsx` built on
`@radix-ui/react-switch` that handles all of this.

**Impact:** Keyboard-only and screen reader users cannot interact with the 2FA enable/disable toggle.

**Fix:** Replace the custom div toggle with `<Switch checked={field.value} onCheckedChange={field.onChange} />` from
`@workspace/ui/components/switch`.

### I3. `window.location.reload()` used as auth state workaround after 2FA login

**File:** `apps/space/src/components/space/login-fa2.tsx:62-63`
**Carried from previous review (was I5).**

After successful 2FA verification during login, the code does `window.location.reload()` instead of properly updating
the auth context. The TODO comment (now in English: "this might need a different approach") acknowledges the hack.
This discards all client-side state and forces a full page reload.

**Impact:** Poor UX (full page reload). Loss of any in-memory state.

**Fix:** Replace `window.location.reload()` with proper auth state refresh (e.g., invalidating the auth query or
calling a session refresh method on the auth client).

### I4. App home page renders identical icons for every app

**File:** `apps/space/src/routes/_auth.index.tsx:46-60`
**Carried from previous review (was I6).**

Every app card renders the same hardcoded SVG (a code-bracket `<>` icon). The `app.icon` field from
`packages/lib/src/core/apps.ts` (which contains Lucide icon names like `'calendar'`, `'mail'`, `'hard-drive'`) is
completely unused. All apps appear visually identical on the home page.

**Impact:** The app launcher provides no visual differentiation between apps.

**Fix:** Use a Lucide icon lookup or mapping to render the correct icon per app based on the `app.icon` string.

### I5. Password strength meter uses hardcoded colors that break dark mode

**File:** `apps/space/src/components/space/change-password.tsx:43-47`

```ts
const getPasswordStrengthColor = (strength: number): string => {
    if (strength < 0.4) return "bg-red-500";
    if (strength < 0.7) return "bg-yellow-500";
    return "bg-green-500";
};
```

The project rule is "Use theme tokens, not hardcoded colors." While semantic red/yellow/green makes sense for a
strength meter, these hardcoded Tailwind color classes will clash with dark mode backgrounds. The theme provides
`bg-destructive` for errors and other tokens.

**Impact:** Visual inconsistency in dark mode. Violates project style rule.

**Fix:** Use theme-aware variants, e.g., `bg-destructive` for weak, `bg-warning` or a muted amber token for good,
and `bg-primary` or a success token for strong. If the project does not yet have a warning/success token, define them.

### I6. `bg-opacity-10` on home page app cards has no effect

**File:** `apps/space/src/routes/_auth.index.tsx:44`

```tsx
<div className={`p-2 rounded-md ${app.className} bg-opacity-10`}>
```

`app.className` is a `text-*` class (e.g., `text-teal-600`), not a `bg-*` class. `bg-opacity-10` modifies background
color opacity, but there is no background color to modify. The class is inert. Additionally, `bg-opacity-*` is
deprecated in Tailwind CSS 4 (the project's CSS framework) in favor of the `/` opacity syntax.

**Impact:** Dead CSS class. The intended transparent background tint behind each app icon does not appear.

**Fix:** Add an explicit background color and use the v4 opacity syntax, or use a theme-aware approach. For example:
`bg-current/10` or a dedicated background class per app.

---

## Minor Issues

### M1. `"use client"` directives are meaningless in this project

**Files:** `apps/space/src/components/space/fa2.tsx:1`, `login-fa2.tsx:1`, `change-password.tsx:1`
**Carried from previous review.**

The project uses Vite, not Next.js. These directives have no effect and are dead code.

**Fix:** Remove the `"use client"` lines from all three files.

### M2. `interface` used where `type` is preferred

**Files:**
- `apps/space/src/routes/_auth.index.tsx:10` -- `interface AppItem`
- `apps/space/src/routes/__root.tsx:6` -- `interface MyRouterContext`
- `apps/space/src/components/space/space-sidebar.tsx:8` -- `interface SpaceSidebarProps`

**Carried from previous review.**

The project convention is `type` over `interface`. `MyRouterContext` may be acceptable per TanStack Router conventions,
but the other two have no reason to be interfaces.

**Fix:** Change `interface` to `type` for `AppItem` and `SpaceSidebarProps`.

### M3. Magic number 350ms duplicated across 3 files

**Files:** `_auth.security.2fa.tsx:51`, `_auth.security.password.tsx:18`, `login-fa2.tsx:60`
**Carried from previous review (was M4).**

The pattern `await new Promise(resolve => setTimeout(resolve, 350))` before navigation is copy-pasted. If the desired
delay changes, all three must be updated independently.

**Fix:** Extract to a shared constant or utility function (e.g., `TOAST_NAVIGATION_DELAY_MS` or a `delayedNavigate`
helper).

### M4. `min-h-screen` on content routes conflicts with AppShell height management

**Files:** `_auth.data.tsx:10`, `_auth.security.2fa.tsx:76`, `_auth.security.password.tsx:31`, `_auth.user.tsx:10`
**Carried from previous review (was M5).**

The `__root.tsx` wraps content in `<div className="flex-1 overflow-auto">` inside `AppShell`. Each route then
applies `min-h-screen`, which sets `min-height: 100vh`. Since the content area is already a flex child of the shell
(which includes the Topbar), `min-h-screen` forces the content taller than the viewport by the Topbar height,
causing unnecessary scrolling even on short content.

**Fix:** Remove `min-h-screen` from the route wrappers or replace with `min-h-full` / `flex-1`.

### M5. JSDoc comment violates project "no JSDoc" rule

**File:** `apps/space/src/components/space/change-password.tsx:15-20`
**Carried from previous review (was M6).**

The `validatePasswordStrength` function has a full JSDoc block with `@param` and `@returns` tags. The project rules
explicitly state "No JSDoc -- code should be self-documenting, minimal comments."

**Fix:** Remove the JSDoc block. The function name and TypeScript signature are self-documenting.

### M6. Credentials header passed to avatar upload is inert

**File:** `apps/space/src/components/space/profile-editor.tsx:173-175`
**Carried from previous review (was M7).**

The upload call passes `headers: { 'credentials': 'include' }`. However, `credentials` is a fetch API request option,
not an HTTP header. Additionally, the `uploadWithProgress` function renames the `headers` parameter to `_headers` and
never applies it (the header-setting code is commented out at lines 28-30 of `upload-with-progress.tsx`).
Authentication works only because `xhr.withCredentials = true` is set inside `uploadWithProgress`.

**Impact:** Dead code that suggests incorrect understanding of the auth mechanism. Misleading for future maintainers.

**Fix:** Remove the `headers` property from the upload call.

### M7. login-2fa fallback redirects to `/login` instead of `/`

**File:** `apps/space/src/routes/login-2fa.tsx:5`
**Carried from previous review (was M8).**

When an already-authenticated user visits `/login-2fa`, the `beforeLoad` guard redirects to
`search.redirect || fallback` where `fallback = '/login'`. This sends authenticated users to the login page, which has
its own guard that redirects to `/`. The result is a double-redirect: `/login-2fa` -> `/login` -> `/`.

**Impact:** Unnecessary extra redirect and router evaluation for authenticated users.

**Fix:** Change `const fallback = '/login'` to `const fallback = '/'`.

### M8. `AppItem` type is redundant -- the `apps` array already has a type

**File:** `apps/space/src/routes/_auth.index.tsx:10-16`
**Carried from previous review (was M9).**

A local `interface AppItem` is declared and used in the `apps.map()` callback as a type annotation
(`(app: AppItem) =>`). The `apps` array imported from `@workspace/lib/apps` already has its own inferred type. This
local type may drift from the actual shape if fields are added or renamed in the source.

**Fix:** Remove the `AppItem` type and let TypeScript infer the type from the `apps` array, or use
`typeof apps[number]` if an explicit annotation is needed.

### M9. Missing `await` on `navigate()` calls

**Files:**

- `apps/space/src/routes/_auth.security.password.tsx:21`
- `apps/space/src/routes/_auth.security.2fa.tsx:54`
- `apps/space/src/components/space/profile-editor.tsx:112`

TanStack Router's `navigate()` returns a `Promise`. Per project rules ("Always `await` async calls"), these should be
awaited. While `navigate` is unlikely to throw, unawaited promises in async functions are a code smell that the linter
and project conventions flag.

**Fix:** Add `await` before each `navigate(...)` call.

### M10. Hardcoded `text-teal-600` on home page brand text

**File:** `apps/space/src/routes/_auth.index.tsx:24`

```tsx
<span className="font-bold text-teal-600">eigen</span>
```

Per the project rule "Use theme tokens, not hardcoded colors," this should use a theme token. If teal is the
intentional brand color, it should be defined as a CSS custom property / theme token.

**Fix:** Use `text-primary` or define a brand-specific token.

---

## Resolved Since Previous Review (2026-03-18)

The following issues from the prior review have been fixed and are no longer present:

| Previous ID  | Description                                          | Status                                                                              |
|--------------|------------------------------------------------------|-------------------------------------------------------------------------------------|
| C1           | `revokeOtherSessions` silently ignored               | **Fixed.** Handler now accepts and passes the boolean.                              |
| C2           | Missing `await` on `onPasswordChange` in `onSubmit`  | **Fixed.** `await` is now present on line 95.                                       |
| C3           | Avatar upload double-processes response              | **Fixed.** Only the `onSuccess` callback sets avatar now.                           |
| I3           | TOTP secret extraction uses fragile string splitting | **Fixed.** Now uses `new URL(...).searchParams.get('secret')`.                      |
| I4           | `space-8` invalid Tailwind class                     | **Fixed.** Now reads `space-y-8`.                                                   |
| I5 (partial) | Dutch TODO comment                                   | **Partially fixed.** Comment is now in English. `window.location.reload()` remains. |
| I7           | Hardcoded light-mode info/error box colors           | **Fixed.** Now uses `bg-accent`/`bg-destructive` theme tokens.                      |
| M3           | Debug `console.log` statements                       | **Fixed.** Both removed.                                                            |

---

## Observations

1. **No loading/submitting state on the ChangePassword submit button.** Unlike the 2FA form which shows
   "Setting up..." / "Verifying...", the password change button always reads "Change Password" with no visual feedback
   during submission. (`change-password.tsx:197`)

2. **Password strength meter is client-side only.** The `validatePasswordStrength` function
   (`change-password.tsx:21-41`) runs only in the browser. There is no corresponding server-side strength validation,
   so a direct API call could bypass it. Whether this matters depends on the threat model.

3. **The data export download uses a created-and-removed anchor tag approach.** (`download-home.tsx:15-25`) This is a
   common pattern but has no error handling for the actual download (the try/catch only covers the DOM manipulation, not
   the HTTP response). If the server returns a 401 or 500, the user sees "Download started" with no file.

4. **`usePublicConfig()` is imported in `login-fa2.tsx:33` but only used for the support email domain.** The component
   fetches the entire public config just to construct a `mailto:` link. If the config fetch fails, the fallback
   `'eigen.is'` is used. This is fine but worth noting as a dependency.

5. **The shared library layer for space is minimal but well-structured.** `packages/lib/src/core/space/` has proper
   query keys, hooks, invalidation functions, and SSE handlers -- following the project patterns correctly. The
   `useSpaceSettings` / `useUpdateSpaceSettings` hooks are not currently used by the space app itself, suggesting they
   may be consumed by other apps or are prepared for future use.

6. **The `grid-cols-2 sm:grid-cols-2` duplication** on `_auth.index.tsx:38` is redundant -- `sm:grid-cols-2` is the
   same as the default `grid-cols-2` and could be simplified.

---

## Strengths

- **Clean auth guard pattern.** The `_auth.tsx` route guard correctly uses TanStack Router's `beforeLoad` with
  `redirect`, and the login route delegates to the shared `createLoginRouteOptions()` factory from `packages/ui`.
- **Proper provider stack.** `main.tsx` correctly wraps the app in `EigenApp` -> `AuthProvider` -> `RouterProvider`
  with the auth context passed through.
- **Good form validation.** All forms use `react-hook-form` with `zod` schemas and proper field-level error messages.
- **SSE integration prepared.** The `packages/lib/src/core/space/sse-handlers.ts` is properly wired up to invalidate
  space settings on `SPACE_SETTINGS_UPDATED` events.
- **Sidebar follows project conventions.** Uses `SidebarSection`, `SidebarItem`, `SidebarHeader`, and `StorageUsage`
  components from the shared UI library.
- **Error feedback on mutations.** The password change and 2FA flows use `toast.error()` for failure cases, following
  the project rule about mutation error feedback.
- **Several prior issues fixed.** 8 of the previous review's findings have been addressed, showing active maintenance.

---

## Summary

| Severity  | Count | Key themes                                                                                                     |
|-----------|-------|----------------------------------------------------------------------------------------------------------------|
| Critical  | 1     | 2FA toggle misleads user (cosmetic-only control)                                                               |
| Important | 6     | Imperative fetch, inaccessible toggle, `window.location.reload()`, identical icons, hardcoded colors, dead CSS |
| Minor     | 10    | `"use client"` directives, `interface` vs `type`, magic numbers, layout conflicts, missing `await` on navigate |
| Resolved  | 8     | From the 2026-03-18 review                                                                                     |

The highest-priority fix is C1 (the 2FA toggle that lies about its effect). The most impactful quality improvements
are I1 (switching to a query hook for profile data) and I4 (rendering actual app icons on the home page).

---

## Files Reviewed

| File                   | Path                                                                         |
|------------------------|------------------------------------------------------------------------------|
| Entry point            | `apps/space/src/main.tsx`                                                    |
| Root route             | `apps/space/src/routes/__root.tsx`                                           |
| Auth guard             | `apps/space/src/routes/_auth.tsx`                                            |
| Home page              | `apps/space/src/routes/_auth.index.tsx`                                      |
| Profile route          | `apps/space/src/routes/_auth.user.tsx`                                       |
| Data export route      | `apps/space/src/routes/_auth.data.tsx`                                       |
| Password route         | `apps/space/src/routes/_auth.security.password.tsx`                          |
| 2FA setup route        | `apps/space/src/routes/_auth.security.2fa.tsx`                               |
| Login route            | `apps/space/src/routes/login.tsx`                                            |
| Login 2FA route        | `apps/space/src/routes/login-2fa.tsx`                                        |
| Sidebar                | `apps/space/src/components/space/space-sidebar.tsx`                          |
| Profile editor         | `apps/space/src/components/space/profile-editor.tsx`                         |
| Change password        | `apps/space/src/components/space/change-password.tsx`                        |
| 2FA setup component    | `apps/space/src/components/space/fa2.tsx`                                    |
| Login 2FA component    | `apps/space/src/components/space/login-fa2.tsx`                              |
| Data export component  | `apps/space/src/components/space/download-home.tsx`                          |
| Route tree (generated) | `apps/space/src/routeTree.gen.ts`                                            |
| Space hooks            | `packages/lib/src/core/space/hooks/use-space-settings.ts`                    |
| Space SSE handlers     | `packages/lib/src/core/space/sse-handlers.ts`                                |
| Contact hooks (used)   | `packages/lib/src/core/contacts/hooks/use-contacts.ts`                       |
| API URLs (used)        | `packages/lib/src/core/api.ts`                                               |
| Apps list (used)       | `packages/lib/src/core/apps.ts`                                              |
| Upload utility (used)  | `packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx` |
