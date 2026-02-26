# Public API & Avatar Resolution Plan

## Current State

### Avatar resolution chain (`useAvatar` hook)

`packages/lib/src/lib/media/hooks/avatar.ts` resolves avatars through a multi-step chain:

1. Call `useContacts()` → load **all** contacts into memory
2. Find matching contact by email
3. If contact has avatar → use it
4. If no avatar AND email is `@eigen.is` → call `usePublicUser(email)`
5. `usePublicUser` → `GET /space/:emailOrId/public` → returns `{ name, email, avatar }`
6. Avatar URL is `space/:userId/avatar/:filename` (served by `GET /space/:ownerId/avatar/:filename`)

### Components using this chain

| Component | File | How it resolves avatars |
|-----------|------|----------------------|
| `UserAvatar` | `packages/ui/.../user-avatar.tsx` | `useAvatar(email)` unless `forceUseImageUrl` |
| `UserPublicAvatar` | `packages/ui/.../user-public-avatar.tsx` | `useAvatar(email)` → passes result to `UserAvatar` with `forceUseImageUrl` |
| `UserItem` | `packages/ui/.../user-item.tsx` | `useAvatar(email)` when `autoFetch=true` |
| `UserPublicItem` | `packages/ui/.../user-item.tsx` | Wrapper around `UserItem` with `autoFetch` |
| `ContactAutosuggest` | `packages/ui/.../contacts/contact-autosuggest.tsx` | Uses `useContactSuggestions` (fetches contacts) |

### Current public endpoints (unauthenticated)

```
GET /space/:ownerId/public           → { name, email, avatar }
GET /space/:ownerId/avatar/:filename → image/webp binary
POST /space/waitlist                 → waitlist signup
```

### Current authenticated endpoints in same router

```
POST /space/nu                       → create user (auth: true)
```

---

## Question 1: ContactsProvider / AvatarProvider?

**Verdict: No.** TanStack Query already provides the caching, deduplication, and background refetch that a React context provider would offer. `useContacts()` has `staleTime: 5min` and `usePublicUser()` has `staleTime: Infinity` — multiple components calling these hooks share the same cached data automatically. Adding a provider would be an unnecessary layer.

## Question 2: Public gravatar-like service?

**Verdict: Yes — worth doing.** A direct avatar image endpoint keyed by email would simplify the client significantly.

### Current flow (complex)

```
Component mount
  → useAvatar(email)
    → useContacts()          // fetches ALL contacts
    → find match by email
    → usePublicUser(email)   // separate API call
    → get avatar path
  → <img src={API_HOST + avatarPath}>
```

### Proposed flow (simple)

```
<img src={API_HOST}/p/avatar/{email}?fallback=digidoodle>
```

One URL, no client-side resolution logic, HTTP-cacheable, works without authentication.

---

## Question 3: Route namespace strategy

### Option A: Make all `/space/` routes public, add new namespace for Space app

Bad because:
- Space app needs authenticated routes (profile editing, settings, etc.)
- Mixing auth and no-auth in the same namespace is what we already have and it's confusing
- Would require moving authenticated Space app routes elsewhere

### Option B: New `/p/` namespace for public endpoints, keep `/space/` for Space app ✅

Good because:
- Clear separation: `/p/` = public, no auth required
- `/space/` stays clean for the Space frontend app's authenticated routes
- Short prefix, easy to remember
- Consistent convention for any future public endpoints

**Recommendation: Option B.**

---

## Implementation Plan

### Phase 1: Create `/p/` public router

**New file:** `apps/api/src/routes/public.ts`

```
GET /p/user/:emailOrId       → { name, email, avatar }    (move from /space/:ownerId/public)
GET /p/avatar/:emailOrId     → image binary with fallback  (new: resolves email → avatar in one step)
POST /p/waitlist             → waitlist signup              (move from /space/waitlist)
```

The `/p/avatar/:emailOrId` endpoint:
1. Resolve email/ID → user
2. If user has avatar → serve image with `Cache-Control: public, max-age=86400`
3. If no avatar → 302 redirect to a generated fallback (or return a generated SVG)
4. Non-eigen emails → 404

This replaces the current two-step flow (`GET /space/:id/public` → extract avatar path → `GET /space/:id/avatar/:file`).

### Phase 2: Migrate existing public endpoints

- Move `getPublicInfo` and `getAvatar` calls from `spaceRouter` to new `publicRouter`
- Keep old `/space/` routes as redirects temporarily (or remove if no external consumers)
- Move `/space/waitlist` to `/p/waitlist`
- `/space/nu` stays in `spaceRouter` (it's authenticated, belongs to Space app)

### Phase 3: Simplify client avatar resolution

**Simplify `UserAvatar`:**
- When no `imageUrl` provided, render `<img src="${API_HOST}/p/avatar/${email || userId}">`
- Remove dependency on `useAvatar` hook for basic avatar display
- `useAvatar` hook remains useful for resolving name + email (tooltip, UserItem display)

**Simplify `UserPublicAvatar`:**
- Just `<img src="${API_HOST}/p/avatar/${email}">` wrapped in a tooltip
- Tooltip still uses `usePublicUser` for the name

**Simplify `UserItem` with `autoFetch`:**
- Avatar: use `/p/avatar/:email` URL directly
- Name/email resolution: keep `useAvatar` (or `usePublicUser`) for text display only

### Phase 4: Slim down `useAvatar`

After the public avatar endpoint exists, `useAvatar` only needs to resolve **name** and **email** — no longer avatar URLs. This removes the `useContacts()` dependency for avatar resolution:

```ts
// Before: useAvatar resolves name + email + avatar (needs contacts + public user)
// After:  useAvatar resolves name + email only (needs public user only for eigen users,
//         contacts only when we need display name for non-eigen contacts)
```

Consider renaming to `useUserInfo` since it's no longer avatar-specific.

---

## File Changes Summary

### New files
| File | Purpose |
|------|---------|
| `apps/api/src/routes/public.ts` | `/p/` public router |

### Modified files
| File | Changes |
|------|---------|
| `apps/api/src/routes/space.ts` | Remove public endpoints (moved to `/p/`) |
| `apps/api/src/lib/space/public.ts` | Add direct avatar-by-email function |
| `apps/api/src/index.ts` (or route registration) | Register new `publicRouter` |
| `packages/ui/.../user-avatar.tsx` | Use `/p/avatar/` URL directly |
| `packages/ui/.../user-public-avatar.tsx` | Simplify to direct URL |
| `packages/ui/.../user-item.tsx` | Simplify avatar when `autoFetch` |
| `packages/lib/.../media/hooks/avatar.ts` | Remove avatar URL resolution, keep name/email only |
| `packages/lib/.../public/hooks/use-public.ts` | Update endpoint from `/space/` to `/p/` |
| `packages/lib/src/lib/api.ts` | Add `publicApi` treaty client |
