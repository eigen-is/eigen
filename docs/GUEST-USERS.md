# Implement External Guest User Access

This plan outlines the steps to enable external users (guests) to authenticate via Email OTP and access shared resources via direct links, while strictly enforcing that OTP-created users are "Guests" (stateless) and Password-created users are "Users" (stateful).

**Why**: Eigen's ACL system allows sharing resources with email addresses. We want to support guest users (users outside the Eigen instance, with email addresses from another domain). Currently, these external users cannot authenticate to access their shared resources. This plan enables them to sign in via Email OTP to access specifically shared content while preventing full account creation.

## 1. Authentication & Role Enforcement
- **Goal**: Allow public sign-up via OTP (for guests) but force `role: 'guest'`. Allow public sign-up via Password (for normal users) *only if* allowed by config.
- **Action**:
    - Create custom endpoints in `apps/api/src/routes/guest-auth.ts` (not hooks - better-auth hooks don't preserve request metadata):
        - `POST /guest-auth/request-otp` - Validate ACL access, generate/send OTP
        - `POST /guest-auth/verify` - Verify OTP, create guest user
    - Modify `apps/api/src/lib/auth/auth.ts`:
        - Import/Register `emailOTP` plugin (for the sendVerificationOTP flow).
        - Add `before` hook using `createAuthMiddleware` for `/sign-up/email`:
            - Check `system_config.allowRegistration`
            - If disabled, throw `APIError`
            - If enabled, ensure `role: 'user'`
    - **Guest OTP Logic** (custom endpoint, not plugin):
        1. Extract `ownerId`, `mountId`, `pathId` from request body
        2. Validate email has ACL access to this specific resource before allowing OTP
        3. Create user with `role: 'guest'` via `auth.api` directly
    - **If Password**: Use better-auth built-in with `before` hook to enforce registration settings
- **Security**: This ensures no one can create a full account via the OTP route and prevents spam creation of guest accounts by validating specific ACL access.

## 2. Guest Home Implementation (Stateless)
- **Goal**: `GuestHome` must not persist data to disk.
- **Action**:
    - Create `apps/api/src/lib/storage/memory-storage.ts` (minimal implementation of `StorageBackend`).
    - Create `apps/api/src/lib/home/guest-home.ts`:
        - Extends `Home` (reuse base initialization, override storage).
        - `fs`: `MemoryStorage` (in-memory only).
        - `drive`: `GuestDrive` (placeholder, delegates to SharedDrive).
        - `mail`, `contacts`: Return empty/mock implementations or throw "Not Implemented".
        - `init()`: Ready immediately, no folder creation.
        - `destruct()`: No-op (nothing to clean up).

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
    - Frontend (`_auth` guard) redirects to `/login?redirect=...&email=bob@gmail.com&ownerId=alice&mountId=default&pathId=file-uuid`.
    - **Frontend Implementation**:
        - Modify `packages/ui/src/components/layout/login-route.tsx`: Update `loginSearchSchema` to accept `email`, `ownerId`, `mountId`, `pathId` (all optional).
        - Modify `packages/ui/src/components/layout/loginpage.tsx`:
            - Add `mode` state: `'password'` vs `'guest-otp'`.
            - If `email` param exists, default to `'guest-otp'` mode and pre-fill email.
            - **Guest OTP UI**: 
                - Step 1: Show email (read-only if from URL) -> Button "Send Login Code" 
                    - Calls `POST /guest-auth/request-otp` with `{email, ownerId, mountId, pathId}`
                    - Backend validates ACL before sending OTP
                - Step 2: Input Code -> Button "Verify & Sign In".
                    - Calls `POST /guest-auth/verify` with `{email, otp}`
                    - Backend creates user with `role: 'guest'` and returns session
            - Regular users use standard `authClient.signIn.email()` for password login
    - **Back to Flow**:
        - Guest enters OTP -> Verified via custom endpoint -> Logged in (as Guest).
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

## Rationale: Why Custom Endpoints?

Better-auth's plugin architecture has limitations that make the naive approach (hooks) impossible:

1. **Database hooks don't receive request context** — The `databaseHooks.user.create.before` hook only sees the sanitized user data, not the original HTTP request with `ownerId`, `mountId`, `pathId` metadata.

2. **Before hooks (`createAuthMiddleware`) can read context but can't pass data to user creation** — While `ctx.path` and `ctx.body` are available, there's no built-in mechanism to attach metadata that survives to the user creation step.

3. **emailOTP plugin auto-creates users** — The plugin's `signIn.emailOtp()` auto-registers unknown users. The `disableSignUp` option blocks ALL sign-ups, not just password-based ones.

4. **ACL validation must happen BEFORE OTP is sent** — To prevent spam, we need to verify the email has access to the resource before generating/sending an OTP. This requires a custom flow.

**Solution**: Custom `/guest-auth/*` endpoints that:
- Handle OTP generation/verification outside better-auth's plugin flow
- Create users via `auth.api` directly with `role: 'guest'`
- Validate ACL before any state change
- Still use better-auth for session management (cookies, tokens)
