import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DriveAccessCheckResult, DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../auth-schema';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { getServerConfig } from '../lib/config/server-config';
import { updateServerSettings } from '../lib/config/server-settings';
import { addRegistryEntry } from '../lib/share/registry';
import {
    addMember,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    drivePost,
    drivePut,
    getTestContext,
} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

async function accessCheck(token: string, ownerId: string, pathId: string, emails: string[]): Promise<Response> {
    return authedRequest(token, `/drive/${ownerId}/${MOUNT}/path/${pathId}/access-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
    });
}

async function createGuest(email: string): Promise<void> {
    const created = await auth.api.createUser({
        body: { email, password: randomUUID(), name: 'AC Guest', role: 'user' },
    });
    getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
}

describe('Drive access check', () => {
    let ctx: TestCtx;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceRootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
    });

    async function createFolder(name: string, parentId = aliceRootId): Promise<string> {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${parentId}`,
            { folderName: `${name}-${randomUUID()}` },
        );
        return folder.id;
    }

    async function setAcl(
        pathId: string,
        body: {
            add?: Array<{ id: string; read: boolean; write: boolean }>;
            visibility?: string;
            sharingRestricted?: boolean;
        },
    ): Promise<void> {
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, `path/${pathId}/acl`, body);
    }

    // 1. ACL read flags: read:true grants, read:false (write:true) does not.
    describe('ACL read flags', () => {
        const reader = 'ac-reader@test.eigen.is';
        const writerNoRead = 'ac-writer-noread@test.eigen.is';
        let folderId: string;

        beforeAll(async () => {
            folderId = await createFolder('acl-flags');
            await setAcl(folderId, {
                add: [
                    { id: reader, read: true, write: false },
                    { id: writerNoRead, read: false, write: true },
                ],
            });
        });

        test('read:true → hasReadAccess, read:false/write:true → no read access', async () => {
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [reader, writerNoRead]),
            );
            expect(body.recipients.find((r) => r.email === reader)?.hasReadAccess).toBe(true);
            expect(body.recipients.find((r) => r.email === writerNoRead)?.hasReadAccess).toBe(false);
        });
    });

    // 2. Public visibility: an ancestor or the path itself being public grants read; private denies.
    describe('public visibility', () => {
        const outsider = 'ac-visibility-outsider@test.eigen.is';

        test('public-read on an ancestor grants child access', async () => {
            const parentId = await createFolder('public-parent');
            await setAcl(parentId, { visibility: 'public-read' });
            const childId = await createFolder('private-child', parentId);
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, childId, [outsider]),
            );
            expect(body.recipients.find((r) => r.email === outsider)?.hasReadAccess).toBe(true);
        });

        test('public-read on the path itself grants access', async () => {
            const folderId = await createFolder('public-self');
            await setAcl(folderId, { visibility: 'public-read' });
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [outsider]),
            );
            expect(body.recipients.find((r) => r.email === outsider)?.hasReadAccess).toBe(true);
        });

        test('fully private denies read', async () => {
            const folderId = await createFolder('fully-private');
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [outsider]),
            );
            expect(body.recipients.find((r) => r.email === outsider)?.hasReadAccess).toBe(false);
        });
    });

    // 3. needsGuestAdmission = !user && !openSignup && no registry entry.
    describe('needsGuestAdmission matrix', () => {
        let folderId: string;

        beforeAll(async () => {
            folderId = await createFolder('guest-admission');
        });

        afterAll(async () => {
            await updateServerSettings({ guests: { openSignup: true } });
        });

        test('unknown email × openSignup true → false', async () => {
            await updateServerSettings({ guests: { openSignup: true } });
            const email = `ac-unknown-${randomUUID()}@example.com`;
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [email]),
            );
            expect(body.recipients.find((r) => r.email === email)?.needsGuestAdmission).toBe(false);
        });

        test('unknown email × openSignup false → true', async () => {
            await updateServerSettings({ guests: { openSignup: false } });
            const email = `ac-unknown-${randomUUID()}@example.com`;
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [email]),
            );
            expect(body.recipients.find((r) => r.email === email)?.needsGuestAdmission).toBe(true);
        });

        test('unknown email with a registry entry × closed → false', async () => {
            await updateServerSettings({ guests: { openSignup: false } });
            const email = `ac-registered-${randomUUID()}@example.com`;
            await addRegistryEntry(ctx.alice.user.id, email);
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [email]),
            );
            expect(body.recipients.find((r) => r.email === email)?.needsGuestAdmission).toBe(false);
        });

        test('registered guest × closed → false', async () => {
            await updateServerSettings({ guests: { openSignup: false } });
            const email = `ac-guest-${randomUUID()}@example.com`;
            await createGuest(email);
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [email]),
            );
            expect(body.recipients.find((r) => r.email === email)?.needsGuestAdmission).toBe(false);
        });
    });

    // 4. The sender's own address is stripped from the recipient list.
    describe('sender exclusion', () => {
        test('the caller email never appears in recipients', async () => {
            const folderId = await createFolder('sender-exclusion');
            const other = 'ac-other@test.eigen.is';
            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [
                    ctx.alice.user.email,
                    ctx.alice.user.email.toUpperCase(),
                    other,
                ]),
            );
            expect(body.recipients.some((r) => r.email === ctx.alice.user.email.toLowerCase())).toBe(false);
            expect(body.recipients.some((r) => r.email === other)).toBe(true);
        });
    });

    // 5. SharedDrive gating: canShare mirrors updateACLDelta's write + sharing-restricted gate; strangers 403.
    describe('SharedDrive gating', () => {
        test('read-only bob → 200 canShare:false', async () => {
            const folderId = await createFolder('bob-readonly');
            await setAcl(folderId, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
            const res = await accessCheck(ctx.bob.user.sessionToken, ctx.alice.user.id, folderId, [
                'probe@test.eigen.is',
            ]);
            const body = await assertJson<DriveAccessCheckResult>(res);
            expect(body.canShare).toBe(false);
        });

        test('write bob → 200 canShare:true', async () => {
            const folderId = await createFolder('bob-write');
            await setAcl(folderId, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });
            const res = await accessCheck(ctx.bob.user.sessionToken, ctx.alice.user.id, folderId, [
                'probe@test.eigen.is',
            ]);
            const body = await assertJson<DriveAccessCheckResult>(res);
            expect(body.canShare).toBe(true);
        });

        test('charlie with no ACL → 403', async () => {
            const folderId = await createFolder('charlie-none');
            const res = await accessCheck(ctx.charlie.user.sessionToken, ctx.alice.user.id, folderId, [
                'probe@test.eigen.is',
            ]);
            expect(res.status).toBe(403);
        });

        test('sharingRestricted path with write bob → canShare:false', async () => {
            const folderId = await createFolder('bob-restricted');
            await setAcl(folderId, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
                sharingRestricted: true,
            });
            const res = await accessCheck(ctx.bob.user.sessionToken, ctx.alice.user.id, folderId, [
                'probe@test.eigen.is',
            ]);
            const body = await assertJson<DriveAccessCheckResult>(res);
            expect(body.canShare).toBe(false);
        });
    });

    // 6. Team ACL entries expand to member emails, which then count as read access.
    describe('team-owned ACL expansion', () => {
        test('a member of an ACL-granted team has read access', async () => {
            const orgId = getServerConfig()!.orgId;
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });
            const teamId = await createTeam(ctx, orgId, 'Access Check Team');
            await addMember(ctx, teamId, ctx.bob.user.id);

            const folderId = await createFolder('team-shared');
            await setAcl(folderId, { add: [{ id: `team_${teamId}`, read: true, write: false }] });

            const body = await assertJson<DriveAccessCheckResult>(
                await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, [ctx.bob.user.email]),
            );
            expect(body.recipients.find((r) => r.email === ctx.bob.user.email.toLowerCase())?.hasReadAccess).toBe(true);
        });
    });

    // 7. Missing path → 404; over the recipient cap → rejected before the handler.
    describe('bounds', () => {
        test('unknown pathId → 404', async () => {
            const res = await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, randomUUID(), [
                'probe@test.eigen.is',
            ]);
            expect(res.status).toBe(404);
        });

        test('over the recipient cap is rejected', async () => {
            const folderId = await createFolder('too-many');
            const emails = Array.from({ length: 101 }, (_, i) => `ac-many-${i}@example.com`);
            const res = await accessCheck(ctx.alice.user.sessionToken, ctx.alice.user.id, folderId, emails);
            // TypeBox maxItems violation → Elysia validation error (422 here, see integration.test.ts).
            expect(res.status).toBe(422);
        });
    });
});
