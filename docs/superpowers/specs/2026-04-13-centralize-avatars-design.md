# Centralize User Avatars to Server-Level Storage

## Problem

User avatars are stored per-Home (`{userHome}/eigen.contacts/avatars/{uuid}.webp`), but served
publicly via `GET /p/avatar/:emailOrId`. The public endpoint calls `pullAvatarFile()` which calls
`getHome(userId)` — spinning up another user's Home just to read a static image. This is wasteful
and breaks the sharding model: in a multi-server deployment, one server would need to reach into
another server's Home just to serve an avatar.

Additionally, `updateUser()` is called directly from `Contacts.updateContact()` to sync name + image
to the auth DB — another silent crossing of the Home → server boundary with no relay involvement.

## Goal

Move user avatars (your own, not contact avatars for other people) to server-level storage at
`data/server/avatars/`. Make all Home → server profile updates go through `home-relay.ts` so the
sharding seam is explicit and complete.

## Storage Layout

- **Server-level**: `data/server/avatars/{userId}.webp` — one file per user, overwritten on upload,
  deleted on removal. Directory created lazily on first write.
- **Home-level**: `{userHome}/eigen.contacts/avatars/{uuid}.webp` — unchanged. A duplicate of
  your own avatar continues to live here for the contacts app's own download route. Contact avatars
  for other people remain here exclusively.

## Write Path

### Avatar Upload (unchanged)

`POST /contacts/:ownerId/avatar` continues to write to home-local storage and return a path. At
upload time we don't know if the avatar is for "yourself" or another contact, so nothing changes here.

### Contact Save (changed)

In `Contacts.updateContact()`, when `this.you(id)` is true (editing your own contact):

**Before:** calls `updateUser(user, name, avatarPath)` directly — crosses the Home → server boundary
silently.

**After:** reads the avatar file from home-local storage (if avatar path is set), then calls
`pushUserProfile(userId, name, avatarBuffer | null)` from `home-relay.ts`. This single relay
function handles:

1. Writing/deleting `data/server/avatars/{userId}.webp`
2. Updating the auth DB user record (name + image) via `updateUser()`

When avatar is empty (removal): `pushUserProfile(userId, name, null)` deletes the server-level
file and clears auth `user.image`.

## Read Path

### Public Avatar Serving (changed)

`GET /p/avatar/:emailOrId` in `public.ts`:

**Before:** `getAvatarByEmailOrId()` → resolve user → read `user.image` → `pullAvatarFile(userId, filename)` → `getHome(userId)` → read file from home.

**After:** `getAvatarByEmailOrId()` → resolve userId → check if `data/server/avatars/{userId}.webp`
exists → serve file or generate fallback SVG. No Home involvement.

### Authenticated Contact Avatar Download (unchanged)

`GET /contacts/:ownerId/avatar/:filename` continues to read from home-local storage via
`Contacts.downloadAvatar()`. This serves avatars for any contact (including yourself) within
the contacts app.

## Relay Changes

### Added: `pushUserProfile()`

```typescript
// Home -> server: update public profile (name + avatar)
export async function pushUserProfile(
    userId: string,
    name: string,
    avatarWebP: Buffer | null,
): Promise<void> {
    // 1. Write or delete data/server/avatars/{userId}.webp
    // 2. Update auth DB: updateUser(user, name, image)
}
```

Today this is a direct in-process call. In a sharded deployment, this becomes an RPC to the
central server — only this function changes.

### Removed: `pullAvatarFile()`

No longer needed. The public endpoint reads from server storage directly.

## File Changes

| File | Change |
|---|---|
| `apps/api/src/lib/home/home-relay.ts` | Add `pushUserProfile()`, remove `pullAvatarFile()` |
| `apps/api/src/lib/contacts/contacts.ts` | Replace direct `updateUser()` call with `pushUserProfile()` in `updateContact()` when `this.you(id)` |
| `apps/api/src/lib/space/public.ts` | `getAvatarByEmailOrId()` reads from `data/server/avatars/` directly |
| `apps/api/src/routes/public.ts` | No change (endpoint stays the same) |
| `apps/api/src/lib/user/user.ts` | `updateUser()` stays (called internally by `pushUserProfile`) |
| Frontend | No changes — upload URL, contact mutations, and `/p/avatar/:id` all stay the same |

## What Stays the Same

- Contact avatars for other people: stored in home, served via authenticated contacts route
- Avatar upload endpoint: `POST /contacts/:ownerId/avatar`
- Public avatar URL: `GET /p/avatar/:emailOrId`
- Fallback SVG generation
- `cleanupAvatarImages()` in contacts (cleans up home-local orphans)
- Quota enforcement (`enforceAvatarUpload`)
- Frontend components (`UserAvatar`, `ProfileEditor`, `useResolvedUser`)
