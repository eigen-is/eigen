# FE Code Review: Index (Landing Page)

## Summary

The index app (`apps/index/src/`) is the public-facing landing page and blog for Eigen. It consists of 13 source files
including routes (`__root.tsx`, `index.tsx`, `blog.index.tsx`, `blog.$id.tsx`), components (`BlogPost.tsx`,
`MediaGrid.tsx`, `MediaPreview.tsx`, `parse-media-grids.ts`), data loading (`blog-posts.ts`, blog markdown files), and
build scripts (`generate-blog-meta.ts`, `post-build.ts`). The app also includes PHP server-side rendering for OG meta
tags (`index.php`) and Apache configuration (`.htaccess`).

This is a hybrid static/dynamic app: the React SPA handles client-side rendering, while PHP handles server-side meta
tag injection for social media crawlers.

## Critical Issues

### 1. Missing `await` on waitlist API call (error path)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, lines 51-63

```typescript
const waitlistResult = await publicApi.waitlist.post({email, notes});
```

The `await` is present here (good), but the error handling is incomplete. If the API call throws a network error, the
`catch` block is never reached because there is no try/catch around this section -- the only error path is
`waitlistResult.data === true` vs not-true. However, if the Eden Treaty call itself throws (network failure, JSON
parse error), the `catch` is missing entirely. The function does not have a try/catch.

Wait -- re-reading the code: the `handleWaitlistSubmit` callback has no try/catch at all. If `publicApi.waitlist.post`
throws, the error propagates uncaught, `setIsSubmitting(false)` in `resetForm()` never runs, and the form stays in a
permanently disabled "Submitting..." state.

**Fix**: Wrap the API call in try/catch:

```typescript
try {
    const waitlistResult = await publicApi.waitlist.post({email, notes});
    // ...
} catch {
    toast.error('Network error', { description: 'Please try again' });
} finally {
    setIsSubmitting(false);
}
```

### 2. Authenticated user redirect creates infinite hang

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/__root.tsx`, lines 13-19

```typescript
if (context.auth.isAuthenticated && window.location.pathname === '/') {
    window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
    return new Promise(() => {});
}
```

The `return new Promise(() => {})` creates a promise that never resolves, preventing the route from loading while the
browser navigates away. This works in the happy path, but if `VITE_APP_SPACE_URL` is undefined or empty, the browser
navigates to the current page (or an invalid URL), and the route is permanently stuck in a loading state with no
way to recover. The user sees a blank page.

Additionally, this redirect only triggers for the root path `/`. If an authenticated user visits `/blog`, they can
still access the landing page blog -- which may be intentional (public blog) or not.

**Fix**: Add a fallback for the env variable:

```typescript
const spaceUrl = import.meta.env.VITE_APP_SPACE_URL;
if (context.auth.isAuthenticated && window.location.pathname === '/' && spaceUrl) {
    window.location.href = spaceUrl;
    return new Promise(() => {});
}
```

## Pattern Violations

### 1. Hardcoded colors throughout

**File**: Multiple files

CLAUDE.md rule: "Use theme tokens, not hardcoded colors."

Violations found:

- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, line 101: `text-blue-600 hover:text-blue-800`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/blog.index.tsx`, line 45:
  `text-blue-600 hover:text-blue-800`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/blog.index.tsx`, line 64: `hover:text-blue-600`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/blog.$id.tsx`, lines 65, 80:
  `text-blue-600 hover:text-blue-800`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/BlogPost.tsx`, line 43: `text-blue-600`

All link colors use hardcoded `text-blue-600`/`text-blue-800` instead of theme tokens like `text-primary`. These will
look wrong in dark mode.

**Fix**: Replace with `text-primary hover:text-primary/80` or a similar theme-aware token.

### 2. `interface` used instead of `type` in multiple files

CLAUDE.md rule: "Always `type` over `interface`."

Violations:

- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/__root.tsx`, line 5: `interface MyRouterContext`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/MediaPreview.tsx`, line 3:
  `interface MediaPreviewProps`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/BlogPost.tsx`, line 7: `interface BlogPostProps`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/MediaGrid.tsx`, lines 4, 76:
  `interface MediaItemProps`, `interface MediaGridProps`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/parse-media-grids.ts`, lines 1, 9:
  `interface MediaItem`, `interface MediaGridData`
- `/Users/reinder/Documents/GitHub/eigen/apps/index/src/scripts/generate-blog-meta.ts`, lines 4, 10:
  `interface BlogPostMeta`, `interface BlogMetaData`

The `routeTree.gen.ts` interfaces are auto-generated and excluded from this finding.

### 3. `useQuery`/`useMutation` not used through hooks layer

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, lines 47-64

The waitlist submission uses `publicApi` directly in a component event handler rather than through a hook in
`packages/lib/src/core/[domain]/hooks/`. CLAUDE.md says all data hooks should live in the shared hooks layer. For the
landing page's waitlist feature, a `useWaitlistMutation()` hook would be appropriate.

### 4. Inline style usage

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, lines 71-72

```typescript
<span className="font-bold" style={{color: app.color}}>eigen</span>
<span style={{color: app.color}}>|{app.name.toLowerCase()}&gt;</span>
```

While using `style` for dynamic CSS variable values (`var(--app-space-color)`) is necessary since Tailwind cannot
process dynamic values, this is a known pattern in the codebase. No issue here.

## Security Concerns

### 1. XSS via blog content (markdown rendering)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/BlogPost.tsx`, lines 21-57

Blog posts are rendered from markdown files using `react-markdown`. By default, `react-markdown` sanitizes HTML, so
raw `<script>` tags in markdown will not execute. However, the custom `<media-grid>` and `<media>` tags are parsed
with regex in `parse-media-grids.ts` before being passed to `react-markdown`. The `src` attributes from these custom
tags are used directly in `<img>` and `<video>` elements without sanitization.

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/parse-media-grids.ts`, lines 30-38

If a blog post (authored by a developer) contains a `<media src="javascript:alert(1)">`, it would be passed directly
to the `<img>` tag. Since blog posts are checked into the repository (not user-generated), this is low risk, but the
pattern of unsanitized `src` attributes is worth noting.

### 2. Open redirect via waitlist form

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, line 40

```typescript
window.location.href = '/space/';
```

The login button redirects to `/space/` which is a relative path. This is safe. No open redirect issue.

### 3. Email not validated client-side beyond `type="email"`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, line 120

The waitlist email input uses `type="email"` for basic browser validation, and the backend uses
`validateEmailAddress()`. This is adequate.

## Data Integrity

### 1. Blog post lookup by ID has no 404 route handling

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/blog.$id.tsx`, lines 60-73

When a blog post is not found, the component renders a "Post not found" message. This is client-side only. The HTTP
response is still 200. For SEO, a 404 status code would be better. The PHP server-side rendering (`index.php`) does
not return a 404 status for unknown blog post IDs either.

### 2. `parseFrontmatter` is duplicated

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/data/blog-posts.ts`, lines 11-32 and
`/Users/reinder/Documents/GitHub/eigen/apps/index/scripts/generate-blog-meta.ts`, lines 14-36

The `parseFrontmatter()` function is copy-pasted between the runtime blog loader and the build-time meta generator.
If one is updated and the other is not, blog metadata could be parsed inconsistently.

**Fix**: Extract into a shared utility.

### 3. Blog posts loaded eagerly at module level

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/data/blog-posts.ts`, line 56

```typescript
export const blogPosts: BlogPost[] = parseBlogPosts();
```

All blog posts are parsed at module load time via Vite's `import.meta.glob` with `eager: true`. For a small number
of posts this is fine, but as the blog grows, this will increase initial bundle size since all markdown content is
inlined into the JavaScript bundle.

## Code Quality

### 1. Unused `React` import

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, line 3

```typescript
import React, {useCallback} from 'react';
```

`React` is imported as a default import but only used for `React.useState`, `React.useEffect`, and
`React.ChangeEvent`/`React.FormEvent` types. The code mixes `React.useState` (line 17) with destructured
`useCallback` (line 3). This should be consistent -- either use `useState` destructured or `React.useState`
everywhere.

### 2. `apps.length` in useEffect dependency array

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, lines 24-30

```typescript
React.useEffect(() => {
    const interval = setInterval(() => {
        setAppIndex((prevIndex) => (prevIndex + 1) % apps.length);
    }, 2000);
    return () => clearInterval(interval);
}, [apps.length]);
```

`apps` is a module-level constant that never changes. Including `apps.length` in the dependency array is harmless
but misleading -- it suggests the effect should re-run if the list changes, which it never will. Use `[]` instead.

### 3. Artificial delay in waitlist submission

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/routes/index.tsx`, lines 53-55

```typescript
const duration = new Date().getTime() - time;
await new Promise(resolve => setTimeout(resolve, Math.max(350 - duration, 0)));
```

This adds an artificial minimum delay of 350ms to the waitlist submission. While this may be for UX purposes
(preventing a jarring flash), it should be documented with a comment explaining why. The pattern of timing API calls
and adding compensating delays is unusual.

### 4. `MediaGrid` key uses array index

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/MediaGrid.tsx`, line 88

```typescript
<MediaItem key={index} ... />
```

Using array index as React key is an anti-pattern when items can be reordered or filtered. Since media grid items are
static (from markdown), this is safe in practice, but a content-based key (e.g., `src`) would be more robust.

### 5. `node` destructured but unused in ReactMarkdown components

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/BlogPost.tsx`, lines 23, 35-46

Every custom component destructures `node` but does not use it: `({node, ...props})`. This is to prevent `node` from
being spread onto the DOM element, which is correct, but a comment would help explain this to future developers.

### 6. `inline` prop handling in code component

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/components/BlogPost.tsx`, lines 47-53

```typescript
const {inline, ...codeProps} = props as typeof props & { inline?: boolean };
```

This uses `as` to add an `inline` property to the props type. This is a workaround for react-markdown's typing. The
cast is safe but fragile -- if react-markdown changes its API, this will silently break.

## Architecture

### 1. PHP/Apache deployment is non-standard for the project

The index app uniquely requires PHP and Apache (or nginx) for production deployment, while all other apps are served
through the Bun/Elysia server or as static files. This creates operational complexity:

- `.htaccess` for Apache URL rewriting
- `index.php` for server-side meta tag rendering
- `post-build.ts` script to transform `index.html` into `index.php`
- `generate-blog-meta.ts` to create `blog-meta.json`

This PHP layer exists solely for social media OG tag rendering. Consider alternatives:

- Pre-rendering blog pages at build time (static HTML per post)
- Using the Elysia server to serve index pages with proper meta tags
- Using a lightweight SSR solution

### 2. No EigenApp provider wrapper (partial)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/src/main.tsx`

The index app sets up its own provider stack: `QueryClientProvider -> AuthProvider -> Toaster -> RouterProvider`. It
does not use `EigenApp` from `packages/ui`, which makes sense since it does not need SSE, upload, preview, or hotkeys
providers. However, it does use `AuthProvider` and `QueryClient` -- the auth context is used only in `__root.tsx` for
the authenticated-user redirect.

### 3. Build scripts use `interface` keyword

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/index/scripts/generate-blog-meta.ts`, lines 4, 10

The build scripts also use `interface` instead of `type`, violating the project convention. These run at build time
only but should still follow project conventions.

## Positive Patterns

1. **Good SEO structure**: Blog posts have proper OG meta tags, both client-side (via TanStack Router `head`) and
   server-side (via PHP for crawlers).
2. **Accessible forms**: Waitlist form uses proper `<Label>`, `<Input>`, `type="email"`, `required`, and `disabled`
   states.
3. **Proper theme token usage (mostly)**: Background colors use `bg-background`, `bg-muted/50`, text uses
   `text-muted-foreground`, `text-foreground`. Only link colors are hardcoded.
4. **Clean blog data architecture**: Markdown files with frontmatter, parsed at build time for PHP and at runtime for
   React. The `import.meta.glob` pattern is clean.
5. **Media grid system**: The custom `<media-grid>` markdown extension with preview lightbox is well-built. The regex
   parser in `parse-media-grids.ts` handles multiple attribute formats (`thumbnail` and `thumb` aliases).
6. **Keyboard support**: `MediaPreview` uses `useHotkey('Escape', ...)` for closing the preview modal.
7. **Proper link handling**: Uses TanStack Router `<Link>` for internal navigation, `window.location.href` for
   cross-app navigation.
8. **Clean responsive grid**: `MediaGrid` maps column counts to responsive Tailwind classes.
9. **Scroll restoration**: Router is configured with `scrollRestoration: true`.

## Recommendations

| Priority | Issue                                      | Description                                                                 |
|----------|--------------------------------------------|-----------------------------------------------------------------------------|
| **P0**   | Missing try/catch on waitlist submit       | Form gets stuck in "Submitting..." state on network error                   |
| **P0**   | Never-resolving promise on missing env var | Authenticated redirect hangs if `VITE_APP_SPACE_URL` is undefined           |
| **P1**   | Hardcoded blue link colors                 | Replace `text-blue-600`/`text-blue-800` with theme tokens across all routes |
| **P1**   | Duplicated `parseFrontmatter`              | Extract to shared utility between runtime and build script                  |
| **P2**   | `interface` -> `type`                      | Change ~10 `interface` declarations to `type` across all files              |
| **P2**   | Waitlist hook                              | Move waitlist API call to `packages/lib/src/core/public/hooks/`             |
| **P2**   | Inconsistent React import style            | Use destructured imports (`useState`, `useEffect`) consistently             |
| **P2**   | Document artificial delay                  | Add comment explaining the 350ms minimum delay on waitlist submit           |
| **P2**   | Blog 404 status                            | Return proper 404 HTTP status for unknown blog post IDs                     |
| **P2**   | PHP dependency                             | Consider pre-rendering or Elysia-based SSR to eliminate PHP requirement     |
