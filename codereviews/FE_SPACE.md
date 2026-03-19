# FE Code Review: Space

## Summary

The Space frontend is a personal settings app with pages for: home/dashboard, profile editing, data export, password
change, and 2FA setup. The code lives in:

- `apps/space/src/` -- routes and components
- `packages/lib/src/core/space/` -- hooks and SSE handlers

The app is well-structured with proper auth guards, clean component decomposition, and correct use of shared hooks.
There are a few issues around error handling, missing `await`, and minor UX concerns.

## Critical Issues

None. The Space frontend is a simple app with minimal surface area for critical bugs.

## Pattern Violations

### 1. `useQuery`/`useMutation` used directly in space hooks (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/space/hooks/use-space-settings.ts`, lines 15, 31

The hooks correctly live in `packages/lib/src/core/space/hooks/` as required. However, the `useQuery` and
`useMutation` imports from `@tanstack/react-query` are used directly in the hooks file, which is the intended pattern.
No violation here upon closer inspection -- the rule prohibits using them directly in *apps*, not in the hooks layer.

### 2. Query key does not include `ownerId` (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/space/hooks/use-space-settings.ts`, lines 6-9

```typescript
export const spaceKeys = {
    all: ['space'] as const,
    settings: () => [...spaceKeys.all, 'settings'] as const,
};
```

Per CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data." The settings are per-user but the
query key does not include `ownerId`. In a single-user browser session this works, but if the auth context were ever
to switch users (e.g., admin impersonation), stale cached settings from the wrong user would be served.

**Fix**: Include `ownerId` in the query key: `settings: (ownerId: string) => [...spaceKeys.all, 'settings', ownerId]`.

### 3. `interface` used instead of `type` in `__root.tsx` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/routes/__root.tsx`, line 7 (auto-gen uses `type` here
but the people app uses `interface` -- see People review). The Space app uses `type` correctly in most places. The
`MyRouterContext` uses `type` -- this is fine.

## Security Concerns

### 4. Password change has no error boundary for unhandled rejections (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/routes/_auth.security.password.tsx`, lines 12-19

```typescript
const handlePasswordChange = async (data) => {
    const result = await authClient.changePassword(data);
    if (result.data) {
        toast.success('Password changed successfully');
        await navigate({to: '/'});
    } else {
        toast.error(result.error?.message ?? 'Failed to change password');
    }
}
```

If `authClient.changePassword` throws (network error, timeout), there is no `try/catch`. Per CLAUDE.md: "Every
mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`."

**Fix**: Wrap in try/catch with toast.error.

### 5. 2FA TOTP secret displayed in plaintext (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/fa2.tsx`, lines 191-194

The TOTP secret key is displayed in a read-only input field and can be copied to clipboard. This is standard practice
for 2FA setup, but the secret is held in component state (`secretKey`) and could be logged by browser dev tools or
extensions. This is an acceptable trade-off for usability.

### 6. `navigator.clipboard.writeText` not awaited (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/fa2.tsx`, lines 66-69

```typescript
const copyToClipboard = () => {
    if (secretKey) {
        navigator.clipboard.writeText(secretKey);
    ...
    }
};
```

`navigator.clipboard.writeText` returns a Promise. Per CLAUDE.md: "Always await async calls -- missing await is the
#1 bug class." If the clipboard write fails (e.g., permissions denied), the success indicator still shows.

**Fix**: `await navigator.clipboard.writeText(secretKey)` and wrap in try/catch.

## Data Integrity

### 7. Profile editor spreads entire contact object into update (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/profile-editor.tsx`, lines 67-72

```typescript
const updateData = {
    ...contact,
    firstName: data.firstName,
    lastName: data.lastName || "",
    avatar: avatar || ""
};
```

The entire `contact` object is spread into the update payload. If the contact object contains fields that should not
be mutated through this form (e.g., system-generated fields, email addresses), they are sent back to the server. This
relies on the backend ignoring unknown fields, but is fragile.

**Fix**: Explicitly pick only the fields the form manages.

### 8. Avatar removal sets empty string instead of null (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/profile-editor.tsx`, line 71

```typescript
avatar: avatar || ""
```

When the avatar is removed (`avatar` is `null`), the update sends an empty string. The backend should ideally
receive `null` to indicate "no avatar" rather than an empty string, which is a truthy falsy ambiguity.

## Code Quality

### 9. Download link pattern is fragile (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/download-home.tsx`, lines 16-27

The download creates an `<a>` element, sets `href`, appends to body, clicks it, and removes it. This is a common
pattern but has issues:

- The auth cookie may not be sent with the download (depends on SameSite settings).
- The `try/catch` on line 13 will never catch download failures because the `<a>` click is fire-and-forget.
- The `toast.success('Download started')` fires immediately, before the download actually starts.

**Fix**: Consider using `fetch` with credentials, then creating a blob URL, which gives actual error handling.

### 10. Unused import in `login-fa2.tsx` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/login-fa2.tsx`

The imports `CardDescription`, `CardFooter`, `CardHeader`, `CardTitle` from `@workspace/ui/components/card` are all
used. The `usePublicConfig` hook is used for the support email domain. No unused imports found on closer inspection.

### 11. Loading state check pattern (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/profile-editor.tsx`, lines 86-96

```typescript
if (isLoading && !contact) { ...
}
if (fetchError && !contact) { ...
}
```

The double condition `isLoading && !contact` is a pattern to avoid flashing a loading state when data is already
cached. This is intentional but could be clearer with a comment.

### 12. `submitError` state is redundant with toast (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/space/src/components/space/profile-editor.tsx`, lines 35, 82,
99-103

The component maintains a `submitError` state that renders an inline error banner, AND also could use toast for
errors. Currently the catch block sets `submitError` but does not call `toast.error()`. This is inconsistent with the
rest of the app which uses toast for error feedback.

**Fix**: Use toast.error() consistently and remove the `submitError` state, or vice versa.

## Architecture

- The Space app follows the standard Eigen app structure: `EigenApp` provider -> `AppShell` -> `_auth` guard ->
  route components.
- The sidebar correctly uses `SidebarItem` with `to` prop for navigation.
- SSE handler is properly wired for settings changes.
- The hooks layer in `packages/lib/src/core/space/` is minimal but correct.

## Positive Patterns

- Proper use of `EigenApp` and `AppShell` providers.
- Auth guard (`_auth.tsx`) correctly redirects unauthenticated users.
- Login route uses the shared `createLoginRouteOptions` helper.
- 2FA flow is well-structured with clear step progression (password -> QR code -> verification).
- Password strength indicator uses the shared `validatePasswordStrength` function.
- All form components use `react-hook-form` + `zod` for validation.
- Theme tokens used throughout (no hardcoded colors).
- No `useQuery`/`useMutation` used directly in app components.
- No `as any` in non-generated code.
- No `"use client"` directives.

## Recommendations

| Priority | Issue                                | Action                                  |
|----------|--------------------------------------|-----------------------------------------|
| P1       | #2 Query key missing ownerId         | Add ownerId to space settings query key |
| P1       | #6 clipboard.writeText not awaited   | Await and add try/catch                 |
| P2       | #4 Password change missing try/catch | Wrap in try/catch                       |
| P2       | #7 Contact object spread             | Pick explicit fields                    |
| P2       | #8 Avatar empty string vs null       | Use null for removal                    |
| P2       | #9 Download link fragility           | Use fetch + blob URL                    |
| P2       | #12 Redundant submitError state      | Use toast consistently                  |
