# BE Code Review: Space

## Summary

The Space backend is a small domain covering user settings (theme), public user info/avatar resolution, a waitlist
email feature, and a data export (zip) endpoint. The code is split across:

- `apps/api/src/lib/space/public.ts` -- public user info + avatar resolution
- `apps/api/src/lib/space/waitlist.ts` -- waitlist signup email
- `apps/api/src/routes/space.ts` -- user settings (GET/PUT)
- `apps/api/src/routes/home.ts` -- storage size + zip export
- `apps/api/src/routes/public.ts` -- unauthenticated avatar/user info/config endpoints

The surface area is small and the code is generally clean, but there are several security and data integrity issues.

## Critical Issues

### 1. Hardcoded recipient email in waitlist (P0)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/waitlist.ts`, line 26

```typescript
to: 'reinder@infi.nl',
```

The waitlist notification email is sent to a hardcoded personal address. This should come from server configuration
(e.g., `serverConfig.adminEmail` or a `serverSettings` field) so any deployer of Eigen receives the notification.

**Impact**: Self-hosters never receive waitlist signups. This is effectively dead code for anyone other than the
original developer.

### 2. Public user info endpoint leaks existence of users (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/public.ts`, line 22

```typescript
.
get("/p/user/:emailOrId", async ({params}) => await getPublicInfo(params.emailOrId))
```

This is an unauthenticated endpoint. Anyone can probe arbitrary email addresses or user IDs and learn whether they
exist in the system (returns 200 with name/avatar vs 404). This enables user enumeration attacks.

**Fix**: Require authentication, or return a generic 404 that does not distinguish between "user not found" and "no
account".

### 3. Public avatar endpoint enables user enumeration (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/public.ts`, lines 7-20

The avatar endpoint returns a real avatar (with 24h cache) for existing users and a deterministic fallback SVG for
non-existing ones. An attacker can distinguish the two by content type (`image/webp` vs `image/svg+xml`), enabling
enumeration.

**Mitigation**: Always return a deterministic fallback for unknown IDs (which it does), but ensure the content type is
consistent. Alternatively, accept this as a design trade-off since the fallback SVG is also returned for users without
avatars.

### 4. XSS in waitlist HTML email body (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/waitlist.ts`, lines 20, 34-37

The `notes` field is HTML-escaped on line 20, but the `email` variable is interpolated raw into the HTML body on
line 35:

```typescript
<p><strong>Email
:
</strong> ${email}</
p >
```

While `email` is validated as an email address (which limits the character set), the plain text body on line 28 uses
angle brackets around the email (`<${email}>`), which is safe for plain text but demonstrates inconsistent escaping
discipline.

**Fix**: HTML-escape `email` in the HTML body as well, for defense in depth.

## Pattern Violations

### 5. Home routes missing `:ownerId` consistency note (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/home.ts`

The home routes correctly use `:ownerId` and `requireSelf`, following the documented pattern. This is good. However,
the zip endpoint on line 27 interpolates `data.fileName` into the `Content-Disposition` header:

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${data.fileName}"`;
```

Per CLAUDE.md: "Never interpolate raw user input into headers." While `data.fileName` comes from the server-side
`home.getZip()` method (not direct user input), this should be validated or sanitized as a defensive measure, since
the filename could theoretically contain characters that break the header (quotes, newlines).

### 6. Error swallowed in zip export (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/home.ts`, lines 28-32

```typescript
} catch
(e)
{
    set.status = 500;
    return null;
}
```

The error is caught and a 500 is returned, but no error message reaches the client. The error is not logged either.
This makes debugging production issues difficult.

**Fix**: Log the error, and return a structured error message.

## Security Concerns

### 7. Waitlist endpoint has no rate limiting (P1)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/public.ts`, line 23

The `/p/waitlist` POST endpoint is unauthenticated and has no rate limiting. An attacker could flood the admin's
inbox with signup notifications, or use it as an email relay for spam.

**Fix**: Add rate limiting (per IP or global) to the waitlist endpoint.

### 8. `getUserByEmailOrId` allows arbitrary user lookup (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/public.ts`, lines 10-12

This helper is used by the unauthenticated public routes. It accepts either an email or an ID and returns the full
`User` object from better-auth. While the public route only exposes `name`, `email`, and `avatar`, the internal
helper returns the full user record including `emailVerified`, `createdAt`, etc. If a future developer calls
`getUserByEmailOrId` elsewhere without filtering, sensitive data may leak.

**Fix**: Return only the fields needed (`name`, `email`, `image`), or document the intended use clearly.

## Data Integrity

### 9. Settings PUT body schema is incomplete (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/space.ts`, line 21

The body schema only validates `theme`. If the `UserSettings` type gains new fields (it already has `mounts`), the
route silently ignores them because Elysia strips unknown properties by default. The `mounts` field on `UserSettings`
is not settable through this route, which may be intentional, but the schema and the type are misaligned.

**Fix**: Either expand the schema to match `UserSettings`, or add a comment explaining that `mounts` is managed
elsewhere.

## Code Quality

### 10. Inconsistent error handling pattern in `generateFallbackSvg` (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/public.ts`, lines 49-83

`generateFallbackSvg` calls `getUserByEmailOrId` which may return `null`, and it handles that gracefully by falling
back to the input string. However, it also calls `parseOwnerId` but only uses the result to decide the SVG shape
(team vs user). If `parseOwnerId` gets an invalid string, the behavior depends on the implementation. This is minor
but worth noting.

### 11. `getAvatarByEmailOrId` does not handle team avatars (P2)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/public.ts`, lines 34-47

This function only looks up user avatars. When called with a team owner ID (e.g., `team_xyz`), it calls
`getUserByEmailOrId` which will return `null`, and the function returns `null`. This is handled by the route
(which falls through to `generateFallbackSvg`), but the function name is misleading since it implies it handles
any email-or-id.

## Architecture

- The split between `space.ts` (settings), `home.ts` (storage/export), and `public.ts` (avatar/user info) is
  logical and follows the project's domain separation pattern.
- SSE support for `SPACE_SETTINGS_UPDATED` is correctly wired through the standard SSE pipeline.
- The `requireSelf` access control on space and home routes is appropriate since these are personal-only.

## Positive Patterns

- Proper use of `requireSelf` for access control on personal routes.
- Clean separation of public (unauthenticated) and private endpoints.
- SSE event handling for settings changes follows the documented pattern.
- Body schema validation on the settings PUT route.
- The fallback SVG generation is a nice touch for missing avatars.

## Recommendations

| Priority | Issue                                | Action                                  |
|----------|--------------------------------------|-----------------------------------------|
| P0       | #1 Hardcoded email                   | Move to server config                   |
| P1       | #2 User enumeration via `/p/user`    | Require auth or return generic response |
| P1       | #4 HTML email XSS                    | HTML-escape all interpolated values     |
| P1       | #7 No rate limiting on waitlist      | Add rate limiting                       |
| P2       | #3 Avatar content-type leak          | Accept or mitigate                      |
| P2       | #5 Content-Disposition header safety | Sanitize filename                       |
| P2       | #6 Swallowed error in zip            | Log + return message                    |
| P2       | #8 Full user object in helper        | Return minimal fields                   |
| P2       | #9 Settings schema mismatch          | Align or document                       |
| P2       | #10 parseOwnerId edge case           | Validate input                          |
| P2       | #11 Team avatar handling             | Rename or extend function               |
