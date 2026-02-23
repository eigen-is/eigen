# Testing

How to test the Eigen monorepo. Tests run with `bun test` alongside `bun run typecheck` after every change.

---

## 1. Overview

| Layer | Tool | Location |
|-------|------|----------|
| API integration tests | `bun:test` + Eden Treaty + `app.handle()` | `apps/api/src/test/` |
| Shared lib unit tests | `bun:test` | `packages/lib/src/**/*.test.ts` |
| Shared UI hook tests | `bun:test` (future: + React Testing Library) | `packages/ui/src/**/*.test.ts` |

**Run everything:**

```bash
bun run check        # typecheck + test (add to root package.json)
```

**Run just tests:**

```bash
bun run test         # all tests across the monorepo
bun test ./apps/api  # only API tests
```

---

## 2. Architecture

### 2.1 API Integration Tests (Primary)

Tests call the real Elysia app through Eden Treaty **without starting a server**. Elysia's `treaty(app)` accepts the app instance directly and uses `app.handle()` internally — no HTTP, no port, no network.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Test File   │────▶│ Eden Treaty  │────▶│ app.handle()│
│ (bun:test)   │     │ (type-safe)  │     │ (Elysia)    │
└─────────────┘     └──────────────┘     └─────────────┘
                                               │
                                    ┌──────────┴──────────┐
                                    │  Real business logic │
                                    │  (Drive, Mail, etc.) │
                                    └──────────┬──────────┘
                                               │
                                    ┌──────────┴──────────┐
                                    │  Isolated test data  │
                                    │  (temp directory)    │
                                    └─────────────────────┘
```

### 2.2 Test Data Isolation

Tests use a **temporary data directory** instead of the real `./data` folder. This requires making `DATA_ROOT` in `apps/api/src/lib/config/paths.ts` configurable via the `EIGEN_DATA_ROOT` env var.

**Change in `paths.ts`:**

```ts
// BEFORE
const DATA_ROOT = './../../data';

// AFTER
const DATA_ROOT = process.env.EIGEN_DATA_ROOT || './../../data';
```

Each test run creates a unique temp directory (e.g., `data/test-<timestamp>`) and cleans it up in `afterAll`. This means:
- Tests never touch real user data
- Tests can run in parallel with a dev server
- No leftover state between runs

### 2.3 Two Test Users

Tests create **two users** to enable testing of sharing, ACLs, and cross-user scenarios:

| User | Email | Purpose |
|------|-------|---------|
| Alice | `alice@test.eigen.is` | Primary user — owns files, creates content |
| Bob | `bob@test.eigen.is` | Secondary user — tests sharing, ACL verification |

Both users are created via `better-auth`'s server-side `auth.api.createUser()` and authenticated with `auth.api.signInEmail()` to get session cookies.

---

## 3. Test Setup

### 3.1 File: `apps/api/src/test/setup.ts`

This is the shared test setup module. All test files import from here.

```ts
import {beforeAll, afterAll} from 'bun:test';
import {mkdirSync, rmSync, existsSync} from 'fs';
import {join} from 'path';
import {treaty} from '@elysiajs/eden';

// 1. Set EIGEN_DATA_ROOT BEFORE importing app (paths.ts reads it at import time)
const TEST_DATA_DIR = join(import.meta.dir, '../../../../data/test-' + Date.now());
process.env.EIGEN_DATA_ROOT = TEST_DATA_DIR;

// 2. Now import app (which triggers paths.ts, auth.ts, etc.)
import {app} from '../app';
import {auth} from '../lib/auth/auth';

// Types
type TestUser = {
    id: string;
    email: string;
    name: string;
};

type TestContext = {
    alice: {user: TestUser; api: ReturnType<typeof treaty<typeof app>>};
    bob: {user: TestUser; api: ReturnType<typeof treaty<typeof app>>};
    app: typeof app;
};

let context: TestContext;

// Create a Treaty client with session cookie
function createAuthenticatedClient(sessionToken: string) {
    return treaty(app, {
        headers: {
            cookie: `better-auth.session_token=${sessionToken}`,
        },
    });
}

// Setup: create temp dir, initialize DB schema, create 2 users, sign them in
async function globalSetup(): Promise<TestContext> {
    // Ensure test data directory exists
    mkdirSync(join(TEST_DATA_DIR, 'server'), {recursive: true});
    mkdirSync(join(TEST_DATA_DIR, 'home'), {recursive: true});

    // Write minimal server config so setup is "complete"
    const configPath = join(TEST_DATA_DIR, 'server', 'config.json');
    const config = {
        domain: 'test.eigen.is',
        storage: {type: 'local-id'},
        setupCompleted: true,
        setupCompletedAt: new Date().toISOString(),
    };
    Bun.write(configPath, JSON.stringify(config));

    // Initialize DB schema via setup logic
    // (The auth DB is created by better-auth on first access)

    // Create Alice
    const aliceResult = await auth.api.signUpEmail({
        body: {email: 'alice@test.eigen.is', password: 'testpassword123', name: 'Alice Test'},
    });
    const aliceSession = await auth.api.signInEmail({
        body: {email: 'alice@test.eigen.is', password: 'testpassword123'},
    });

    // Create Bob
    const bobResult = await auth.api.signUpEmail({
        body: {email: 'bob@test.eigen.is', password: 'testpassword123', name: 'Bob Test'},
    });
    const bobSession = await auth.api.signInEmail({
        body: {email: 'bob@test.eigen.is', password: 'testpassword123'},
    });

    return {
        alice: {
            user: {id: aliceResult.user.id, email: aliceResult.user.email, name: aliceResult.user.name},
            api: createAuthenticatedClient(aliceSession.token),
        },
        bob: {
            user: {id: bobResult.user.id, email: bobResult.user.email, name: bobResult.user.name},
            api: createAuthenticatedClient(bobSession.token),
        },
        app,
    };
}

// Teardown: remove temp data directory
function globalTeardown() {
    if (existsSync(TEST_DATA_DIR)) {
        rmSync(TEST_DATA_DIR, {recursive: true, force: true});
    }
}

// Export setup/teardown for use in test files
export async function getTestContext(): Promise<TestContext> {
    if (!context) {
        context = await globalSetup();
    }
    return context;
}

export {globalTeardown, TEST_DATA_DIR};
```

> **Note:** The exact `auth.api` method names and return types depend on the `better-auth` version. The implementer should verify the actual API surface. The key pattern — create user, sign in, extract session token, pass as cookie — is correct.

### 3.2 File: `apps/api/src/test/preload.ts`

Bun supports `--preload` scripts that run before all test files. This initializes the test environment once:

```ts
import {afterAll} from 'bun:test';
import {globalTeardown} from './setup';

afterAll(() => {
    globalTeardown();
});
```

Configure in `apps/api/package.json`:

```json
{
  "scripts": {
    "test": "bun test --preload ./src/test/preload.ts"
  }
}
```

---

## 4. Test Files

### 4.1 Auth Tests — `apps/api/src/test/auth.test.ts`

```ts
import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext} from './setup';

describe('Auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('health check returns OK', async () => {
        const response = await ctx.app.handle(new Request('http://localhost/health'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('OK');
    });

    test('unauthenticated request is rejected', async () => {
        const response = await ctx.app.handle(
            new Request('http://localhost/drive/' + ctx.alice.user.id + '/mounts')
        );
        // Should fail with 400 or throw "Unauthorized"
        expect(response.status).not.toBe(200);
    });

    test('authenticated request succeeds (Alice)', async () => {
        const {data, error} = await ctx.alice.api.drive({ownerId: ctx.alice.user.id}).mounts.get();
        expect(error).toBeNull();
        expect(data).toBeDefined();
    });

    test('authenticated request succeeds (Bob)', async () => {
        const {data, error} = await ctx.bob.api.drive({ownerId: ctx.bob.user.id}).mounts.get();
        expect(error).toBeNull();
        expect(data).toBeDefined();
    });
});
```

### 4.2 Drive Tests — `apps/api/src/test/drive.test.ts`

This is the most comprehensive test file. It tests the full Drive lifecycle including sharing.

```ts
import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext} from './setup';

describe('Drive', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceRootId: string;
    let aliceMountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        // Get Alice's root folder and mount
        const {data: mounts} = await ctx.alice.api
            .drive({ownerId: ctx.alice.user.id}).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const {data: root} = await ctx.alice.api
            .drive({ownerId: ctx.alice.user.id})[aliceMountId].root.get();
        expect(root).toBeDefined();
        aliceRootId = root!.id;
    });

    describe('Folder Operations', () => {
        let folderId: string;

        test('create folder', async () => {
            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId})
                .post({folderName: 'Test Folder'});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.name).toBe('Test Folder');
            expect(data!.type).toBe('folder');
            folderId = data!.id;
        });

        test('list folder contents shows new folder', async () => {
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId})
                .get();

            expect(data).toBeDefined();
            const folder = data!.find(item => item.id === folderId);
            expect(folder).toBeDefined();
            expect(folder!.name).toBe('Test Folder');
        });

        test('rename folder', async () => {
            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: folderId}).rename
                .put({newName: 'Renamed Folder'});

            expect(error).toBeNull();
        });

        test('delete folder', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: folderId})
                .delete();

            expect(error).toBeNull();
        });
    });

    describe('File Upload & Management', () => {
        let uploadFolderId: string;
        let uploadedFileId: string;
        const testFileContent = 'Hello, Eigen test!';
        const testFileName = 'test-file.txt';

        beforeAll(async () => {
            // Create a folder for upload tests
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId})
                .post({folderName: 'Upload Tests'});
            uploadFolderId = data!.id;
        });

        test('upload file', async () => {
            const file = new File([testFileContent], testFileName, {type: 'text/plain'});

            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .file({pathId: uploadFolderId})
                .post({file});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.name).toBe(testFileName);
            expect(data!.size).toBe(testFileContent.length);
            expect(data!.mimeType).toBe('text/plain');
            uploadedFileId = data!.id;
        });

        test('file appears in folder listing', async () => {
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: uploadFolderId})
                .get();

            expect(data).toBeDefined();
            const file = data!.find(item => item.id === uploadedFileId);
            expect(file).toBeDefined();
            expect(file!.name).toBe(testFileName);
        });

        test('storage size increased', async () => {
            const {data: size} = await ctx.alice.api
                .home({ownerId: ctx.alice.user.id}).size.get();

            expect(size).toBeDefined();
            expect(size!.drive).toBeGreaterThan(0);
            expect(size!.used).toBeGreaterThan(0);
        });

        test('download file returns correct content', async () => {
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .file({pathId: uploadedFileId}).download
                .get();

            expect(data).toBeDefined();
            // data is an ArrayBuffer — convert to string
            const text = new TextDecoder().decode(data as ArrayBuffer);
            expect(text).toBe(testFileContent);
        });

        test('upload image generates thumbnail', async () => {
            // Create a minimal 1x1 PNG
            const pngBytes = new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
                0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
                0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
                0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
                0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
                0x44, 0xae, 0x42, 0x60, 0x82,
            ]);
            const imageFile = new File([pngBytes], 'test-image.png', {type: 'image/png'});

            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .file({pathId: uploadFolderId})
                .post({file: imageFile});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            // Thumbnail should be generated for images
            expect(data!.thumbnail).not.toBeNull();
        });

        test('rename file', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: uploadedFileId}).rename
                .put({newName: 'renamed-file.txt'});

            expect(error).toBeNull();

            // Verify rename
            const {data: file} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .file({pathId: uploadedFileId})
                .get();

            expect(file!.name).toBe('renamed-file.txt');
        });

        test('move file to different folder', async () => {
            // Create target folder
            const {data: targetFolder} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId})
                .post({folderName: 'Move Target'});

            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: uploadedFileId}).move
                .put({targetParentId: targetFolder!.id});

            expect(error).toBeNull();

            // Verify file is in new folder
            const {data: contents} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: targetFolder!.id})
                .get();

            expect(contents!.find(item => item.id === uploadedFileId)).toBeDefined();
        });

        test('delete file', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .file({pathId: uploadedFileId})
                .delete();

            expect(error).toBeNull();
        });
    });

    describe('Sharing & ACL', () => {
        let sharedFolderId: string;

        beforeAll(async () => {
            // Alice creates a folder to share
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId})
                .post({folderName: 'Shared With Bob'});
            sharedFolderId = data!.id;
        });

        test('Bob cannot access Alice folder before sharing', async () => {
            const {data} = await ctx.bob.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: sharedFolderId})
                .get();

            // SharedDrive returns [] for no read permission
            expect(data).toEqual([]);
        });

        test('Alice shares folder with Bob (read)', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: sharedFolderId}).acl
                .put({
                    acl: [{
                        email: 'bob@test.eigen.is',
                        read: true,
                        write: false,
                        public: false,
                    }],
                });

            expect(error).toBeNull();
        });

        test('Bob can now read shared folder', async () => {
            const {data} = await ctx.bob.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: sharedFolderId})
                .get();

            // Should now return contents (empty folder)
            expect(data).toBeDefined();
            expect(Array.isArray(data)).toBe(true);
        });

        test('Bob sees folder in shared-with-me list', async () => {
            const {data} = await ctx.bob.api
                .drive({ownerId: ctx.bob.user.id}).shared['with-me']
                .get();

            expect(data).toBeDefined();
            const shared = data!.find(item => item.id === sharedFolderId);
            expect(shared).toBeDefined();
        });

        test('Alice sees folder in shared-by-me list', async () => {
            const {data} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id}).shared['by-me']
                .get();

            expect(data).toBeDefined();
            const shared = data!.find(item => item.id === sharedFolderId);
            expect(shared).toBeDefined();
        });

        test('Alice upgrades Bob to write access', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: sharedFolderId}).acl
                .put({
                    acl: [{
                        email: 'bob@test.eigen.is',
                        read: true,
                        write: true,
                        public: false,
                    }],
                });

            expect(error).toBeNull();
        });

        test('Bob can create folder inside shared folder', async () => {
            const {data, error} = await ctx.bob.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: sharedFolderId})
                .post({folderName: 'Bobs Subfolder'});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.name).toBe('Bobs Subfolder');
        });

        test('Alice revokes sharing', async () => {
            const {error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .path({pathId: sharedFolderId}).acl
                .put({acl: []});

            expect(error).toBeNull();
        });

        test('Bob can no longer access after revoke', async () => {
            const {data} = await ctx.bob.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: sharedFolderId})
                .get();

            expect(data).toEqual([]);
        });
    });

    describe('Doc & Stickies Creation', () => {
        test('create doc', async () => {
            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId}).doc
                .post({fileName: 'Test Document'});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.name).toBe('Test Document.eigendoc');
            expect(data!.type).toBe('doc');
        });

        test('create stickies', async () => {
            const {data, error} = await ctx.alice.api
                .drive({ownerId: ctx.alice.user.id})[aliceMountId]
                .folder({pathId: aliceRootId}).stickies
                .post({fileName: 'Test Board'});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.name).toBe('Test Board.eigenstickies');
            expect(data!.type).toBe('stickies');
        });
    });
});
```

### 4.3 Home Tests — `apps/api/src/test/home.test.ts`

```ts
import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext} from './setup';

describe('Home', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('get home size returns valid structure', async () => {
        const {data, error} = await ctx.alice.api
            .home({ownerId: ctx.alice.user.id}).size.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        expect(typeof data!.mail).toBe('number');
        expect(typeof data!.contacts).toBe('number');
        expect(typeof data!.drive).toBe('number');
        expect(typeof data!.used).toBe('number');
        expect(typeof data!.max).toBe('number');
        expect(data!.max).toBeGreaterThan(0);
    });

    test('used = mail + contacts + drive', async () => {
        const {data} = await ctx.alice.api
            .home({ownerId: ctx.alice.user.id}).size.get();

        expect(data!.used).toBe(data!.mail + data!.contacts + data!.drive);
    });
});
```

### 4.4 Contacts Tests — `apps/api/src/test/contacts.test.ts`

```ts
import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext} from './setup';

describe('Contacts', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let contactId: string;
    let labelId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('Contact CRUD', () => {
        test('create contact', async () => {
            const {data, error} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).contacts
                .post({
                    firstName: 'Charlie',
                    lastName: 'Test',
                    email: ['charlie@test.eigen.is'],
                    phone: ['+1234567890'],
                    company: 'Eigen',
                    jobTitle: 'Tester',
                });

            expect(error).toBeNull();
            expect(data).toBeDefined();
            contactId = (data as any).id;
        });

        test('list contacts includes new contact', async () => {
            const {data} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).contacts.get();

            expect(data).toBeDefined();
            expect(Array.isArray(data)).toBe(true);
            const contact = (data as any[]).find(c => c.id === contactId);
            expect(contact).toBeDefined();
            expect(contact.firstName).toBe('Charlie');
        });

        test('get contact by id', async () => {
            const {data} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).contacts({id: contactId}).get();

            expect(data).toBeDefined();
            expect((data as any).firstName).toBe('Charlie');
        });

        test('update contact', async () => {
            const {error} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).contacts({id: contactId})
                .put({
                    firstName: 'Charlie',
                    lastName: 'Updated',
                    email: ['charlie@test.eigen.is'],
                    phone: [],
                });

            expect(error).toBeNull();
        });

        test('delete contact', async () => {
            const {error} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).contacts({id: contactId})
                .delete();

            expect(error).toBeNull();
        });
    });

    describe('Labels', () => {
        test('create label', async () => {
            const {data, error} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).labels
                .post({name: 'VIP', color: '#ff0000'});

            expect(error).toBeNull();
            expect(data).toBeDefined();
            labelId = (data as any).id;
        });

        test('list labels', async () => {
            const {data} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).labels.get();

            expect(data).toBeDefined();
            expect(Array.isArray(data)).toBe(true);
        });

        test('delete label', async () => {
            const {error} = await ctx.alice.api
                .contacts({ownerId: ctx.alice.user.id}).labels({id: labelId})
                .delete();

            expect(error).toBeNull();
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob cannot see Alice contacts', async () => {
            // Bob lists his own contacts — should be empty, not Alice's
            const {data} = await ctx.bob.api
                .contacts({ownerId: ctx.bob.user.id}).contacts.get();

            expect(data).toBeDefined();
            expect((data as any[]).length).toBe(0);
        });
    });
});
```

### 4.5 Mail Tests — `apps/api/src/test/mail.test.ts`

```ts
import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext} from './setup';

describe('Mail', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('list mailboxes returns default structure', async () => {
        const {data, error} = await ctx.alice.api
            .mail({ownerId: ctx.alice.user.id}).mailboxes.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        // Should have at least INBOX after initialization
    });

    test('create custom mailbox', async () => {
        const {data, error} = await ctx.alice.api
            .mail({ownerId: ctx.alice.user.id}).mailbox
            .post({mailbox: 'Projects', attributes: []});

        expect(error).toBeNull();
    });

    test('check mailbox exists', async () => {
        // Use the wildcard route for mailbox-exists
        const response = await ctx.app.handle(
            new Request('http://localhost/mail/' + ctx.alice.user.id + '/mailbox-exists/Projects', {
                headers: {
                    cookie: `better-auth.session_token=${/* alice's token */''}`
                }
            })
        );
        // Verify the mailbox we just created exists
        // Note: exact assertion depends on return type
    });

    describe('Cross-user isolation', () => {
        test('Bob has his own separate mailbox', async () => {
            const {data} = await ctx.bob.api
                .mail({ownerId: ctx.bob.user.id}).mailboxes.get();

            expect(data).toBeDefined();
        });
    });
});
```

> **Note on Mail tests:** Mail is harder to integration-test fully because sending/receiving requires SMTP. The tests above focus on mailbox management. Full mail tests would require delivering test messages via the `/mail/deliver/:to` endpoint.

---

## 5. Scripts

### Root `package.json`

```json
{
  "scripts": {
    "test": "bun --filter '@apps/api' test",
    "check": "bun run typecheck && bun run test"
  }
}
```

### `apps/api/package.json`

```json
{
  "scripts": {
    "test": "bun test --preload ./src/test/preload.ts ./src/test/"
  }
}
```

### Usage

```bash
bun run check          # Full check: typecheck all packages + run all tests
bun run test           # Just tests
bun test ./apps/api    # Just API tests
```

---

## 6. Implementation Checklist

| # | Task | Files |
|---|------|-------|
| 1 | Make `DATA_ROOT` configurable via `EIGEN_DATA_ROOT` env var | `apps/api/src/lib/config/paths.ts` |
| 2 | Create test setup module | `apps/api/src/test/setup.ts` |
| 3 | Create preload script | `apps/api/src/test/preload.ts` |
| 4 | Write auth tests | `apps/api/src/test/auth.test.ts` |
| 5 | Write drive tests (CRUD, upload, thumbnail, sharing/ACL) | `apps/api/src/test/drive.test.ts` |
| 6 | Write home tests | `apps/api/src/test/home.test.ts` |
| 7 | Write contacts tests | `apps/api/src/test/contacts.test.ts` |
| 8 | Write mail tests | `apps/api/src/test/mail.test.ts` |
| 9 | Update `apps/api/package.json` test script | `apps/api/package.json` |
| 10 | Add `test` and `check` scripts to root `package.json` | `package.json` |
| 11 | Remove old `apps/api/src/app.test.ts` | `apps/api/src/app.test.ts` |

---

## 7. Important Notes

### Eden Treaty Route Syntax

The pseudocode above uses **estimated** Treaty paths based on the Elysia route definitions. The actual Treaty syntax is auto-generated from the route types. The implementer should:
1. Import `treaty` from `@elysiajs/eden`
2. Pass the `app` instance: `treaty(app)`
3. Use IDE autocomplete to discover the exact paths (they're fully type-safe)
4. For wildcard routes (e.g., `/mail/:ownerId/mailbox/*`), fall back to `app.handle(new Request(...))` if Treaty doesn't support wildcards cleanly

### Auth Cookie Name

The session cookie name depends on `better-auth` configuration. Default is typically `better-auth.session_token`. If this doesn't work, check the `Set-Cookie` header from `signInEmail` response.

### Test Order

Tests within a `describe` block run **sequentially** by default in Bun. This is important for tests that build on each other (e.g., create → list → delete). Use `beforeAll` for shared setup.

### Future: Frontend Tests

Once API tests are solid, add frontend tests:
- **Pure function tests** (`packages/lib/src/types/drive.ts` — `isContainerType`, `isCollabType`)
- **Hook tests** with React Testing Library (`packages/ui/src/hooks/`)
- **SSE handler tests** (`packages/lib/src/lib/*/sse-handlers.ts`)

These don't require the API test infrastructure — they're standard unit tests.
