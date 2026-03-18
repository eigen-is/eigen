# Frontend Review: Space App (User Settings, Profile)

**Scope:** `apps/space/`
**Reviewed:** 2026-03-18

The Space app handles user account management: profile editing, password changes, 2FA setup, data export, and an app
launcher home page. It has 8 route files, 6 components, a sidebar, and `main.tsx`. The codebase is small but has a
notable density of issues relative to its size.

Architecture compliance is generally good: no direct `useQuery`/`useMutation` in app code, proper `AppShell` +
`SidebarSection` + `SidebarItem` usage, auth guard in `_auth.tsx`, login route via shared `createLoginRouteOptions()`
factory, and correct `EigenApp` provider stack. The main architectural deviation is the imperative data fetching in the
profile editor.

---

## Critical Issues

### C1. `revokeOtherSessions` checkbox value is silently ignored

**File:** `apps/space/src/routes/_auth.security.password.tsx:12`
**Previous review:** Not identified.

The `ChangePassword` component includes a "Log out of all other devices" checkbox that is wired up and submitted as part
of the form data. However, the route handler declares its parameter type as
`{ currentPassword: string, newPassword: string }`, stripping `revokeOtherSessions` from the destructured data. It then
hardcodes `revokeOtherSessions: true` when calling `authClient.changePassword()`.

The user's explicit choice is discarded. Someone who unchecks the box expects to stay logged in on other devices, but
all sessions are always revoked regardless.

**Impact:** User expectation violation. The UI presents a functional-looking control that does nothing.

**Fix:** Change the handler signature to accept `{ currentPassword: string, newPassword: string, revokeOtherSessions: boolean }` and pass `data.revokeOtherSessions` instead of the hardcoded `true`.

### C2. `onSubmit` in ChangePassword does not await `onPasswordChange`

**File:** `apps/space/src/components/space/change-password.tsx:94-100`
**Previous review:** Partially identified as Minor 3 (misattributed to the route handler's navigate).

The `onSubmit` function is declared `async` but calls `onPasswordChange(...)` without `await`. This means:
- The form's submission state ends immediately, even though the password change is still in-flight.
- If `onPasswordChange` throws (e.g., network error), the rejection is unhandled -- it becomes an unhandled promise
  rejection rather than being caught by any error boundary or try/catch.
- The form provides no loading feedback to the user during the actual API call.

**Impact:** Unhandled promise rejections. No loading indication. User can submit again while the first request is
in-flight.

**Fix:** Add `await` before `onPasswordChange(...)`.

### C3. Avatar upload double-processes the response, setting avatar twice

**File:** `apps/space/src/components/space/profile-editor.tsx:168-195`
**Previous review:** Identified as Minor 2.

The `uploadWithProgress` function calls the `onSuccess` callback with the raw XHR response text (line 180-183:
`setAvatar(response)` where `response` is the string passed by `onSuccess`). Then, after the promise resolves, the code
at lines 192-195 also checks `response.ok` on the returned `Response` object and calls `setAvatar(responseData)` with
`await response.text()`. This causes:

1. `setAvatar` is called twice with potentially different values (the first call receives the raw XHR `response` string,
   the second receives `response.text()` from the synthetic `Response` wrapper).
2. The second `response.text()` call may return an empty string because the body stream has already been consumed
   internally by the `uploadWithProgress` function to construct its synthetic Response.

**Impact:** Avatar state may be set to an empty string or incorrect value on the second call, overwriting the correct
value from the first.

**Fix:** Remove either the `onSuccess` callback or the post-await processing. Since `onSuccess` fires synchronously
inside `uploadWithProgress` with the correct data, remove lines 192-195.

---

## Important Issues

### I1. Profile editor uses imperative fetch instead of a query hook

**File:** `apps/space/src/components/space/profile-editor.tsx:48-65`
**Previous review:** Identified as Important 1.

`getMeContact()` is called inside a `useEffect` with manual `isLoading`/`error`/`contact` state. This bypasses
TanStack Query's cache, stale-while-revalidate, and SSE-driven invalidation. A `useMeContact()` hook should be created
in `packages/lib/src/core/contacts/hooks/` wrapping `getMeContact` in `useQuery`.

**Impact:** No cache sharing, no automatic refetch on data changes, manual state management that duplicates what
TanStack Query provides.

**Fix:** Create a `useMeContact()` hook in `packages/lib/src/core/contacts/hooks/use-contacts.ts` and use it in the
profile editor.

### I2. Custom toggle div is inaccessible -- should use the existing Switch component

**File:** `apps/space/src/components/space/fa2.tsx:283-290`
**Previous review:** Not identified.

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

### I3. TOTP secret extraction uses fragile string splitting that can crash

**File:** `apps/space/src/routes/_auth.security.2fa.tsx:28`
**Previous review:** Not identified.

The line `setSecretKey(result.data.totpURI.split('secret=')[1].split('&')[0])` assumes the TOTP URI always contains a
`secret=` parameter. If the URI format changes or the parameter is missing, `.split('secret=')[1]` returns `undefined`,
and calling `.split('&')` on `undefined` throws a `TypeError`, crashing the component.

**Impact:** Unhandled runtime crash if the TOTP URI format is unexpected.

**Fix:** Use `URL` and `URLSearchParams` to parse the URI safely:
```ts
const url = new URL(result.data.totpURI);
setSecretKey(url.searchParams.get('secret') ?? '');
```

### I4. `space-8` is not a valid Tailwind class

**File:** `apps/space/src/components/space/change-password.tsx:104`
**Previous review:** Not identified.

The root div uses `className="space-8 pb-20 m-4"`. The class `space-8` does not exist in Tailwind CSS. The intended
class is almost certainly `space-y-8` (vertical spacing between children). Without this, the form fields in the
password change component have no vertical spacing between them, relying only on the inner `space-y-6` from the `<form>`
element.

**Impact:** Missing visual spacing on the outer container. The layout works only because the inner form has its own
spacing.

**Fix:** Change `space-8` to `space-y-8`.

### I5. Dutch TODO comment left in production code

**File:** `apps/space/src/components/space/login-fa2.tsx:62`
**Previous review:** Identified as Important 2.

`// TODO: Reinder, dit moet misschien anders` followed by `window.location.reload()`. Violates the "English everywhere"
rule. The `window.location.reload()` is a blunt workaround for refreshing auth state after 2FA verification -- it
discards all client-side state and forces a full page reload instead of properly updating the auth context.

**Impact:** Code style violation. Full page reload loses all client state.

**Fix:** Translate the comment to English. Replace `window.location.reload()` with proper auth state refresh
(e.g., invalidating the auth query or calling a session refresh method).

### I6. App home page renders identical icons for every app

**File:** `apps/space/src/routes/_auth.index.tsx:46-60`
**Previous review:** Identified as Important 5.

Every app card renders the same hardcoded SVG (a code-bracket `<>` icon). The `app.icon` field from
`packages/lib/src/core/apps.ts` (which contains Lucide icon names like `'calendar'`, `'mail'`, `'hard-drive'`) is
completely unused. All apps appear visually identical on the home page.

**Impact:** The app launcher provides no visual differentiation between apps.

**Fix:** Use a Lucide icon lookup or mapping to render the correct icon per app based on the `app.icon` string.

### I7. Hardcoded light-mode info/error box colors break dark mode

**Files:**
- `apps/space/src/components/space/fa2.tsx:121,165,233`
- `apps/space/src/components/space/profile-editor.tsx:270`
- `apps/space/src/components/space/profile-editor.tsx:134`

**Previous review:** Not identified.

Info boxes use `bg-blue-50 border-blue-200 text-blue-800` and the error box uses `bg-red-100 border-red-200 text-red-600`.
These are hardcoded light-mode colors that will look jarring or unreadable in dark mode (`bg-blue-50` on a dark
background produces near-white patches). The project has an `Alert` component at
`packages/ui/src/components/alert.tsx` with proper theme-aware variants using `bg-background text-foreground`.

**Impact:** Poor visual appearance in dark mode.

**Fix:** Replace the custom info/error divs with the `Alert`, `AlertTitle`, `AlertDescription` components from
`@workspace/ui/components/alert`.

---

## Minor Issues

### M1. `"use client"` directives are meaningless in this project

**Files:** `apps/space/src/components/space/fa2.tsx:1`, `login-fa2.tsx:1`, `change-password.tsx:1`
**Previous review:** Identified as Important 4.

The project uses Vite, not Next.js. These directives have no effect and are dead code.

**Fix:** Remove the `"use client"` lines from all three files.

### M2. `interface` used where `type` is preferred

**Files:**
- `apps/space/src/routes/_auth.index.tsx:10` -- `interface AppItem`
- `apps/space/src/routes/__root.tsx:6` -- `interface MyRouterContext`
- `apps/space/src/components/space/space-sidebar.tsx:8` -- `interface SpaceSidebarProps`

**Previous review:** Identified as Minor 1.

The project convention is `type` over `interface`. `MyRouterContext` may be acceptable per TanStack Router conventions,
but the other two have no reason to be interfaces.

**Fix:** Change `interface` to `type` for `AppItem` and `SpaceSidebarProps`.

### M3. Debug `console.log` statements left in code

**Files:**
- `apps/space/src/routes/_auth.security.2fa.tsx:32` -- `console.log(result.error)` (debug, toast already shows the error)
- `apps/space/src/routes/_auth.security.password.tsx:14` -- `console.log(result)` (logs entire API response)

**Previous review:** Identified as Important 3.

These are debug artifacts. The `console.error` calls in catch blocks across the app (fa2.tsx:90,102,
profile-editor.tsx:58,114,187,197, download-home.tsx:30, login-fa2.tsx:68, 2fa.tsx:36,62) are arguably acceptable for
error reporting, but the two `console.log` calls serve no production purpose.

**Fix:** Remove the two `console.log` calls.

### M4. Magic number 350ms duplicated across 3 files

**Files:** `_auth.security.2fa.tsx:52`, `_auth.security.password.tsx:19`, `login-fa2.tsx:60`
**Previous review:** Identified as Minor 4.

The pattern `await new Promise(resolve => setTimeout(resolve, 350))` before navigation is copy-pasted. If the desired
delay changes, all three must be updated independently.

**Fix:** Extract to a shared constant or utility function (e.g., `TOAST_NAVIGATION_DELAY_MS` or a `delayedNavigate`
helper).

### M5. `min-h-screen` on content routes conflicts with AppShell height management

**Files:** `_auth.data.tsx:10`, `_auth.security.2fa.tsx:77`, `_auth.security.password.tsx:32`, `_auth.user.tsx:10`
**Previous review:** Identified as Minor 5.

The `__root.tsx` wraps content in `<div className="flex-1 overflow-auto">` inside `AppShell`. Each route then
applies `min-h-screen`, which sets `min-height: 100vh`. Since the content area is already a flex child of the shell
(which includes the Topbar), `min-h-screen` forces the content taller than the viewport by the Topbar height,
causing unnecessary scrolling even on short content.

**Fix:** Remove `min-h-screen` from the route wrappers or replace with `min-h-full` / `flex-1`.

### M6. JSDoc comment violates project "no JSDoc" rule

**File:** `apps/space/src/components/space/change-password.tsx:15-20`
**Previous review:** Not identified.

The `validatePasswordStrength` function has a full JSDoc block with `@param` and `@returns` tags. The project rules
explicitly state "No JSDoc -- code should be self-documenting, minimal comments."

**Fix:** Remove the JSDoc block. The function name and TypeScript signature are self-documenting.

### M7. Credentials header passed to avatar upload is inert

**File:** `apps/space/src/components/space/profile-editor.tsx:173-175`
**Previous review:** Not identified.

The upload call passes `headers: { 'credentials': 'include' }`. However, `credentials` is a fetch API request option,
not an HTTP header. Additionally, the `uploadWithProgress` function renames the `headers` parameter to `_headers` and
never applies it (the header-setting code is commented out). Authentication works only because `xhr.withCredentials = true`
is set inside `uploadWithProgress`.

**Impact:** Dead code that suggests incorrect understanding of the auth mechanism. Misleading for future maintainers.

**Fix:** Remove the `headers` property from the upload call.

### M8. login-2fa fallback redirects to `/login` instead of `/`

**File:** `apps/space/src/routes/login-2fa.tsx:5`
**Previous review:** Not identified.

When an already-authenticated user visits `/login-2fa`, the `beforeLoad` guard redirects to
`search.redirect || fallback` where `fallback = '/login'`. This sends authenticated users to the login page, which has
its own guard that redirects to `/`. The result is a double-redirect: `/login-2fa` -> `/login` -> `/`.

**Impact:** Unnecessary extra redirect and router evaluation for authenticated users.

**Fix:** Change `const fallback = '/login'` to `const fallback = '/'`.

### M9. `AppItem` type is redundant -- the `apps` array already has a type

**File:** `apps/space/src/routes/_auth.index.tsx:10-16`
**Previous review:** Not identified.

A local `interface AppItem` is declared and used in the `apps.map()` callback as a type annotation
(`(app: AppItem) =>`). The `apps` array imported from `@workspace/lib/apps` already has its own inferred type. This
local type may drift from the actual shape if fields are added or renamed in the source.

**Fix:** Remove the `AppItem` type and let TypeScript infer the type from the `apps` array, or use
`typeof apps[number]` if an explicit annotation is needed.

---

## Observations

1. **No loading/submitting state on the ChangePassword submit button.** Unlike the 2FA form which shows
   "Setting up..." / "Verifying...", the password change button always reads "Change Password" with no visual feedback
   during submission. (`change-password.tsx:197`)

2. **Profile editor sets `isLoading` during save but the button text toggles on it.** Since `onSubmit` does not have
   proper error handling flow, a failed save could leave `isLoading` stuck as `true` if the catch block's
   `setIsLoading(false)` is reached but the user has already navigated away. This is a minor memory-leak concern in
   React strict mode. (`profile-editor.tsx:93-117`)

3. **Password strength meter is client-side only.** The `validatePasswordStrength` function
   (`change-password.tsx:21-41`) runs only in the browser. There is no corresponding server-side strength validation,
   so a direct API call could bypass it. Whether this matters depends on the threat model.

4. **The data export download uses a created-and-removed anchor tag approach.** (`download-home.tsx:15-25`) This is a
   common pattern but has no error handling for the actual download (the try/catch only covers the DOM manipulation, not
   the HTTP response). If the server returns a 401 or 500, the user sees "Download started" with no file.

5. **`usePublicConfig()` is imported in `login-fa2.tsx:33` but only used for the support email domain.** The component
   fetches the entire public config just to construct a `mailto:` link. If the config fetch fails, the fallback
   `'eigen.is'` is used. This is fine but worth noting as a dependency.
