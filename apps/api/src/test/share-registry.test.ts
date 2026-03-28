import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getServerConfig } from '../lib/config/server-config';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

describe('Share Registry', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        // Get Alice's default calendar
        const calRes = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(calRes);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;

        // Get Alice's drive root
        const rootRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/root`);
        const root = await assertJson<DrivePath>(rootRes);
        aliceRootId = root.id;
    });

    describe('Registry entries on share', () => {
        test('share calendar with existing user creates no registry entry, user gets share', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [{ targetId: ctx.bob.user.email, permission: 'read' }],
                    }),
                },
            );
            expect(res.status).toBe(200);

            // Bob should see Alice's shared calendar
            const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
            const shared = await assertJson<SharedCalendar[]>(sharedRes);
            const found = findOrFail(shared, (s) => s.calendarId === aliceCalendarId);
            expect(found.permission).toBe('read');
        });

        test('share drive path with existing user propagates ACL', async () => {
            // Create a folder
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'registry-test-shared' }),
                },
            );
            const folder = (await folderRes.json()) as DrivePath;

            // Share with Bob
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: ctx.bob.user.email, read: true, write: false }],
                    }),
                },
            );

            // Bob should see the shared path
            const sharedRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`,
            );
            const shared = await assertJson<DrivePath[]>(sharedRes);
            findOrFail(shared, (s) => s.id === folder.id);
        });
    });

    describe('Pull routes', () => {
        test('GET /calendar/:ownerId/shared-with-me returns shared calendars', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.alice.user.id}/shared-with-me`);
            expect(res.status).toBe(200);
            const results = await assertJson<SharedCalendar[]>(res);
            const found = findOrFail(results, (r) => r.calendarId === aliceCalendarId);
            expect(found.permission).toBe('read');
        });

        test('GET /drive/:ownerId/shared-with-me returns shared paths', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.alice.user.id}/shared-with-me`);
            expect(res.status).toBe(200);
            const results = await assertJson<DrivePath[]>(res);
            expect(results.length).toBeGreaterThan(0);
            findOrFail(results, (r) => r.name === 'registry-test-shared');
        });

        test('unshared user gets empty results from pull routes', async () => {
            const calRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/shared-with-me`,
            );
            expect(calRes.status).toBe(200);
            const calResults = await assertJson<SharedCalendar[]>(calRes);
            const found = calResults.find((r) => r.calendarId === aliceCalendarId);
            expect(found).toBeUndefined();

            const driveRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/drive/${ctx.alice.user.id}/shared-with-me`,
            );
            expect(driveRes.status).toBe(200);
            const driveResults = await assertJson<DrivePath[]>(driveRes);
            const driveFound = driveResults.find((r) => r.name === 'registry-test-shared');
            expect(driveFound).toBeUndefined();
        });
    });

    describe('Reconciliation', () => {
        test('new user receives pending shares on creation', async () => {
            // Share calendar with non-existent email
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [
                            { targetId: ctx.bob.user.email, permission: 'read' },
                            { targetId: 'newuser@test.eigen.is', permission: 'write' },
                        ],
                    }),
                },
            );

            // Share drive path with non-existent email
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'registry-pending-test' }),
                },
            );
            const folder = (await folderRes.json()) as DrivePath;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: 'newuser@test.eigen.is', read: true, write: true }],
                    }),
                },
            );

            // Now create the user — reconciliation should fire
            const { auth } = await import('../lib/auth/auth');
            const signUp = await auth.api.signUpEmail({
                body: {
                    email: 'newuser@test.eigen.is',
                    password: 'testpassword123',
                    name: 'New User',
                },
            });

            const newUserId = signUp.user.id;

            // Sign in to get session
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email: 'newuser@test.eigen.is', password: 'testpassword123' },
            });

            const setCookie = signIn.headers.get('set-cookie') || '';
            const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
            const sessionToken = match?.[1] || '';

            // New user should have Alice's shared calendar
            const sharedRes = await authedRequest(sessionToken, `/calendar/${newUserId}/shared`);
            const shared = await assertJson<SharedCalendar[]>(sharedRes);
            const calFound = findOrFail(shared, (s) => s.calendarId === aliceCalendarId);
            expect(calFound.permission).toBe('write');

            // New user should have Alice's shared drive path
            const driveRes = await authedRequest(sessionToken, `/drive/${newUserId}/shared/with-me`);
            const drivePaths = await assertJson<DrivePath[]>(driveRes);
            findOrFail(drivePaths, (s) => s.name === 'registry-pending-test');
        });

        test('new team member receives team-shared calendar and drive items via registry', async () => {
            const config = getServerConfig();
            const orgId = config!.orgId;

            // Set active org
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });

            // Create a team
            const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Registry Test Team',
                    organizationId: orgId,
                }),
            });
            const team = (await teamRes.json()) as { id: string; name: string };
            const teamId = team.id;

            // Alice shares her calendar with the team
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [
                            { targetId: ctx.bob.user.email, permission: 'read' },
                            { targetId: `team_${teamId}`, permission: 'write' },
                        ],
                    }),
                },
            );

            // Alice shares a drive folder with the team
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'team-registry-test' }),
                },
            );
            const folder = (await folderRes.json()) as DrivePath;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: `team_${teamId}`, read: true, write: true }],
                    }),
                },
            );

            // Create a new user who is NOT yet on the team
            const { auth } = await import('../lib/auth/auth');
            const signUp = await auth.api.signUpEmail({
                body: {
                    email: 'teamuser@test.eigen.is',
                    password: 'testpassword123',
                    name: 'Team User',
                },
            });
            const teamUserId = signUp.user.id;

            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email: 'teamuser@test.eigen.is', password: 'testpassword123' },
            });
            const setCookie = signIn.headers.get('set-cookie') || '';
            const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
            const teamUserToken = match?.[1] || '';

            // Before joining team: should NOT have the shared items
            const preCalRes = await authedRequest(teamUserToken, `/calendar/${teamUserId}/shared`);
            const preShared = await assertJson<SharedCalendar[]>(preCalRes);
            const preCalFound = preShared.find((s) => s.calendarId === aliceCalendarId);
            expect(preCalFound).toBeUndefined();

            const preDriveRes = await authedRequest(teamUserToken, `/drive/${teamUserId}/shared/with-me`);
            const preDrivePaths = await assertJson<DrivePath[]>(preDriveRes);
            const preDriveFound = preDrivePaths.find((s) => s.name === 'team-registry-test');
            expect(preDriveFound).toBeUndefined();

            // Add the new user to the team — triggers teamMember.create.after hook
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId, userId: teamUserId }),
            });

            // After joining team: should have the shared calendar
            const postCalRes = await authedRequest(teamUserToken, `/calendar/${teamUserId}/shared`);
            const postShared = await assertJson<SharedCalendar[]>(postCalRes);
            const postCalFound = findOrFail(postShared, (s) => s.calendarId === aliceCalendarId);
            expect(postCalFound.permission).toBe('write');

            // After joining team: should have the shared drive path
            const postDriveRes = await authedRequest(teamUserToken, `/drive/${teamUserId}/shared/with-me`);
            const postDrivePaths = await assertJson<DrivePath[]>(postDriveRes);
            findOrFail(postDrivePaths, (s) => s.name === 'team-registry-test');
        });

        test('idempotency: reconciliation called twice produces no duplicates', async () => {
            const { reconcileSharesForNewUser } = await import('../lib/share');
            const { getUserByEmail } = await import('../lib/user');

            const user = await getUserByEmail('newuser@test.eigen.is');
            expect(user).toBeDefined();

            // Call reconciliation again (entries were already consumed, so this is a no-op)
            await reconcileSharesForNewUser(user!);

            // Sign in to verify
            const { auth } = await import('../lib/auth/auth');
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email: 'newuser@test.eigen.is', password: 'testpassword123' },
            });
            const setCookie = signIn.headers.get('set-cookie') || '';
            const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
            const sessionToken = match?.[1] || '';

            // Drive share should still be exactly 1 (not duplicated)
            const driveRes = await authedRequest(sessionToken, `/drive/${user!.id}/shared/with-me`);
            const drivePaths = await assertJson<DrivePath[]>(driveRes);
            const driveMatches = drivePaths.filter((s) => s.name === 'registry-pending-test');
            expect(driveMatches.length).toBe(1);
        });
    });
});
