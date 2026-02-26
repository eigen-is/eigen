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
    - Guest clicks link: `https://eigen.is/drive/s/user_alice/default/file-uuid?email=bob@gmail.com`
    - `ownerId` uses prefixed format (`user_<id>`, `org_<id>`, `team_<id>`) — see `docs/TODO-ORGANISATION.md`
    - Frontend (`_auth` guard) redirects to `/login?redirect=...&email=bob@gmail.com&ownerId=user_alice&mountId=default&pathId=file-uuid`.
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
        - BE `driveRouter`: `getSharedDrive('user_alice', guestUser)` -> returns `SharedDrive(AliceHome, GuestUser)`.
        - `SharedDrive` checks Alice's ACL. Success.
        - Same flow works for org drives: `getSharedDrive('org_xyz', guestUser)` -> checks org drive ACL.
        - See `docs/TODO-ORGANISATION.md` for full org/team/guest interaction details.

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


### Analysis of the Architecture

1.  **Security via Decoupling**: The strategy brilliantly bypasses the `emailOTP` plugin's limitations. By setting `disableSignUp: true` on the plugin, you prevent arbitrary users from spamming the OTP endpoint to create accounts. The custom `/guest-auth/create-guest` endpoint acts as the sole gatekeeper for guest registration, allowing you to enforce the ACL check effectively. Once the user record exists, the standard `emailOTP` login flow works seamlessly.
2.  **Stateless Sandboxing**: Extending `Home` to create `GuestHome` and overriding `init()` is the correct approach. Because Drizzle/LocalStorage only create files upon actual data manipulation or their respective `init()` calls, skipping `contacts.init()` and `mail.init()` ensures zero bytes are written to disk for guests.
3.  **Role Enforcement**: Manually inserting the user using Drizzle ORM guarantees `role: 'guest'` is immutably set without fighting better-auth's lifecycle hooks.

Here is the backend implementation required to make this work.

### 1. Update Auth Configuration
First, register the `emailOTP` plugin but strictly disable its ability to sign up new users.

```typescript
// apps/api/src/lib/auth/auth.ts
import {admin, organization, twoFactor, emailOTP} from "better-auth/plugins"

// ... existing code ...
export const auth = betterAuth({
    database: drizzleAdapter(drizzle(getServerDataPath('users3.db')), { /* ... */ }),
    emailAndPassword: { enabled: true },
    plugins:[
        twoFactor({ /* ... */ }),
        admin(),
        organization(),
        emailOTP({
            disableSignUp: true, // Crucial: forces users through the custom endpoint
            async sendVerificationOTP({email, otp, type}, request) {
                console.log('Sending Guest OTP:', email, otp, type);
                // TODO: Integrate actual email sending (e.g., mailApi or direct SMTP)
            },
        }),
    ],
    // ...
});
```

### 2. Custom Guest Auth Router
This custom endpoint acts as the gatekeeper. It checks the ACL and creates the user in the database before generating the OTP. *Note: Don't forget to register this router in `app.ts`.*

```typescript
// apps/api/src/routes/guest-auth.ts
import { Elysia, t } from 'elysia';
import { getHome } from '../lib/home/get-home';
import { getUserById, getUserByEmail } from '../lib/users/users';
import { ApiError } from '../lib/core/errors';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { getServerDataPath } from '../lib/config/paths';
import { user as userScheme } from '../../../auth-schema.ts';
import { generateId } from 'better-auth';
import type { User } from 'better-auth/types';

const db = drizzle(getServerDataPath('users3.db'));

export const guestAuthRouter = new Elysia({ prefix: '/guest-auth' })
    .post('/create-guest', async ({ body }) => {
        const { email, ownerId, mountId, pathId } = body;
        
        // ownerId uses prefixed format (user_<id>, org_<id>, team_<id>)
        // See docs/TODO-ORGANISATION.md for parseOwnerId
        const parsed = parseOwnerId(ownerId);
        let drive;
        if (parsed.type === 'org') {
            const orgHome = await getOrgHome(parsed.id);
            drive = orgHome.drive;
        } else if (parsed.type === 'team') {
            const teamHome = await getTeamHome(parsed.id);
            drive = teamHome.drive;
        } else {
            const owner = await getUserById(parsed.id);
            if (!owner) throw new ApiError(404, 'Owner not found');
            const home = await getHome(owner);
            drive = home.drive;
        }
        
        // Validate ACL using a dummy guest user object
        const hasAccess = await drive.canRead(mountId, pathId, { id: 'guest-check', email } as User);
        
        if (!hasAccess) {
            throw new ApiError(403, 'No access to this shared resource');
        }
        
        let user = await getUserByEmail(email);
        if (!user) {
            // Create the guest user
            await db.insert(userScheme).values({
                id: generateId(),
                email: email.toLowerCase(),
                name: email.split('@')[0],
                role: 'guest',
                createdAt: new Date(),
                updatedAt: new Date(),
                emailVerified: false
            }).run();
        }
        
        return { success: true };
    }, {
        body: t.Object({
            email: t.String(),
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String()
        })
    });
```

### 3. Guest Drive (Sandbox)
This dummy drive exists solely to satisfy the `Home.drive` interface without initializing a default mount or shared databases. The real interactions happen through `SharedDrive`.

```typescript
// apps/api/src/lib/drive/guest-drive.ts
import type { User } from 'better-auth/types';
import Drive from './drive';
import type { Home } from '../home/home';
import type { DrivePath } from '@workspace/lib/types/drive';

export class GuestDrive extends Drive {
    constructor(home: Home) {
        super(home);
    }

    async init(): Promise<void> {
        // No default mounts, no shared db
    }

    async addMount(): Promise<void> {}
    async removeMount(): Promise<void> {}
    async listMounts(): Promise<any[]> { return[]; }
    async size(): Promise<number> { return 0; }
    async getRootFolder(): Promise<DrivePath | null> { return null; }
    async getPath(): Promise<DrivePath | null> { return null; }
    async getFolderContents(): Promise<DrivePath[]> { return []; }
    async getSharedPathsWithMe(): Promise<DrivePath[]> { return []; }
    async getSharedPathsByMe(): Promise<DrivePath[]> { return[]; }
    async receiveACLChange(): Promise<void> {}
}
```

### 4. Guest Home
A sandboxed `Home` instance that overrides the `init()` method so that directories aren't created in the filesystem.

```typescript
// apps/api/src/lib/home/guest-home.ts
import type { User } from 'better-auth/types';
import { Home } from './home';
import { GuestDrive } from '../drive/guest-drive';

export class GuestHome extends Home {
    private guestInitialized = false;

    constructor(user: User) {
        super(user);
        // Overwrite standard domain objects with safe placeholders just in case
        this.fs = {} as any; 
        this.contacts = {} as any;
        this.mail = {} as any;
    }

    public async init() {
        if (this.guestInitialized) return this;
        
        this.drive = new GuestDrive(this) as any;
        await this.drive.init();
        
        // Skip calling contacts.init() and mail.init()
        this.guestInitialized = true;
        return this;
    }

    public async size() {
        return { mail: 0, contacts: 0, drive: 0, used: 0, max: 0 };
    }
}
```

### 5. Update Home Factory
Finally, update the factory to serve the `GuestHome` when applicable.

```typescript
// apps/api/src/lib/home/get-home.ts
import type {User} from 'better-auth/types';
import {createAsyncSingleton} from '../../utils/singleton';
import {getUserById} from '../users/users';
import {Home} from './home';
import {GuestHome} from './guest-home'; // <-- Add import

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export function getHome(user: User): Promise<Home> {
    if (!homeFactories.has(user.id)) {
        homeFactories.set(user.id, createAsyncSingleton(async () => {
            const userExists = await getUserById(user.id);
            if (!userExists) {
                throw new Error('User not found');
            }

            // <-- Use GuestHome if the role matches
            const home = user.role === 'guest' ? new GuestHome(user) : new Home(user);
            await home.init();
            return home.touch();
        }));
    }

    return homeFactories.get(user.id)!();
}

export function cleanupHomeFactory(userId: string): void {
    homeFactories.delete(userId);
}
```

### Frontend Adjustments
On the frontend (`packages/ui/src/components/layout/loginpage.tsx`), the flow should be:
1. When submitting the email, fire `treaty.guestAuth['create-guest'].post({ email, ownerId, mountId, pathId })`.
2. Once the 200 OK resolves, fire `authClient.signIn.emailOtp({ email })` which will send the email.
3. Prompt for the OTP, and run `authClient.signIn.emailOtp({ email, otp })` to complete the sign-in.