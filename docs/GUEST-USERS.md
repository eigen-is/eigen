# Implement External Guest User Access

This plan outlines the steps to enable external users (guests) to authenticate via Email OTP and access shared resources via direct links, while strictly enforcing that OTP-created users are "Guests" (stateless) and Password-created users are "Users" (stateful).

**Why**: Eigen's ACL system allows sharing resources with email addresses. We want to support guest users (users outside the Eigen instance, with email addresses from another domain). Currently, these external users cannot authenticate to access their shared resources. This plan enables them to sign in via Email OTP to access specifically shared content while preventing full account creation.

## 1. Authentication & Role Enforcement
- **Goal**: Allow public sign-up via OTP (for guests) but force `role: 'guest'`. Allow public sign-up via Password (for normal users) *only if* allowed by config.
- **Action**:
    - Modify `apps/api/src/lib/auth/auth.ts`:
        - Import/Register `emailOTP` plugin.
        - Add a `database` hook (or core hook) for `user.create`.
        - **Logic in Hook**:
            1. Check `system_config.allowRegistration`.
            2. Identify creation source (Password vs OTP) via request path or body keys (OTP body has `otp`, Password body has `password`).
            3. **If OTP**: 
                - Extract `ownerId`, `mountId`, `pathId` from request metadata (sent from frontend when user clicks shared link)
                - Validate email has ACL access to this specific resource before allowing OTP
                - Force `role: 'guest'`. (Always allowed, even if registration is closed, as this is ad-hoc sharing).
            4. **If Password**: 
                - If `allowRegistration` is `false`, throw error (block creation).
                - If `allowRegistration` is `true`, set `role: 'user'` (default).
- **Security**: This ensures no one can create a full account via the OTP route and prevents spam creation of guest accounts by validating specific ACL access.

## 2. Guest Home Implementation (Stateless)
- **Goal**: `GuestHome` must not persist data.
- **Action**:
    - Create `apps/api/src/lib/storage/memory-storage.ts` (minimal implementation of `StorageBackend`).
    - Create `apps/api/src/lib/home/guest-home.ts`:
        - Extends/Implements `Home`.
        - `fs`: `MemoryStorage`.
        - `drive`: `GuestDrive`.
        - `mail`, `contacts`: `null` or throw "Not Implemented".
        - `init()`: Ready immediately.
        - `destruct()`: No-op.

## 3. Guest Drive Implementation
- **Goal**: Guests have no personal storage, only access to what's shared.
- **Action**:
    - Create `apps/api/src/lib/drive/guest-drive.ts`.
    - `mounts`: Empty.
    - `getSharedPathsWithMe()`: Returns `[]` (no `shared.db`).
    - **Note**: Guests view shared files via the `SharedDrive` wrapper (which delegates to the *Owner's* Home), not via their own `GuestDrive`. The `GuestDrive` is just a placeholder to satisfy the `Home` interface.

## 4. API & Auth Flow
- **Access Pattern**:
    - Guest clicks link: `https://eigen.is/drive/s/alice/default/file-uuid?email=bob@gmail.com`
    - Frontend (`_auth` guard) redirects to `/login?redirect=...&email=bob@gmail.com`.
    - **Frontend Implementation**:
        - Modify `packages/ui/src/components/layout/login-route.tsx`: Update `loginSearchSchema` to accept `email` (optional).
        - Modify `packages/ui/src/components/layout/loginpage.tsx`:
            - Add `mode` state: `'password'` vs `'otp'`.
            - If `email` param exists, default to `'otp'` mode and pre-fill email.
            - **OTP UI**: 
                - Step 1: Input Email -> Button "Send Login Code" (includes `ownerId`, `mountId`, `pathId` from URL in request)
                - Step 2: Input Code -> Button "Verify & Sign In".
            - Use better-auth client: `authClient.signIn.emailOtp(...)`. Check if ACL has email based on metadata first.
    - **Back to Flow**:
        - User enters OTP -> Logged in (as Guest).
        - Redirects back to `redirect` URL.
        - FE requests file: `GET /drive/alice/default/file/file-uuid`.
        - BE `driveRouter`: `getSharedDrive('alice', guestUser)` -> returns `SharedDrive(AliceHome, GuestUser)`.
        - `SharedDrive` checks Alice's ACL. Success.

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
