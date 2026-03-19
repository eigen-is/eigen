# Frontend Review: Setup Wizard + Index App

**Scope:** `apps/setup/`, `apps/index/`
**Reviewed:** 2026-03-19

---

## Architecture Overview

### Setup Wizard (`apps/setup/`)

A standalone single-page app for first-run server configuration. Runs on port 3011 at `/setup`. Three source files
total: `main.tsx` (entry), `vite-env.d.ts`, and `components/setup-wizard.tsx` (the entire UI).

**Flow:**

1. On mount, calls `GET /setup/status` to check if the server is already configured.
2. If already set up, shows "Already Configured" card with a "Go to Login" button (navigates to `/`).
3. If setup is required, shows a single-page form with three sections: server configuration (domain, org name, storage
   type), optional S3 credentials (shown when S3 storage is selected), and admin account creation (name, username,
   password).
4. On submit, calls `POST /setup/complete` with the form data plus a derived `adminEmail` field (`username@domain`).
5. On success, shows "Setup Complete!" card with a "Go to Login" button.

**Key design decisions:**

- Does NOT use TanStack Router (intentionally -- single-page wizard has no routes).
- Does NOT use Eden Treaty API client -- makes raw `fetch()` calls to the API.
- Has its own custom Vite config instead of the shared `createAppConfig()`.
- Minimal dependency footprint: just `@workspace/ui` for shadcn components and `@workspace/lib` (unused at runtime).

### Index / Landing Page (`apps/index/`)

The public-facing landing page at `/`. Uses TanStack Router with three routes: `/` (home), `/blog/` (blog list),
`/blog/$id` (individual blog posts). Runs on port 3000.

**Home page (`/`):** Animated app name rotator cycling through Eigen apps (Space, Calendar, Chat, etc.) every 2 seconds,
tagline, Login button, Join Waitlist button (reveals inline form), and "Learn more" link to blog.

**Blog:** Markdown-based blog system with a custom `<media-grid>` / `<media>` XML syntax parsed from markdown. Supports
image/video grids with lightbox preview. Blog posts are loaded at build time via `import.meta.glob`. Metadata is
pre-generated as JSON for PHP-based SSR (OG tags for social media crawlers).

**Authenticated redirect:** If the user is already logged in and visits `/`, the `__root.tsx` `beforeLoad` guard
redirects them to the Space app via `window.location.href`.

---

## Critical Issues

### 1. Setup wizard uses wrong env variable name for API URL

**File:** `apps/setup/src/components/setup-wizard.tsx:24`
**Impact:** The setup wizard silently falls back to the hardcoded `http://localhost:8000` in every non-development
environment.

```typescript
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
```

Every other app and the shared API client (`packages/lib/src/core/api.ts:12`) uses `VITE_API_HOST`. The env files (
`.env.dev.local`, `.env.eigen`, `.env.docker.local`) define `VITE_API_HOST` -- there is no `VITE_API_URL` anywhere. In
development the fallback `localhost:8000` happens to match, but in Docker (`VITE_API_HOST=http://localhost/eigen`) or
production (`VITE_API_HOST=https://api.eigen.is`), the setup wizard hits `localhost:8000` and fails silently.

**Fix:** Replace `VITE_API_URL` with `VITE_API_HOST`, or better yet, replace the raw `fetch()` calls with the existing
`setupApi` Eden Treaty client exported from `packages/lib/src/core/api.ts:30`. This provides type safety and
automatically uses the correct host.

---

## Important Issues

### 2. Setup wizard `completeSetup` and `checkSetupStatus` do not check `response.ok`

**File:** `apps/setup/src/components/setup-wizard.tsx:26-42`
**Impact:** Server errors with non-JSON bodies produce a misleading "Network error" message instead of the actual error.

```typescript
async function checkSetupStatus() {
    const response = await fetch(`${API_URL}/setup/status`)
    return response.json()  // No response.ok check
}

async function completeSetup(data: SetupData) {
    // ...
    const response = await fetch(`${API_URL}/setup/complete`, { ... })
    return response.json()  // No response.ok check
}
```

The API route (`apps/api/src/routes/setup.ts:8-10`) returns `{success: false, error: "..."}` with status 400 for
validation errors, which `response.json()` handles fine. But if the server returns a 500 with an HTML error page, or a
network proxy returns a non-JSON error, `response.json()` throws a `SyntaxError`, which the `catch` block (line 96) maps
to the generic "Network error. Please try again." -- hiding the real problem during the most critical setup phase.

**Fix:** Add `if (!response.ok) throw new Error(await response.text() || response.statusText)` before `response.json()`
in both functions. Or switch to the Eden Treaty client (which handles this automatically).

### 3. Index app Login button uses absolute path that breaks in development

**File:** `apps/index/src/routes/index.tsx:40`
**Impact:** The Login button navigates to a non-existent route during development.

```typescript
const handleLogin = useCallback(() => {
    window.location.href = '/space/';
}, []);
```

In development, the Index app runs on `http://localhost:3000/` and the Space app runs on `http://localhost:3004/space`.
The path `/space/` resolves to `http://localhost:3000/space/` which is not a valid app. Meanwhile, the authenticated
redirect in `__root.tsx:15` correctly uses the absolute `VITE_APP_SPACE_URL` env variable. This inconsistency means:
- In development: Login button goes to wrong URL; auto-redirect goes to correct URL.
- In production: Both work because all apps share the same domain under different paths.

**Fix:** Use `import.meta.env.VITE_APP_SPACE_URL` consistently, matching the approach in `__root.tsx`.

### 4. Setup wizard has no client-side validation beyond HTML `required`/`minLength`

**File:** `apps/setup/src/components/setup-wizard.tsx`
**Impact:** Invalid input reaches the server and returns generic error messages. The first-run experience is notably weaker than the rest of the project.

Specific gaps:

- **Password:** Only HTML `minLength={8}`. No strength indicator, no confirm field. Compare with the Space app's
  `ChangePassword` component which uses zod validation with a strength meter and color coding.
- **Username:** Accepts spaces, special characters, unicode. The derived email (`admin@domain`) will fail server-side
  validation if the username contains invalid characters. No client-side feedback on what characters are acceptable.
- **Domain:** No format validation. Users can submit "not a domain" or include protocols/paths.
- **S3 endpoint:** No URL format validation when provided.

The server-side `completeSetup` (in `apps/api/src/lib/setup/setup.ts:163-262`) validates required fields and password
length but returns only flat error strings (e.g., "S3 configuration requires bucket, region, access key, and secret
key"). There is no field-level error mapping back to the form.

**Fix:** Add a validation schema (zod or similar). At minimum: validate username format (alphanumeric/dots/hyphens),
domain format (hostname pattern), and add a password strength indicator consistent with the Space app.

### 5. TanStackRouterDevtools unconditionally included in production

**File:** `apps/index/src/routes/__root.tsx:2,26`
**Impact:** Adds unnecessary bundle size to the public-facing landing page. This is the only app in the project that
unconditionally includes devtools.

```typescript
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
// ...
<TanStackRouterDevtools position="bottom-right"/>
```

All other apps use `EigenApp` which conditionally includes `ReactQueryDevtools` only in development.

**Fix:** Remove the import and component entirely, or lazy-load behind a dev check:
`{import.meta.env.DEV && <TanStackRouterDevtools ... />}`.

### 6. Setup wizard custom Vite config diverges from shared config

**File:** `apps/setup/vite.config.ts`
**Impact:** The setup app is the only app (out of 13) that does not use `createAppConfig()` from
`vite.shared.config.ts`. It manually configures plugins, paths, and build options, missing the shared config's
`rollupOptions.treeshake` settings (`preset: 'smallest'`) and `commonjsOptions` (`defaultIsModuleExports: 'auto'`).

Every other app uses the one-liner pattern:
```typescript
import {createAppConfig} from '../../vite.shared.config'
export default createAppConfig('setup')
```

The setup app intentionally omits TanStack Router (it has no routes), but the missing build optimizations mean the setup
bundle may be larger than necessary.

**Fix:** Use `createAppConfig('setup')` and override or remove the `tanstackRouter` plugin, or manually add the missing
`rollupOptions.treeshake` and `commonjsOptions` to the custom config.

### 7. Never-resolving Promise in authenticated redirect

**File:** `apps/index/src/routes/__root.tsx:17-18`
**Impact:** If the `window.location.href` assignment is blocked or fails (browser extension, CSP policy, navigation
guard), TanStack Router's `beforeLoad` hangs forever with a pending Promise. The user sees a blank page with no recovery
path.

```typescript
if (context.auth.isAuthenticated && window.location.pathname === '/') {
    window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
    return new Promise(() => {});
}
```

Under normal conditions this works fine because the page navigates away. But if anything prevents the navigation, there
is no timeout or fallback -- the app is frozen.

**Fix:** Add a timeout fallback:
```typescript
return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Redirect failed')), 5000)
);
```

Or render a "Redirecting..." screen and fall through to the normal page if the redirect does not happen within a few
seconds.

---

## Minor Issues

### 8. `interface` used where `type` is preferred

**Impact:** Style violation per CONTRIBUTING.md ("Always `type` over `interface`").

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

### 9. `useEffect` dependency on `apps.length` is misleading

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

`apps` is a module-level constant imported from `@workspace/lib/apps`. Its `.length` never changes. An empty dependency
array `[]` would communicate the intent (run once on mount) more clearly.

**Fix:** Change to `[]`.

### 10. Blog post `code` component destructures non-existent `inline` prop

**File:** `apps/index/src/components/BlogPost.tsx:47-52`
**Impact:** In react-markdown v10 (used by this project per `apps/index/package.json`), the `inline` prop for code
components was removed. The code casts `props` to add `inline?: boolean` but the value is always `undefined`, so all
code elements render with block styling. Inline code like `` `example` `` appears as full-width block elements.

```typescript
code: ({node, ...props}) => {
    const {inline, ...codeProps} = props as typeof props & { inline?: boolean };
    return inline
        ? <code className="bg-muted px-1 py-0.5 rounded text-sm" {...codeProps} />
        : <code className="block bg-muted p-4 rounded my-4 text-sm overflow-x-auto" {...codeProps} />;
},
```

The `node` prop is also destructured but unused across all component overrides (lines 23, 35-47).

**Fix:** Detect inline vs block code by checking whether the parent element is `<pre>` (block code is wrapped in
`<pre><code>`, inline code is just `<code>`). Remove unused `node` destructuring from all component overrides.

### 11. Index app missing `HotkeysProvider` for `MediaPreview` hotkey

**File:** `apps/index/src/main.tsx` and `apps/index/src/components/MediaPreview.tsx:11`
**Impact:** `MediaPreview` uses `useHotkey('Escape', ...)` from `@tanstack/react-hotkeys`. The Index app does not
include `HotkeysProvider` in its provider stack (unlike `EigenApp` which wraps all other apps). The library falls back
to empty defaults when the context is missing, so the Escape key works in practice, but this relies on library
internals.

**Fix:** Either add `HotkeysProvider` to the Index app, or replace with a plain `useEffect`/
`addEventListener('keydown', ...)` for the single Escape handler.

### 12. Duplicated `parseFrontmatter` function

**Files:** `apps/index/src/data/blog-posts.ts:11-32` and `apps/index/scripts/generate-blog-meta.ts:14-36`
**Impact:** Identical implementations. If the frontmatter format changes, both must be updated in sync.

**Fix:** Extract to a shared utility (e.g., `apps/index/src/utils/frontmatter.ts`) and import from both locations.

### 13. Setup wizard missing `autocomplete` attributes on form fields

**File:** `apps/setup/src/components/setup-wizard.tsx:318-360`
**Impact:** Password managers cannot identify the admin account fields. The Space app's `ChangePassword` component
correctly uses `autoComplete` attributes.

**Fix:** Add `autoComplete="new-password"` to the password input, `autoComplete="name"` to the admin name input, and `autoComplete="username"` to the username input.

### 14. Index app uses non-standard provider stack

**File:** `apps/index/src/main.tsx:34-43`
**Impact:** The Index app manually composes `QueryClientProvider` + `AuthProvider` + `Toaster`, while all other apps use
`EigenApp` (`packages/ui/src/components/layout/app/eigen-app.tsx`). Missing from the Index app: `ThemeProvider` (no dark
mode support), `TooltipProvider`, `HotkeysProvider`.

This is acceptable for the current minimal scope. The landing page does not need most of `EigenApp`'s features. However,
the missing `ThemeProvider` means the landing page always renders in light mode even if the user's system prefers dark
mode.

### 15. Hardcoded colors in both apps

**Impact:** Violates the project rule "Use theme tokens, not hardcoded colors."

Setup wizard:

- `apps/setup/src/components/setup-wizard.tsx:137` -- `bg-green-100` (success icon background)
- `apps/setup/src/components/setup-wizard.tsx:138` -- `text-green-600` (success checkmark)

Index app (throughout blog components):

- `apps/index/src/routes/index.tsx:101` -- `text-blue-600 hover:text-blue-800` (Learn more link)
- `apps/index/src/routes/blog.index.tsx:45` -- `text-blue-600 hover:text-blue-800` (Back to home link)
- `apps/index/src/routes/blog.index.tsx:64` -- `hover:text-blue-600` (Blog post title hover)
- `apps/index/src/routes/blog.$id.tsx:65,80` -- `text-blue-600 hover:text-blue-800` (Back to blog links)
- `apps/index/src/components/BlogPost.tsx:43` -- `text-blue-600` (markdown links)

These colors break in dark mode. The setup wizard's green should use theme-aware success colors, and the blog's blue
links should use `text-primary` or a theme-aware link color.

### 16. `vite-env.d.ts` presence inconsistent

**Files:** `apps/setup/src/vite-env.d.ts`, `apps/index/src/vite-env.d.ts`
**Impact:** No runtime impact. Present in Setup and Index but absent from most other apps.

---

## Corrections from Previous Review

The previous review (dated 2026-03-18) contained several findings that do not match the current source code. These have
been verified as false positives or already-fixed issues:

### Previously Critical #2: Waitlist stale closure -- FALSE POSITIVE

The previous review claimed `handleWaitlistSubmit` had an empty dependency array `[]`, causing the closure to always
capture empty strings. The actual code at `apps/index/src/routes/index.tsx:66` shows:

```typescript
}, [email, notes]);
```

The dependency array correctly includes `email` and `notes`. The waitlist form works as intended. This was likely fixed
between the previous review and now, or the previous review misread the code.

### Previously Critical #3: "Recommended" label on wrong option -- FALSE POSITIVE

The previous review claimed `local-id` was labeled "Recommended". The actual code at
`apps/setup/src/components/setup-wizard.tsx:222-234` shows:

- `local-id` (line 222-225): "Files stored with unique IDs." (no "Recommended" label)
- `local-fullnames` (line 232-234): "Recommended. Files stored with original filenames."

The "Recommended" label is correctly on `local-fullnames`, which matches the form default (
`storageType: 'local-fullnames'` at line 52) and the server default (`apps/api/src/lib/config/server-settings.ts:18`).
No issue exists.

### Previously Important #7: Dutch comments -- ALREADY FIXED

The previous review quoted four Dutch comments in `apps/index/src/routes/__root.tsx`. The current code at lines 11-18
contains English comments:

```typescript
// If the user is logged in and tries to visit the root URL,
// redirect them to the drive app
// Use window.location for external redirects to other apps
// Prevent the current page from loading
```

The comment on line 12 says "redirect them to the drive app" but the actual redirect target is the Space app. This is a
minor inaccuracy in the comment, not a bug.

### Previously Important #5: Login URL uses relative path -- CORRECTED

The previous review quoted `'./space/'` (relative) but the actual code at line 40 is `'/space/'` (absolute
root-relative). The core issue remains valid -- in development, `http://localhost:3000/space/` is not the Space app --
but the description was inaccurate. Updated as Issue #3 in this review.

---

## Strengths

1. **Clean separation of concerns.** The setup wizard is a standalone app with zero coupling to the main app
   infrastructure. It uses only shadcn UI components and raw `fetch`. This is appropriate for a first-run tool that must
   work before the full system is configured.

2. **Proper theme token usage in layout.** Both apps use `bg-background`, `text-muted-foreground`, `bg-muted`, `border`,
   `text-primary`, `bg-destructive/10`, `text-destructive` throughout their layouts. The hardcoded colors (Issue #15)
   are limited to decorative elements and links.

3. **Blog deployment architecture.** The PHP-based SSR for OG tags (`index.php` + `generate-blog-meta.ts` prebuild +
   `post-build.ts` postbuild) is a pragmatic solution. Social media crawlers get correct meta tags without requiring a
   Node.js server in production. The `.htaccess` rewrite rules are minimal and correct.

4. **Blog media system.** The `<media-grid>` / `<media>` markdown extension in `parse-media-grids.ts` is
   well-implemented: clean regex parsing, `useMemo` for performance, image/video support with thumbnails, posters, and a
   lightbox preview. The `MediaGrid` component handles responsive column layouts cleanly.

5. **Setup wizard error handling pattern.** The `handleSubmit` function correctly uses try/catch with explicit error
   state, loading state, and a finally block. The error display uses destructive theme tokens.

6. **Waitlist form UX polish.** The artificial minimum submission time (`Math.max(350 - duration, 0)`) prevents the form
   from appearing to flash on fast connections. Form reset and toast feedback are handled consistently.

---

## Coverage Analysis

| Area                       | Files                               | Status                                                         |
|----------------------------|-------------------------------------|----------------------------------------------------------------|
| Setup wizard core flow     | `setup-wizard.tsx`                  | Functional. Main gap: wrong env variable (Critical #1)         |
| Setup server configuration | `setup-wizard.tsx` L179-311         | Works. Missing client validation (Important #4)                |
| Setup admin account        | `setup-wizard.tsx` L314-366         | Works. Missing autocomplete (Minor #13)                        |
| Landing page               | `index/routes/index.tsx`            | Works. Login URL broken in dev (Important #3)                  |
| Waitlist form              | `index/routes/index.tsx` L47-66     | Functional (previous stale closure finding was false positive) |
| Authenticated redirect     | `index/routes/__root.tsx` L10-19    | Works with fragility risk (Important #7)                       |
| Blog list                  | `index/routes/blog.index.tsx`       | Works correctly                                                |
| Blog post                  | `index/routes/blog.$id.tsx`         | Works. Inline code styling broken (Minor #10)                  |
| Blog markdown rendering    | `index/components/BlogPost.tsx`     | Works for current content                                      |
| Blog media grids           | `index/components/MediaGrid.tsx`    | Works correctly                                                |
| Blog media preview         | `index/components/MediaPreview.tsx` | Works (missing provider is non-blocking)                       |
| Blog data loading          | `index/data/blog-posts.ts`          | Works correctly                                                |
| Blog SEO/SSR               | `index/index.php`, `scripts/*`      | Works correctly                                                |
| Build configuration        | `setup/vite.config.ts`              | Functional but divergent (Important #6)                        |

---

## Summary

| Severity  | Count |
|-----------|-------|
| Critical  | 1     |
| Important | 6     |
| Minor     | 9     |

The single critical issue (wrong env variable) makes the setup wizard non-functional in Docker and production
deployments. The important issues are a mix of robustness gaps (missing `response.ok` checks, never-resolving Promise)
and development-environment friction (wrong login URL, devtools in production, divergent build config). The minor issues
are primarily style consistency matters.

Three findings from the previous review were false positives (waitlist stale closure, Recommended label, Dutch
comments), and one was inaccurately described (login URL relative vs absolute). These have been corrected in this
review.

---

## Relevant Files

| File                                             | Role                                      |
|--------------------------------------------------|-------------------------------------------|
| `apps/setup/src/components/setup-wizard.tsx`     | Entire setup wizard UI                    |
| `apps/setup/src/main.tsx`                        | Setup app entry point                     |
| `apps/setup/vite.config.ts`                      | Custom Vite config (diverges from shared) |
| `apps/index/src/routes/__root.tsx`               | Root route with auth redirect             |
| `apps/index/src/routes/index.tsx`                | Landing page with waitlist form           |
| `apps/index/src/routes/blog.index.tsx`           | Blog list page                            |
| `apps/index/src/routes/blog.$id.tsx`             | Individual blog post page                 |
| `apps/index/src/components/BlogPost.tsx`         | Markdown blog post renderer               |
| `apps/index/src/components/MediaGrid.tsx`        | Media grid component                      |
| `apps/index/src/components/MediaPreview.tsx`     | Lightbox media preview                    |
| `apps/index/src/components/parse-media-grids.ts` | Custom markdown grid parser               |
| `apps/index/src/data/blog-posts.ts`              | Blog post data loader                     |
| `apps/index/src/main.tsx`                        | Index app entry point                     |
| `apps/index/index.php`                           | PHP SSR template for OG tags              |
| `apps/index/scripts/generate-blog-meta.ts`       | Prebuild blog metadata generator          |
| `apps/index/scripts/post-build.ts`               | Postbuild asset path updater              |
| `packages/lib/src/core/api.ts`                   | Shared API client (has `setupApi` export) |
| `packages/lib/src/core/apps.ts`                  | App list used by landing page rotator     |
| `apps/api/src/routes/setup.ts`                   | Setup API routes                          |
| `apps/api/src/lib/setup/setup.ts`                | Setup business logic                      |
| `vite.shared.config.ts`                          | Shared Vite configuration factory         |
