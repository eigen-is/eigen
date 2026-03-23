# Passkey Authentication

## Problem

Eigen hosts its own email. Users who forget their password cannot access their inbox to receive a reset link. We need
a self-service recovery mechanism that works independently of email access.

## Solution

Add passkey (WebAuthn/FIDO2) as an alternative sign-in method. Users register a passkey (fingerprint, Face ID,
security key) while logged in. If they forget their password, they sign in via passkey — no email required.

Passkeys are the industry-standard approach: phishing-resistant, multi-factor by nature (possession + biometric), and
require zero external infrastructure (no SMTP, no SMS gateway).

## Recovery Model

| Layer | Method               | Who             | Status        |
|-------|----------------------|-----------------|---------------|
| 1     | Passkey sign-in      | User            | This proposal |
| 2     | Admin password reset | Org admin       | Already built |
| 3     | Server CLI reset     | Server operator | Future        |

## Technical Design

### Plugin: `@better-auth/passkey`

Separate package from better-auth core. Uses `@simplewebauthn/server` + `@simplewebauthn/browser` under the hood.
WebAuthn challenges are stored in a signed cookie (`better-auth-passkey`, 5-min TTL) — no extra DB table for
challenges.

### Configuration

**Server** (`apps/api/src/lib/auth/auth.ts`):

```typescript
import {passkey} from "@better-auth/passkey"

passkey({
    rpID: getDomain(),    // 'localhost' during dev, stored domain after setup
    rpName: 'Eigen',
})
```

`getDomain()` from `server-config.ts` returns `'localhost'` as fallback, which is a valid rpID for development.
After setup, it returns the configured domain from `data/server/config.json`. This follows the same pattern as
`secret: getServerConfig()?.secret || crypto.randomUUID()`.

No explicit `origin` needed — better-auth reads the request's `Origin` header at runtime. On production everything
runs on the same domain, so this works automatically. During development, the browser sends the correct
`http://localhost:PORT` origin per request.

**Client** (`packages/lib/src/core/auth/hooks/use-auth-client.ts`):

```typescript
import {passkeyClient} from "@better-auth/passkey/client"

createAuthClient({
    plugins: [
        passkeyClient(),
        // ...existing plugins
    ],
})
```

### Database Schema

New `passkey` table in `apps/api/auth-schema.ts`, following the existing auth table pattern:

| Column       | Type    | Required | Notes                              |
|--------------|---------|----------|------------------------------------|
| id           | text    | PK       | Auto-generated                     |
| name         | text    | no       | User-assigned label                |
| publicKey    | text    | yes      | Base64-encoded credential key      |
| userId       | text    | yes      | FK to `user.id`, indexed           |
| credentialID | text    | yes      | WebAuthn credential ID, indexed    |
| counter      | integer | yes      | Signature counter (replay protect) |
| deviceType   | text    | yes      | `singleDevice` or `multiDevice`    |
| backedUp     | integer | yes      | Whether synced to cloud (boolean)  |
| transports   | text    | no       | Comma-separated transport list     |
| createdAt    | text    | no       | ISO timestamp                      |
| aaguid       | text    | no       | Authenticator model GUID           |

Register in the drizzle adapter schema map alongside the existing auth tables. Since data is throwaway during dev,
no migration needed — delete `users3.db` and restart.

## Implementation

### 1. Backend wiring

- Install `@better-auth/passkey`
- Add `passkey` table to `apps/api/auth-schema.ts`
- Register schema + plugin in `apps/api/src/lib/auth/auth.ts`
- Add `passkeyClient()` to auth client in `packages/lib/src/core/auth/hooks/use-auth-client.ts`

### 2. Passkey management hooks (`packages/lib/src/core/auth/hooks/`)

New file `use-passkeys.ts` with hooks following the existing mutation pattern:

- `usePasskeys()` — query: list user's passkeys via `authClient.passkey.listUserPasskeys()`
- `useAddPasskey()` — mutation: `authClient.passkey.addPasskey({name})`, success toast
- `useDeletePasskey()` — mutation: `authClient.passkey.deletePasskey({id})`, invalidate query
- `useUpdatePasskey()` — mutation: `authClient.passkey.updatePasskey({id, name})`, invalidate query

### 3. Security settings UI (Space app)

New route `apps/space/src/routes/_auth.security.passkeys.tsx` + component, following the 2FA settings page pattern:

- List registered passkeys: name, created date, device type, backed-up badge
- "Add passkey" button — triggers browser WebAuthn dialog
- Delete button with confirmation dialog
- Rename (inline or dialog)
- Empty state encouraging passkey registration for account recovery

### 4. Login page

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

- Add "Sign in with passkey" button below the password form
- Calls `authClient.signIn.passkey()` — on success, same redirect flow as password login
- On cancel: show inline message, password form stays available
- Conditional mediation (autofill): add `autocomplete="username webauthn"` to email input, call
  `authClient.signIn.passkey({autoFill: true})` on mount if
  `PublicKeyCredential.isConditionalMediationAvailable()` returns true

### 5. Password change after passkey login

The existing `changePassword` API requires `currentPassword`. A user who signed in via passkey doesn't know their
old password — that's the whole point.

**Solution**: Custom endpoint `POST /settings/set-password` in `apps/api/src/routes/settings.ts` that sets a new
password without requiring the old one. Requires an authenticated session. Uses better-auth's internal password
hashing via `auth.$context`.

In the change-password UI (`apps/space/src/components/space/change-password.tsx`), detect if the user has passkeys
registered and offer a simplified "Set new password" form (no current password field) that calls this endpoint.

## Edge Cases

### Passkey bypasses 2FA

By design. Passkey sign-in creates a session directly — no TOTP challenge. This is correct: passkeys are inherently
multi-factor (device possession + biometric/PIN). GitHub, Google, and Apple all treat passkeys this way.

### rpID is permanent

The rpID is cryptographically baked into each credential at registration time. Passkeys created on `localhost` will
not work in production. Users must re-register after deployment. This is expected WebAuthn behavior.

### Device loss

- **Synced passkeys** (iCloud Keychain, Google Password Manager, 1Password): survive device loss via cloud sync.
  The `backedUp` field in the DB indicates this. Most modern passkeys are synced.
- **Device-bound passkeys** (YubiKey, older platform authenticators): lost with the device. Show the `backedUp`
  status in the security settings UI so users understand the risk.
- **All passkeys lost + forgot password**: fall back to admin password reset (layer 2).

### Browser support

WebAuthn is supported by ~97% of browsers (Chrome 67+, Firefox 60+, Safari 13+, Edge 18+). Conditional mediation
(autofill) is supported by ~94% (Chrome 108+, Firefox 119+, Safari 16+).

The passkey sign-in button should be hidden if `window.PublicKeyCredential` is undefined. Conditional mediation
should be gated on `isConditionalMediationAvailable()`.

### User cancels WebAuthn dialog

Client returns `{ error: { code: "AUTH_CANCELLED" } }`. Show a non-intrusive message. Password form remains
available.

### Multiple passkeys

Users should be encouraged to register multiple passkeys (e.g., laptop + phone + security key) for redundancy.
The settings UI should make this obvious.

### Known plugin issues

- Column naming bug (#4368): verify the generated schema uses `credentialID` not `credential_i_d`
- No server-side hooks (onRegister, onAuthenticate) — can't run custom logic after passkey events
- `throw: true` has no effect on `addPasskey` and `signIn.passkey` — always returns `{data, error}`
- Challenge TTL is hardcoded to 5 minutes — not configurable

## Not in scope

- **Passkey-only accounts** (signup without password) — all users still need email+password as primary
- **Step-up authentication** — better-auth doesn't support it for passkeys (#8071)
- **Production rpID configuration** — deployment concern, handled by `getDomain()` automatically
- **Forced passkey enrollment** — passkeys are opt-in
