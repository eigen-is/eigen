import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import { eq } from 'drizzle-orm';
import { user as userScheme } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { enumerateHomes } from '../../lib/backup/enumerate-homes';
import { buildSafetyCopyName, buildServerFolderName } from '../../lib/backup/paths';
import { snapshotServer } from '../../lib/backup/snapshot-server';
import { getDataRoot, getTeamDataPath, getUserHomePath, SERVER_DATABASES } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { evictHome, getHome } from '../../lib/home/get-home';
import { createTeam, createTestUser, getTestContext, TEST_DATA_DIR } from '../setup';

describe('Backup enumerateHomes', () => {
    const stamp = Date.now();
    const at = new Date('2026-09-30T02:03:04Z');
    let ownerId: string;
    let teamId: string;
    let guestId: string;
    let unbootedId: string;
    const orphan = `orphan${stamp}`;
    let safetyCopies: string[];
    let result: ReturnType<typeof enumerateHomes>;

    beforeAll(async () => {
        const ctx = await getTestContext();
        ownerId = (await createTestUser(`enumerate-${stamp}@test.eigen.is`, 'testpassword123', 'Enumerate Owner')).id;
        await getHome(ownerId);
        teamId = await createTeam(ctx, getServerConfig()!.orgId, `Enumerate Team ${stamp}`);
        await getHome(teamOwnerId(teamId));

        guestId = (await createTestUser(`enumerate-guest-${stamp}@test.eigen.is`, 'testpassword123', 'Guest')).id;
        // Booted as a user first, so a folder under home/ is there for the guest filter to skip.
        await getHome(guestId);
        await evictHome(guestId);
        getAuthDrizzleDb().update(userScheme).set({ role: 'guest' }).where(eq(userScheme.id, guestId)).run();

        // A row whose folder is gone: listing it would make the server job boot it into an empty home.
        unbootedId = (await createTestUser(`enumerate-gone-${stamp}@test.eigen.is`, 'testpassword123', 'Gone')).id;
        await evictHome(unbootedId);
        rmSync(getUserHomePath(unbootedId), { recursive: true, force: true });

        mkdirSync(join(getDataRoot(), 'home', orphan), { recursive: true });
        safetyCopies = [
            buildSafetyCopyName(getUserHomePath(ownerId), 'pre-restore', '20260930-020304'),
            buildSafetyCopyName(getTeamDataPath(teamId), 'failed-restore', '20260930-020304'),
        ];
        for (const dir of safetyCopies) mkdirSync(dir, { recursive: true });

        const target = mkdtempSync(join(TEST_DATA_DIR, 'enumerate-'));
        await snapshotServer(target, at);
        result = enumerateHomes(join(target, buildServerFolderName(at), 'server', SERVER_DATABASES.users));
    });

    afterAll(() => {
        rmSync(join(getDataRoot(), 'home', orphan), { recursive: true, force: true });
        for (const dir of safetyCopies) rmSync(dir, { recursive: true, force: true });
    });

    test('lists a user and a team from the captured users3.db', () => {
        expect(result.homes).toContainEqual({ ownerId, kind: 'user', name: 'Enumerate Owner' });
        expect(result.homes).toContainEqual({
            ownerId: teamOwnerId(teamId),
            kind: 'team',
            name: `Enumerate Team ${stamp}`,
        });
    });

    test('leaves a guest out, and does not call its folder an orphan', () => {
        expect(existsSync(getUserHomePath(guestId))).toBe(true);
        expect(result.homes.some((home) => home.ownerId === guestId)).toBe(false);
        expect(result.orphans.some((orphanPath) => orphanPath.endsWith(guestId))).toBe(false);
    });

    test('skips a row whose folder is missing', () => {
        expect(existsSync(getUserHomePath(unbootedId))).toBe(false);
        expect(result.homes.some((home) => home.ownerId === unbootedId)).toBe(false);
    });

    test('lists a folder with no row as an orphan and leaves safety copies out', () => {
        expect(result.orphans).toContain(`home/${orphan}`);
        expect(result.orphans.some((orphanPath) => orphanPath.includes('-restore-'))).toBe(false);
        expect(result.homes.some((home) => home.ownerId.includes('-restore-'))).toBe(false);
    });
});
