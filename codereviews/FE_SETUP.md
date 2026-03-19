# FE Code Review: Setup

## Summary

The setup frontend is a minimal single-page wizard (`apps/setup/src/`) consisting of three files: `main.tsx` (15
lines), `components/setup-wizard.tsx` (371 lines), and `vite-env.d.ts`. It collects server configuration, storage
type, and admin credentials, then POSTs to `/setup/complete`. The app is intentionally simple -- no router, no state
management library, no data hooks -- since it runs exactly once per deployment.

## Critical Issues

### 1. Missing error handling on waitlist-style fetch (no `await` result check pattern)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 26-29, 31-42

The `checkSetupStatus()` and `completeSetup()` functions call `fetch()` and then `response.json()` without checking
`response.ok`. If the server returns a 500, `response.json()` will either throw (if body is not JSON) or return
an unexpected structure. The `completeSetup` function does check `result.success`, but if the JSON parse fails, the
error is silently swallowed by the generic catch on line 96-97.

More critically, `checkSetupStatus()` does not check `response.ok` at all. A non-200 response with a JSON body will be
treated as a valid status, potentially showing the wrong step.

**Fix**: Add `if (!response.ok) throw new Error(...)` before `.json()` in both functions.

### 2. Field name mismatch between frontend and backend

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 19, 32-35

The frontend form collects `adminUsername` (line 19), then constructs `adminEmail` as
`${data.adminUsername}@${data.domain}` (line 34). However, the `SetupData` interface includes `adminUsername` but not
`adminEmail`. The `submitData` spread `{...data, adminEmail: ...}` includes the extra `adminUsername` field in the
POST body. The Elysia route schema does not define `adminUsername`, so Elysia will either ignore the extra field or
reject it depending on `additionalProperties` configuration. This works by accident but is fragile.

**Fix**: Either remove `adminUsername` from the spread (construct a clean object), or explicitly omit it:

```typescript
const { adminUsername, ...rest } = data;
const submitData = { ...rest, adminEmail: `${adminUsername}@${data.domain}` };
```

## Pattern Violations

### 1. `interface` used instead of `type`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, line 10

```typescript
interface SetupData {
```

CLAUDE.md rule: "Always `type` over `interface` -- except when methods are needed." `SetupData` is a plain data shape
with no methods.

**Fix**: Change to `type SetupData = { ... }`.

### 2. Direct `fetch()` instead of Eden Treaty API client

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 26-42

The setup wizard uses raw `fetch()` calls to the API instead of the Eden Treaty client used everywhere else in the
codebase. This bypasses the type-safe API layer, meaning if the backend route schema changes, the frontend will not
get a type error at build time.

This is a deliberate tradeoff: the setup app runs before the system is configured, so it may need to work without the
full API client setup. However, Eden Treaty works with any base URL and does not require auth, so there is no technical
reason it cannot be used here.

**Fix**: Use Eden Treaty for type-safe API calls, or at minimum define a shared type for the request/response.

### 3. Hardcoded colors break dark mode

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 137-138

```typescript
className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4"
className="w-8 h-8 text-green-600"
```

CLAUDE.md rule: "Use theme tokens, not hardcoded colors -- use `text-muted-foreground`, `bg-muted`, `border` etc.
instead of `text-gray-500`, `bg-blue-50`. Hardcoded colors break dark mode."

The success state checkmark uses `bg-green-100` and `text-green-600`, which will look wrong in dark mode.

**Fix**: Use theme tokens like `bg-primary/10` and `text-primary` (the config step already does this correctly on line
162), or use a semantic success color token if available.

### 4. No TanStack Query or data hooks

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`

CLAUDE.md rule: "Never use `useQuery`/`useMutation` directly in apps -- all data hooks live in
`packages/lib/src/core/[domain]/hooks/`."

The setup wizard uses no TanStack Query at all -- it manages loading/error state manually with `useState`. For a
one-shot wizard this is pragmatic, but it means no retry logic, no cache, and no structured error handling. Given the
wizard's simplicity, this is acceptable but worth noting.

## Security Concerns

### 1. Admin password visible in form state

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, line 60

The admin password is stored in React state as a plain string. After setup completes, `resetForm` is not called (it is
only called in the waitlist flow of the index app). The password remains in React state and React DevTools until the
page is unloaded. In a setup wizard context this is low risk (the admin is the one entering it), but it is good
practice to clear sensitive state after submission.

**Fix**: Clear `formData.adminPassword` after successful setup.

### 2. S3 secret access key in form state

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, line 56

Same concern as above. The S3 secret access key is stored in React state. Clear after submission.

### 3. No password strength indicator

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 347-360

The password field has `minLength={8}` and a text hint, but no strength meter or requirements beyond length. The admin
account is the most privileged account in the system. Consider adding password strength feedback.

### 4. Default form values may lead to accidental deployment

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 50-51

```typescript
domain: 'eigen.is',
orgName: 'Eigen',
```

The domain defaults to `eigen.is` and org name to `Eigen`. An administrator who clicks through quickly without
changing these will configure their instance with the wrong domain, potentially causing CORS issues, email routing
problems, and other hard-to-debug issues later.

**Fix**: Use empty defaults and make the user explicitly enter both values, or use `window.location.hostname` as the
default domain.

## Data Integrity

### 1. Form does not persist across page reloads

If the user accidentally refreshes the page during the (potentially long) S3 configuration, all form data is lost. For
a one-time setup wizard this is minor, but for S3 configuration with many fields it can be annoying.

**Fix (P2)**: Consider using `sessionStorage` to persist form state.

## Code Quality

### 1. Inline SVG instead of Lucide icon

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, lines 138-141

The success checkmark is a hand-written SVG. The project uses Lucide React for icons everywhere else. Use
`<Check />` from `lucide-react` for consistency.

### 2. `as` cast on storage type

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, line 81

```typescript
setFormData(prev => ({...prev, storageType: value as StorageType}))
```

This `as StorageType` cast is safe in context (the RadioGroup only has the three valid values), but it would be
cleaner to type the `onValueChange` callback properly.

### 3. Single monolithic component

The `SetupWizard` component (lines 44-371) handles loading state, already-setup state, complete state, and the full
form with server config + S3 config + admin account sections. At 327 lines, this would benefit from extraction into
smaller components (e.g., `ServerConfigSection`, `S3ConfigSection`, `AdminAccountSection`).

### 4. Unused import potential

The `React` namespace is imported via `useState` and `useEffect` but the component uses `React.ChangeEvent` and
`React.FormEvent` types. This is fine but inconsistent with the destructured import style.

## Architecture

### 1. No TanStack Router

The setup app is the only app that does not use TanStack Router. It has its own custom Vite config
(`apps/setup/vite.config.ts`) instead of `createAppConfig('setup')` from the shared config. This means:

- No file-based routing
- No TanStack Router devtools
- No code splitting
- No route-level head/meta management

For a single-page wizard, this is justified. But it means the setup app is architecturally different from every other
app, which can confuse developers.

### 2. API URL configuration

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/src/components/setup-wizard.tsx`, line 24

```typescript
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
```

This is the same pattern used in other apps via the Eden Treaty client. It works but duplicates the URL resolution
logic.

### 3. No EigenApp provider wrapper

The setup app renders `<SetupWizard />` directly without the `EigenApp` provider stack used by all other apps. This
means no auth context, no SSE, no query client, no upload provider. For setup, none of these are needed, but it also
means no `Toaster` component -- errors are shown inline which is actually appropriate for a form.

## Positive Patterns

1. **Clean step-based UI flow**: Loading -> Config -> Complete (or Already Setup) is well-structured and easy to follow.
2. **Proper use of theme tokens**: Most of the UI uses theme tokens (`bg-background`, `text-muted-foreground`,
   `bg-destructive/10`, `border-input`, `bg-muted`). Only the success checkmark uses hardcoded colors.
3. **Accessible form**: Uses `<Label htmlFor>` properly, `required` attributes, semantic HTML form with `onSubmit`.
4. **Responsive layout**: `max-w-lg` with padding, grid layout for S3 fields. Works on mobile.
5. **Email construction from username + domain**: Clever UX that shows the user their full email address while only
   requiring them to type the username part.
6. **Conditional S3 fields**: S3 config fields only shown when S3 storage type is selected. Clean conditional
   rendering.
7. **Loading state on submit button**: Disables button and shows "Setting up..." during submission.

## Recommendations

| Priority | Issue                     | Description                                                         |
|----------|---------------------------|---------------------------------------------------------------------|
| **P0**   | No `response.ok` check    | Both fetch calls should check HTTP status before parsing JSON       |
| **P1**   | Hardcoded green colors    | Replace `bg-green-100`/`text-green-600` with theme tokens           |
| **P1**   | Default domain `eigen.is` | Use empty or `window.location.hostname` to prevent misconfiguration |
| **P1**   | Field name mismatch       | Clean up the `adminUsername` -> `adminEmail` transformation         |
| **P2**   | `interface` -> `type`     | Change `interface SetupData` to `type SetupData`                    |
| **P2**   | Inline SVG                | Replace with Lucide `<Check />` icon                                |
| **P2**   | Monolithic component      | Extract form sections into smaller components                       |
| **P2**   | Clear sensitive state     | Clear password and S3 secret from state after successful setup      |
| **P2**   | Use Eden Treaty           | Replace raw `fetch()` with type-safe Eden Treaty client             |
