# Frontend Review: Setup Wizard + Index App

**Scope:** `apps/setup/`, `apps/index/`
**Reviewed:** 2026-03-18

## Critical Issues

### 1. Setup wizard uses wrong env variable name for API URL

**File:** `apps/setup/src/components/setup-wizard.tsx:24`
**Impact:** The setup wizard silently falls back to the hardcoded `http://localhost:8000` in every environment except development, where it happens to work by accident.

The setup app reads `VITE_API_URL`:
```typescript
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
```

Every other app and the shared API client (`packages/lib/src/core/api.ts`) uses `VITE_API_HOST`. The `.env.dev.local` file defines `VITE_API_HOST=http://localhost:8000` -- there is no `VITE_API_URL` anywhere in the env files. In development the fallback to `localhost:8000` happens to be correct, but in production or Docker deployments (where `VITE_API_HOST` is set to the actual server URL), the setup wizard would still hit `localhost:8000` and fail or connect to the wrong server.

**Fix:** Replace `VITE_API_URL` with `VITE_API_HOST`, or better yet, use the existing `setupApi` Eden Treaty client exported from `packages/lib/src/core/api.ts:30` to get type-safe calls that automatically use the correct host.

**Status:** New finding.

### 2. Waitlist form submits empty values due to stale closure

**File:** `apps/index/src/routes/index.tsx:47-66`
**Impact:** The waitlist signup form is broken -- it always sends empty strings for `email` and `notes`, regardless of what the user typed.

```typescript
const handleWaitlistSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    // ...
    const waitlistResult = await publicApi.waitlist.post({email, notes});
    // ...
}, []);  // <-- empty dependency array
```

The callback captures `email` and `notes` from the initial render (both `""`), and the empty dependency array `[]` means the closure is never refreshed. Every form submission sends `{email: "", notes: ""}` to the API.

**Fix:** Either add `[email, notes, resetForm]` to the dependency array, or remove `useCallback` entirely since there is no performance reason for it here (the callback is only passed to a `<form onSubmit>`).

**Status:** Previously listed as Minor #2. Promoted to Critical because it is a functional bug that completely breaks the waitlist feature.

### 3. Storage type "Recommended" label is on the wrong option

**File:** `apps/setup/src/components/setup-wizard.tsx:224`
**Impact:** The setup wizard labels `local-id` as "Recommended" but the project actually defaults to `local-fullnames`.

The `local-id` radio button displays "Recommended. Files stored with unique IDs." However:
- The setup wizard's own default `formData` is `storageType: 'local-fullnames'` (line 52).
- The server-settings default in `apps/api/src/lib/config/server-settings.ts:18` is `storageType: 'local-fullnames'`.
- The most recent commit (`0ff3c26`) explicitly set `local-fullnames` as the default storage type.

The form defaults to `local-fullnames` (selected by default) but the text says `local-id` is recommended, creating a direct contradiction. Users who trust the "Recommended" label and switch to `local-id` get a non-default configuration, while users who leave the default get `local-fullnames` thinking it is not the recommended choice.

**Fix:** Move the "Recommended" label to the `local-fullnames` option, or update the form default to `local-id` if that is truly preferred. Given the recent deliberate commit setting `local-fullnames` as default, the label should move.

**Status:** New finding.

## Important Issues

### 4. Setup wizard `completeSetup` does not check `response.ok` before parsing JSON

**File:** `apps/setup/src/components/setup-wizard.tsx:31-42`
**Impact:** Server errors with non-JSON bodies cause a confusing "Network error" message instead of the actual error.

```typescript
async function completeSetup(data: SetupData) {
    const response = await fetch(`${API_URL}/setup/complete`, { ... });
    return response.json();  // No response.ok check
}
```

The API route (`apps/api/src/routes/setup.ts:8`) sets `status = 400` on validation errors and returns a JSON body with `{success: false, error: "..."}`. But if the server returns a 500 with an HTML error page, or a network proxy returns a non-JSON error, `response.json()` throws a SyntaxError, which the catch block maps to "Network error. Please try again." -- hiding the real problem.

Similarly, `checkSetupStatus` (line 26-29) also lacks a `response.ok` check.

**Fix:** Add `if (!response.ok) { const body = await response.text(); throw new Error(body || response.statusText); }` before `response.json()`.

**Status:** Previously listed as Minor #5. Promoted to Important because this is the initial setup flow where debugging issues is most critical.

### 5. Index app Login button uses relative URL that breaks in development

**File:** `apps/index/src/routes/index.tsx:40`
**Impact:** The Login button navigates to a non-existent route during development.

```typescript
const handleLogin = useCallback(() => {
    window.location.href = './space/';
}, []);
```

In development, the Index app runs on `http://localhost:3000/` and the Space app runs on `http://localhost:3004/space`. The relative `./space/` resolves to `http://localhost:3000/space/` which is not a valid app. Meanwhile, the authenticated redirect in `__root.tsx:15` correctly uses the absolute `VITE_APP_SPACE_URL` env variable. This inconsistency means:
- In development: Login button goes to wrong URL; auto-redirect goes to correct URL.
- In production: Both happen to work because all apps share the same domain.

**Fix:** Use `import.meta.env.VITE_APP_SPACE_URL` consistently, matching the approach in `__root.tsx`.

**Status:** New finding.

### 6. Setup wizard has no client-side validation beyond HTML `required`/`minLength`

**File:** `apps/setup/src/components/setup-wizard.tsx`
**Impact:** Invalid input reaches the server and returns generic error messages. The first-run experience is notably weaker than the rest of the project.

Specific gaps:
- **Password:** Only HTML `minLength={8}`. No strength indicator, unlike the Space app's `ChangePassword` component which has zod validation, a strength meter with color coding, and a confirm field.
- **Username:** Accepts spaces, special characters, unicode. The constructed email (`admin@domain`) will fail server-side email validation if the username contains invalid characters. No client-side feedback on what is acceptable.
- **Domain:** No format validation. Could submit "not a domain" or include protocols/paths.
- **S3 endpoint:** No URL format validation when provided.

The server-side `completeSetup` function validates required fields and password length, but provides only flat error strings (e.g., "S3 configuration requires bucket, region, access key, and secret key"). There is no field-level error mapping.

**Fix:** Add a zod schema similar to the Space app's password change form. At minimum, validate username format (alphanumeric/dots/hyphens), domain format (hostname pattern), and add a password strength indicator.

**Status:** Previously listed as Important #3. Reconfirmed.

### 7. Dutch comments in Index app root route

**File:** `apps/index/src/routes/__root.tsx:11-17`
**Impact:** Violates the "English everywhere" rule from CONTRIBUTING.md.

Four Dutch comments:
```typescript
// Als de gebruiker is ingelogd en probeert de root URL te bezoeken,
// stuur ze dan naar de drive app
// Gebruik window.location voor externe redirects naar andere apps
// Voorkom dat de huidige pagina laadt
```

**Fix:** Translate to English. Suggested: "If the user is authenticated and visiting the root URL, redirect to the Space app" and "Use window.location for cross-app redirects" and "Prevent the current page from loading".

**Status:** Previously listed as Important #1. Reconfirmed.

### 8. TanStackRouterDevtools unconditionally included in production

**File:** `apps/index/src/routes/__root.tsx:2,26`
**Impact:** Adds unnecessary bundle size to the public-facing landing page. This is the only app in the project that includes router devtools. All other apps use `EigenApp` which conditionally includes `ReactQueryDevtools`.

```typescript
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
// ...
<TanStackRouterDevtools position="bottom-right"/>
```

**Fix:** Remove the import and component entirely, or lazy-load it behind a dev-only check (`import.meta.env.DEV`).

**Status:** Previously listed as Important #2. Reconfirmed.

### 9. Setup wizard custom Vite config diverges from shared config

**File:** `apps/setup/vite.config.ts`
**Impact:** The setup app is the only app (out of 13) that does not use `createAppConfig()` from `vite.shared.config.ts`. It manually configures plugins, paths, and build options, missing the shared config's `tanstackRouter` plugin, `rollupOptions.treeshake` settings, and `commonjsOptions`.

Every other app, including the Index app, uses the one-liner pattern:
```typescript
import {createAppConfig} from '../../vite.shared.config'
export default createAppConfig('setup')
```

The setup app does not use TanStack Router (intentionally), which is one reason for the custom config. But the missing treeshake and commonjs settings mean the setup bundle may be larger than necessary.

**Fix:** Use `createAppConfig('setup')` with an override that removes the `tanstackRouter` plugin if needed, or add the missing build optimizations to the custom config.

**Status:** New finding.

### 10. Never-resolving Promise in authenticated redirect

**File:** `apps/index/src/routes/__root.tsx:13-18`
**Impact:** If `window.location.href` assignment is blocked (browser extension, CSP policy, popup blocker), TanStack Router's `beforeLoad` hangs forever with a pending Promise that never resolves or rejects. The user sees a blank page with no recovery path.

```typescript
if (context.auth.isAuthenticated && window.location.pathname === '/') {
    window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
    return new Promise(() => {});
}
```

**Fix:** Add a timeout fallback:
```typescript
return new Promise((_, reject) => setTimeout(() => reject(new Error('Redirect failed')), 5000));
```
Or show a loading indicator while the redirect is in progress.

**Status:** Previously listed as Important #5. Reconfirmed.

## Minor Issues

### 11. `interface` used where `type` is preferred

**Impact:** Style violation per CONTRIBUTING.md.

Non-generated files using `interface`:
- `apps/setup/src/components/setup-wizard.tsx:10` -- `interface SetupData`
- `apps/index/src/routes/__root.tsx:5` -- `interface MyRouterContext`
- `apps/index/src/components/BlogPost.tsx:7` -- `interface BlogPostProps`
- `apps/index/src/components/MediaGrid.tsx:4` -- `interface MediaItemProps`
- `apps/index/src/components/MediaGrid.tsx:76` -- `interface MediaGridProps`
- `apps/index/src/components/MediaPreview.tsx:3` -- `interface MediaPreviewProps`
- `apps/index/src/components/parse-media-grids.ts:1` -- `interface MediaItem`
- `apps/index/src/components/parse-media-grids.ts:9` -- `interface MediaGridData`
- `apps/index/scripts/generate-blog-meta.ts:4,10` -- `interface BlogPostMeta`, `interface BlogMetaData`

The `apps/index/src/main.tsx:22` `interface Register` is required by TanStack Router's module augmentation and must remain an interface. The `routeTree.gen.ts` interfaces are auto-generated and should not be changed.

**Fix:** Replace `interface X {` with `type X = {` in the listed files.

**Status:** Previously listed as Minor #1. Reconfirmed. Added the build-script interfaces.

### 12. `useEffect` dependency on `apps.length` is misleading

**File:** `apps/index/src/routes/index.tsx:30`
**Impact:** No runtime issue, but misleading code.

```typescript
React.useEffect(() => {
    const interval = setInterval(() => {
        setAppIndex((prevIndex) => (prevIndex + 1) % apps.length);
    }, 2000);
    return () => clearInterval(interval);
}, [apps.length]);
```

`apps` is a module-level constant imported from `@workspace/lib/apps`. Its `.length` never changes. An empty dependency array `[]` would communicate intent more clearly.

**Fix:** Change to `[]`.

**Status:** Previously listed as Minor #3. Reconfirmed.

### 13. Blog post `code` component destructures non-existent `inline` prop

**File:** `apps/index/src/components/BlogPost.tsx:47-52`
**Impact:** Fragile code relying on a type cast. In react-markdown v10 (which this project uses), the `inline` prop for code components was removed. The `node` prop is also destructured but unused across all component overrides (lines 23, 35-47).

```typescript
code: ({node, ...props}) => {
    const {inline, ...codeProps} = props as typeof props & { inline?: boolean };
    return inline
        ? <code className="bg-muted px-1 py-0.5 rounded text-sm" {...codeProps} />
        : <code className="block bg-muted p-4 rounded my-4 text-sm overflow-x-auto" {...codeProps} />;
},
```

Since `inline` is always `undefined` in v10, all code elements render as block elements. Inline code like `\`example\`` renders with block styling.

**Fix:** Detect inline vs block code by checking whether the parent is a `<pre>` element, or by checking the children/className. Also remove the unused `node` destructuring from all component overrides.

**Status:** Previously listed as Minor #4. Severity upgraded because inline code is visually broken in the blog.

### 14. Index app missing `HotkeysProvider` for `MediaPreview` hotkey

**File:** `apps/index/src/main.tsx` and `apps/index/src/components/MediaPreview.tsx:11`
**Impact:** Minor. `MediaPreview` uses `useHotkey('Escape', ...)` from `@tanstack/react-hotkeys`, which internally calls `useDefaultHotkeysOptions()`. The Index app does not include `HotkeysProvider` in its provider stack (unlike `EigenApp`). The library falls back to empty defaults when the context is null, so the Escape key still works, but this is an implicit dependency on library internals rather than proper context setup.

**Fix:** Either wrap the Index app in `HotkeysProvider` or use a plain `useEffect` with `addEventListener('keydown', ...)` for the single Escape handler, avoiding the external dependency.

**Status:** New finding.

### 15. Duplicated `parseFrontmatter` function

**Files:** `apps/index/src/data/blog-posts.ts:11-32` and `apps/index/scripts/generate-blog-meta.ts:14-36`
**Impact:** Code duplication. Both files contain identical `parseFrontmatter` implementations. If the frontmatter format changes, both must be updated.

**Fix:** Extract to a shared utility within the index app (e.g., `apps/index/src/utils/frontmatter.ts`) and import from both locations.

**Status:** New finding.

### 16. Setup wizard missing `autocomplete` attributes on form fields

**File:** `apps/setup/src/components/setup-wizard.tsx:318-360`
**Impact:** Password managers cannot identify the admin account fields. The Space app's `ChangePassword` component correctly uses `autoComplete="current-password"` and `autoComplete="new-password"`. The setup wizard's password field, name field, and email-like username field lack these attributes.

**Fix:** Add `autoComplete="new-password"` to the password input, `autoComplete="name"` to the admin name input, and `autoComplete="username"` to the username input.

**Status:** New finding.

### 17. Index app uses non-standard provider stack

**File:** `apps/index/src/main.tsx:34-43`
**Impact:** Maintenance cost. The Index app manually composes `QueryClientProvider` + `AuthProvider` + `Toaster`, while all other apps use `EigenApp`. Any provider additions to `EigenApp` must be manually replicated. Already missing: `ThemeProvider` (the Index app does not respond to system dark/light mode), `TooltipProvider`, `HotkeysProvider`.

**Fix:** Acceptable as-is for the current minimal scope. If the Index app grows (e.g., adding more interactive features), consider switching to `EigenApp`.

**Status:** Previously listed as Important #6. Downgraded to Minor because the landing page's minimal needs genuinely justify a simpler stack, but the missing `ThemeProvider` means it does not respect dark mode.

### 18. `vite-env.d.ts` presence inconsistent across apps

**Files:** `apps/setup/src/vite-env.d.ts`, `apps/index/src/vite-env.d.ts`
**Impact:** No runtime impact. Present in Setup and Index but absent from Space, People, Mail, and other apps.

**Status:** Previously listed as Minor #6. Reconfirmed.

## Observations

- **Setup wizard S3 connection test:** The previous review noted that the People app's ServerSettingsPage has a "Test Connection" button for S3 that is absent from the setup wizard. This remains true and is a UX gap, but given that setup is a one-time operation and the server-side `completeSetup` does not test the S3 connection either (it just saves the config), adding a frontend test button alone would require a corresponding API endpoint. This is more of a feature request than a bug.

- **PHP-based SSR for blog SEO:** The Index app has a well-thought-out deployment story. The `index.php` template with `generate-blog-meta.ts` prebuild and `post-build.ts` postbuild scripts ensure social media crawlers get correct OG tags without requiring a Node.js server. The `.htaccess` rewrite rules route all requests through PHP. This is a pragmatic solution for a static SPA that needs dynamic meta tags.

- **Blog media grid system:** The custom `<media-grid>` / `<media>` XML-in-markdown syntax parsed by `parse-media-grids.ts` is creative but non-standard. It works well for the current single blog post. If the blog grows, consider using MDX instead, which provides native component rendering in markdown without custom regex parsing.

- **Setup wizard's "Go to Login" button after completion** redirects to `/` (the Index app root). If the user is now authenticated (they just created an account but haven't signed in), they see the landing page. If they are auto-signed-in post-setup, the `__root.tsx` beforeLoad redirect sends them to Space. The flow works but the button label "Go to Login" is misleading if auto-login happens.

- **The setup app does not use TanStack Router**, which is intentional and appropriate for a single-screen wizard. The custom Vite config (Issue #9) is the main consequence of this design decision.
