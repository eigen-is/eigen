# Public API & Avatars

> **TLDR**: Public endpoints at `/p/` for user info and avatars (no auth required). Avatar URL:
`{API_HOST}/p/avatar/{email}?fallback=digidoodle` — HTTP-cacheable, no client resolution needed.

## Endpoints

```
GET /p/user/:emailOrId     → { name, email, avatar }
GET /p/avatar/:emailOrId   → image binary (Cache-Control: 86400s) or fallback SVG
POST /p/waitlist           → waitlist signup
```

## Avatar Resolution

Components use `UserAvatar` (`packages/ui/src/components/layout/user-avatar.tsx`) which resolves via
`packages/lib/src/core/media/hooks/avatar.ts`.

Direct loading: `<img src="{API_HOST}/p/avatar/{email}?fallback=digidoodle" />`

**Route**: `apps/api/src/routes/public.ts`
