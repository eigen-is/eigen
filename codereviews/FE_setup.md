# Frontend Code Review: Setup & Index Apps

## Summary

**Setup App**: A standalone first-run wizard for configuring a new Eigen instance. Single component (`SetupWizard`)
with no router, no auth, no shared hooks. Collects domain, org name, storage type, optional S3 config, and admin
credentials, then submits to `/setup/complete`. Minimal and functional.

**Index App**: The public landing page at the root URL. Has a TanStack Router setup with blog support (markdown-based
blog posts with media grids). Also includes a waitlist signup form and login redirect. Uses its own provider stack
(not `EigenApp`).

Together these are the two simplest apps, both focused on unauthenticated users, totaling about 12 source files.

## Architecture Compliance

### Setup App

**Passing:**
- Correctly uses shared UI components (`Button`, `Input`, `Label`, `RadioGroup`, `Card`).
- Minimal standalone design is appropriate -- setup runs before auth exists.
- Imports `@workspace/ui/globals.css` for consistent styling.

**Deviations:**
- Uses raw `fetch()` instead of the API client. This is acceptable since setup runs before the API/auth is
  configured, but it means the `API_URL` is manually constructed from `import.meta.env.VITE_API_URL`.
- No TanStack Router or auth provider -- appropriate since this is a one-time wizard.
- Uses `interface` (1 instance) where `type` is preferred.

### Index App

**Passing:**
- TanStack Router with file-based routes.
- Blog system with proper meta tags (OG tags, titles) for SEO.
- Clean separation of blog data, parsing, and rendering.

**Deviations:**
- Does NOT use `EigenApp` provider stack. Instead rolls its own: `QueryClientProvider` + `AuthProvider` + `Toaster`.
  Missing: SSEProvider, UploadProvider, PreviewProvider, HotkeysProvider, TooltipProvider, ReactQueryDevtools.
  This is partially acceptable since the landing page needs minimal functionality, but means it creates its own
  `QueryClient` instance instead of using the shared one.
- Has `TanStackRouterDevtools` included in production root route -- should be dev-only.
- Dutch comments in `__root.tsx`.
- Uses `interface` (7 instances in non-generated files) where `type` is preferred.

## Issues Found

### Critical

None.

### Important

1. **Dutch comments in Index app root route**
   `apps/index/src/routes/__root.tsx`, lines 11-17:
   ```typescript
   // Als de gebruiker is ingelogd en probeert de root URL te bezoeken,
   // stuur ze dan naar de drive app
   ...
   // Gebruik window.location voor externe redirects naar andere apps
   // Voorkom dat de huidige pagina laadt
   ```
   Violates the "English everywhere" rule. All four comments are in Dutch and should be translated.

2. **TanStackRouterDevtools included in production Index app**
   `apps/index/src/routes/__root.tsx`, lines 2 and 26:
   ```typescript
   import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
   ...
   <TanStackRouterDevtools position="bottom-right"/>
   ```
   This is the only app that includes devtools unconditionally. Other apps do not include it at all (they use
   the `EigenApp` provider which conditionally includes `ReactQueryDevtools`). This adds bundle size to the
   public-facing landing page.

3. **Setup wizard has no client-side validation beyond HTML required/minLength**
   `apps/setup/src/components/setup-wizard.tsx`.
   - No password strength validation (only `minLength={8}` on the HTML input).
   - No domain format validation.
   - No S3 endpoint URL validation.
   - No email/username format validation.
   - The `adminUsername` field accepts any input including spaces, special characters.
   If the server rejects the input, the error is shown generically. Unlike the Space app's password change form
   which has zod validation and a strength meter, the setup wizard has no comparable validation.

4. **Setup wizard does not validate S3 connection before completing setup**
   `apps/setup/src/components/setup-wizard.tsx`.
   When the user selects S3 storage and enters credentials, there is no "Test Connection" button like in the
   People app's server settings. If the S3 credentials are wrong, setup completes and the server may be in a
   broken state. The People app's `ServerSettingsPage` has a proper S3 connection check -- this pattern should
   be applied to setup as well.

5. **Index app creates authenticated redirect but returns a never-resolving Promise**
   `apps/index/src/routes/__root.tsx`, lines 13-18:
   ```typescript
   if (context.auth.isAuthenticated && window.location.pathname === '/') {
       window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
       return new Promise(() => {});
   }
   ```
   The `new Promise(() => {})` is used to prevent the route from rendering while the browser navigates, but
   this creates a promise that never resolves or rejects. This could cause TanStack Router to hang indefinitely
   if `window.location.href` assignment fails or is blocked. A timeout-based fallback would be safer.

6. **Index app uses non-standard provider stack**
   `apps/index/src/main.tsx` creates its own `QueryClient` and manually composes `QueryClientProvider` +
   `AuthProvider` + `Toaster`. Every other app (Space, People, Mail, etc.) uses `EigenApp` which provides a
   standardized stack. While the Index app has simpler needs, this means any future provider additions to
   `EigenApp` will need to be manually replicated.

### Minor

1. **`interface` used where `type` is preferred**
   - Setup: `setup-wizard.tsx:10` -- `interface SetupData`
   - Index: `__root.tsx:5`, `MediaGrid.tsx:4,76`, `BlogPost.tsx:7`, `MediaPreview.tsx:3`,
     `parse-media-grids.ts:1,9`

2. **Waitlist form `handleWaitlistSubmit` has empty dependency array**
   `apps/index/src/routes/index.tsx`, line 66:
   ```typescript
   const handleWaitlistSubmit = useCallback(async (e: React.FormEvent) => {
       ...
   }, []);
   ```
   The callback references `email`, `notes`, and `resetForm` but the dependency array is empty `[]`. This means
   the callback captures stale values of `email` and `notes`. The form would always submit the initial empty
   values. This is a functional bug -- the waitlist form would never send the user's actual input.

3. **`apps.length` in useEffect dependency array is a stable primitive**
   `apps/index/src/routes/index.tsx`, line 30:
   ```typescript
   React.useEffect(() => { ... }, [apps.length]);
   ```
   `apps` is a module-level constant, so `apps.length` never changes. The dependency is harmless but misleading --
   an empty array `[]` would be more accurate.

4. **Blog post `code` component handles `inline` prop incorrectly**
   `apps/index/src/components/BlogPost.tsx`, line 48:
   ```typescript
   const {inline, ...codeProps} = props as typeof props & { inline?: boolean };
   ```
   The `inline` prop from react-markdown is destructured via a type cast. This is fragile -- the `inline` prop
   may not exist in newer react-markdown versions and the cast hides potential issues.

5. **Setup wizard uses plain `fetch` without error response body parsing**
   `apps/setup/src/components/setup-wizard.tsx`, line 90-95.
   `completeSetup` calls `response.json()` but does not check `response.ok` first. If the server returns a 500
   error with a non-JSON body, this will throw an unhandled JSON parse error that gets caught as "Network error."

6. **`vite-env.d.ts` present in Setup and Index but not in Space or People**
   `apps/setup/src/vite-env.d.ts` and `apps/index/src/vite-env.d.ts` exist. Inconsistency across the apps,
   though this has no runtime impact.

## Recommendations

1. Translate all Dutch comments in `apps/index/src/routes/__root.tsx` to English.
2. Remove or conditionally include `TanStackRouterDevtools` in the Index app (e.g., only in development).
3. Add client-side validation to the setup wizard, particularly:
   - Password strength indicator.
   - Domain format validation.
   - S3 connection test button when S3 is selected.
   - Username format validation (alphanumeric only).
4. Fix the waitlist form's `useCallback` dependency array to include `[email, notes, resetForm]`.
5. Add `response.ok` check in the setup wizard's `completeSetup` function before calling `response.json()`.
6. Consider using `EigenApp` for the Index app (or at minimum a subset) to avoid divergent provider stacks.
7. Replace the never-resolving Promise in the Index root route with a more robust redirect approach.
8. Replace `interface` with `type` in non-generated files per project convention.
