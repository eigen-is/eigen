# Public API & Avatar Resolution

## Avatar Resolution

`packages/lib/src/lib/media/hooks/avatar.ts` resolves names and emails for avatars, while the actual image loading
relies on a public gravatar-like service.

### Components

| Component            | File                                               | How it resolves avatars                            |
|----------------------|----------------------------------------------------|----------------------------------------------------|
| `UserAvatar`         | `packages/ui/.../user-avatar.tsx`                  | `useAvatar(email)` unless `forceUseImageUrl`       |
| `UserPublicAvatar`   | `packages/ui/.../user-public-avatar.tsx`           | `useAvatar(email)` → passes result to `UserAvatar` |
| `UserItem`           | `packages/ui/.../user-item.tsx`                    | `useAvatar(email)` when `autoFetch=true`           |
| `UserPublicItem`     | `packages/ui/.../user-item.tsx`                    | Wrapper around `UserItem` with `autoFetch`         |
| `ContactAutosuggest` | `packages/ui/.../contacts/contact-autosuggest.tsx` | Uses `useContactSuggestions`                       |

## Public Endpoints (`/p/`)

The public endpoints are in a dedicated namespace (`/p/`) separate from the authenticated Space app (`/space/`).

```
GET /p/user/:emailOrId       → { name, email, avatar }
GET /p/avatar/:emailOrId     → image binary with fallback
POST /p/waitlist             → waitlist signup
```

### Direct Avatar Loading

The system uses a direct avatar image endpoint keyed by email, simplifying the client significantly.

```
<img src={API_HOST}/p/avatar/{email}?fallback=digidoodle>
```

The `/p/avatar/:emailOrId` endpoint:

1. Resolves email/ID → user.
2. If user has an avatar → serves image with `Cache-Control: public, max-age=86400`.
3. If no avatar → returns a generated fallback SVG.
4. Non-eigen emails → 404.

This one-URL approach avoids client-side resolution logic, is HTTP-cacheable, and works without authentication.
