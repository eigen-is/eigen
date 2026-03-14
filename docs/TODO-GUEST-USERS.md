# Implement External Guest User Access

> **TLDR**: Implementation plan for external guest access via Email OTP. Guests get stateless GuestHome (no disk
> persistence). Access shared resources via direct links. Not yet implemented.

Enable external users (guests) to authenticate via Email OTP and access shared resources via direct links.

## 1. Authentication & Role Enforcement

- **Goal**: Allow public sign-up via OTP (for guests) but force `role: 'guest'`. Allow public sign-up via Password (for
  normal users) *only if* allowed by config.
- **Action**:
    - Create custom endpoints in `apps/api/src/routes/guest-auth.ts`:
        - `POST /guest-auth/request-otp` - Validate ACL access, generate/send OTP
        - `POST /guest-auth/verify` - Verify OTP, create guest user
    - Modify `apps/api/src/lib/auth/auth.ts`:
        - Register `emailOTP` plugin (with `disableSignUp: true`).
        - Add `before` hook using `createAuthMiddleware` for `/sign-up/email`:
            - Check `system_config.allowRegistration`
            - If disabled, throw `APIError`
            - If enabled, ensure `role: 'user'`

## 2. Guest Home Implementation (Stateless)

- **Goal**: `GuestHome` must not persist data to disk.
- **Action**:
    - Create `apps/api/src/lib/storage/memory-storage.ts` (minimal `StorageBackend`).
    - Create `apps/api/src/lib/home/guest-home.ts`:
        - Extends `Home`.
        - `fs`: `MemoryStorage`.
        - `drive`: `GuestDrive` (placeholder, delegates to SharedDrive).
        - `mail`, `contacts`: Empty/mock implementations.
        - `init()`: Ready immediately, no folder creation.
        - `destruct()`: No-op.

## 3. Guest Drive Implementation

- **Goal**: Guests have no personal storage, only access to what's shared.
- **Action**:
    - Create `apps/api/src/lib/drive/guest-drive.ts`.
    - `mounts`: Empty.
    - `getSharedPathsWithMe()`: Returns `[]`.

## 4. API & Auth Flow

- **Access Pattern**:
    - Guest clicks link: `https://eigen.is/drive/s/user_alice/default/file-uuid?email=bob@gmail.com`
    - Frontend (`_auth` guard) redirects to
      `/login?redirect=...&email=bob@gmail.com&ownerId=user_alice&mountId=default&pathId=file-uuid`.
- **Frontend Implementation**:
    - Update `loginSearchSchema` to accept `email`, `ownerId`, `mountId`, `pathId`.
    - Add `mode` state to `loginpage.tsx`: `'password'` vs `'guest-otp'`.
    - If `email` param exists, default to `'guest-otp'`.
    - **Guest OTP UI**:
        - Show email -> "Send Login Code" calls `POST /guest-auth/request-otp`
        - Input Code -> "Verify & Sign In" calls `POST /guest-auth/verify`

## 5. Factory Update

- **Action**:
    - Update `apps/api/src/lib/home/get-home.ts`.
    - If `user.role === 'guest'`, return `GuestHome`.
    - Else, return standard `Home`.

## 6. Verification Plan

- **Test**: `apps/api/src/test/guest.test.ts`
    1. **Role Security**:
        - Attempt OTP sign-up -> Verify user created with `role: 'guest'`.
        - Attempt Password sign-up (with reg disabled) -> Verify rejected.
    2. **Statelessness**:
        - Login as Guest.
        - Verify `getHome()` is `GuestHome`.
        - Verify no folder created in `data/home/`.
    3. **Access**:
        - Alice shares file with Guest email.
        - Guest accesses file via `getSharedDrive`.
        - Verify success.

### Implementation Details

#### 1. Update Auth Configuration

Register the `emailOTP` plugin with `disableSignUp: true`.

```typescript
// apps/api/src/core/auth/auth.ts
emailOTP({
    disableSignUp: true, // Crucial: forces users through the custom endpoint
    async sendVerificationOTP({email, otp, type}, request) {
        // Integrate email sending
    },
}),
```

#### 2. Custom Guest Auth Router

Gatekeeper endpoint checking ACL before generating OTP.

```typescript
// apps/api/src/routes/guest-auth.ts
export const guestAuthRouter = new Elysia({ prefix: '/guest-auth' })
    .post('/create-guest', async ({ body }) => {
        // ... parse ownerId, get drive, check ACL ...
        const hasAccess = await drive.canRead(mountId, pathId, { id: 'guest-check', email } as User);
        if (!hasAccess) throw new ApiError(403, 'No access');

        let user = await getUserByEmail(email);
        if (!user) {
            // Create the guest user directly via DB
        }
        return { success: true };
    });
```

#### 3. Guest Drive (Sandbox)

Dummy drive satisfying the `Home.drive` interface.

```typescript
// apps/api/src/core/drive/guest-drive.ts
export class GuestDrive extends Drive {
    async init(): Promise<void> {}
    async size(): Promise<number> { return 0; }
    // ... empty implementations ...
}
```

#### 4. Guest Home

Sandboxed `Home` instance overriding `init()`.

```typescript
// apps/api/src/core/home/guest-home.ts
export class GuestHome extends Home {
    public async init() {
        if (this.guestInitialized) return this;
        this.drive = new GuestDrive(this) as any;
        await this.drive.init();
        this.guestInitialized = true;
        return this;
    }
}
```

#### 5. Update Home Factory

Return `GuestHome` when applicable.

```typescript
// apps/api/src/core/home/get-home.ts
const home = user.role === 'guest' ? new GuestHome(user) : new Home(user);
```

#### 6. Frontend Adjustments

1. Fire `treaty.guestAuth['create-guest'].post({ email, ownerId, mountId, pathId })`.
2. Fire `authClient.signIn.emailOtp({ email })`.
3. Prompt for OTP, run `authClient.signIn.emailOtp({ email, otp })`.
