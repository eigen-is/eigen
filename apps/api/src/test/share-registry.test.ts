import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type MountInfo, teamOwnerId } from '@workspace/lib/types';
import type { CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, EmailDraft } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { getServerConfig } from '../lib/config/server-config';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    drivePost,
    drivePut,
    findOrFail,
    firstMountId,
    getTestContext,
} from './setup';

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
                        add: [{ id: ctx.bob.user.email, read: true, write: false }],
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
                        add: [{ id: 'newuser@test.eigen.is', read: true, write: true }],
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
                        add: [{ id: `team_${teamId}`, read: true, write: true }],
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

        test('new user receives a team-owned drive item from a team_ registry source', async () => {
            const orgId = getServerConfig()!.orgId;

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });

            const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `Team Source ${randomUUID()}`, organizationId: orgId }),
            });
            const team = (await teamRes.json()) as { id: string; name: string };
            const teamOwner = teamOwnerId(team.id);

            // Alice must be a team member to write to the team drive.
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team.id, userId: ctx.alice.user.id }),
            });

            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwner}/mount`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Team Drive', storageType: 'local', maxSizeMB: 500 }),
            });
            const mounts = await assertJson<MountInfo[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`),
            );
            const teamMountId = mounts[0].id;
            const teamRoot = await assertJson<DrivePath>(
                await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/${teamMountId}/root`),
            );

            // A folder OWNED by the team — sharing it to an unknown email mints a team_ SOURCE entry.
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/folder/${teamRoot.id}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'team-source-registry-test' }),
                },
            );
            const folder = (await folderRes.json()) as DrivePath;

            const email = `team-source-${randomUUID()}@test.eigen.is`;
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: email, read: true, write: false }] }),
                },
            );

            const { getEntriesForTarget } = await import('../lib/share/registry');
            expect(await getEntriesForTarget(email)).toContain(teamOwner);

            // Signing up fires reconciliation — the team_ source must now be delivered.
            const { auth } = await import('../lib/auth/auth');
            const signUp = await auth.api.signUpEmail({
                body: { email, password: 'testpassword123', name: 'Team Source User' },
            });
            const newUserId = signUp.user.id;
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email, password: 'testpassword123' },
            });
            const setCookie = signIn.headers.get('set-cookie') || '';
            const sessionToken = setCookie.match(/better-auth\.session_token=([^;]+)/)?.[1] || '';

            const drivePaths = await assertJson<DrivePath[]>(
                await authedRequest(sessionToken, `/drive/${newUserId}/shared/with-me`),
            );
            findOrFail(drivePaths, (s) => s.name === 'team-source-registry-test');

            // Idempotency: a second reconcile produces no duplicate row.
            const { reconcileSharesForNewUser } = await import('../lib/share');
            const { getUserByEmail } = await import('../lib/user');
            const user = await getUserByEmail(email);
            await reconcileSharesForNewUser(user!);

            const drivePaths2 = await assertJson<DrivePath[]>(
                await authedRequest(sessionToken, `/drive/${newUserId}/shared/with-me`),
            );
            expect(drivePaths2.filter((s) => s.name === 'team-source-registry-test').length).toBe(1);
        });

        test('new team member receives a team-owned drive item from a team_ registry source', async () => {
            const orgId = getServerConfig()!.orgId;

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });

            // Two teams: the source owns the drive path, the target is the ACL entry it is granted to.
            const sourceTeamId = await createTeam(ctx, orgId, `Member Source ${randomUUID()}`);
            const targetTeamId = await createTeam(ctx, orgId, `Member Target ${randomUUID()}`);
            const sourceOwner = teamOwnerId(sourceTeamId);
            const targetOwner = teamOwnerId(targetTeamId);

            // Alice must be a source-team member to write to its drive.
            await addMember(ctx, sourceTeamId, ctx.alice.user.id);
            await addTeamMount(ctx, sourceTeamId, 'Team Drive');

            const token = ctx.alice.user.sessionToken;
            const sourceMountId = await firstMountId(token, sourceOwner);
            const sourceRoot = await driveGet<DrivePath>(token, sourceOwner, sourceMountId, 'root');
            const folder = await drivePost<DrivePath>(token, sourceOwner, sourceMountId, `folder/${sourceRoot.id}`, {
                folderName: 'team-member-source-test',
            });

            // Team-to-team grant on a team-owned path: mints a team_ SOURCE entry for the target team.
            await drivePut(token, sourceOwner, sourceMountId, `path/${folder.id}/acl`, {
                add: [{ id: targetOwner, read: true, write: false }],
            });

            const { getEntriesForTarget } = await import('../lib/share/registry');
            expect(await getEntriesForTarget(targetOwner)).toContain(sourceOwner);

            // A user who joins the target team only afterwards — the ACL fan-out already passed them by.
            const email = `team-member-${randomUUID()}@test.eigen.is`;
            const { auth } = await import('../lib/auth/auth');
            const signUp = await auth.api.signUpEmail({
                body: { email, password: 'testpassword123', name: 'Team Member User' },
            });
            const memberId = signUp.user.id;
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email, password: 'testpassword123' },
            });
            const memberToken =
                (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)?.[1] || '';

            const preShared = await assertJson<DrivePath[]>(
                await authedRequest(memberToken, `/drive/${memberId}/shared/with-me`),
            );
            expect(preShared.some((p) => p.id === folder.id)).toBe(false);

            // Joining fires afterAddTeamMember → reconcileSharesForNewTeamMember.
            await addMember(ctx, targetTeamId, memberId);

            const shared = await assertJson<DrivePath[]>(
                await authedRequest(memberToken, `/drive/${memberId}/shared/with-me`),
            );
            findOrFail(shared, (s) => s.id === folder.id);
        });

        test('mail-grant on a team doc admits a closed-signup guest and delivers the item + notification', async () => {
            const orgId = getServerConfig()!.orgId;

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });
            const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `Team Grant ${randomUUID()}`, organizationId: orgId }),
            });
            const team = (await teamRes.json()) as { id: string; name: string };
            const teamOwner = teamOwnerId(team.id);
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team.id, userId: ctx.alice.user.id }),
            });
            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwner}/mount`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Team Drive', storageType: 'local', maxSizeMB: 500 }),
            });
            const mounts = await assertJson<MountInfo[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`),
            );
            const teamMountId = mounts[0].id;
            const teamRoot = await assertJson<DrivePath>(
                await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/${teamMountId}/root`),
            );

            const docRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/folder/${teamRoot.id}/create/doc`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: `team-grant-doc-${randomUUID()}` }),
                },
            );
            const doc = (await docRes.json()) as DrivePath;

            const guestEmail = `team-guest-${randomUUID()}@external.com`;

            const { updateServerSettings } = await import('../lib/config/server-settings');
            await updateServerSettings({ guests: { openSignup: false } });

            const mailer = await import('../lib/core/mailer');
            const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
            try {
                // Mail-grant the team-owned doc to the unknown external email (Task 9 send path).
                const ref: AttachmentReference = {
                    type: 'reference',
                    ownerId: teamOwner,
                    mountId: teamMountId,
                    id: doc.id,
                    name: doc.name,
                    driveType: 'doc',
                    mimeType: 'application/eigendoc',
                };
                const to: AddressObject = { value: [{ address: guestEmail, name: '' }], html: '', text: guestEmail };
                const mail = {
                    subject: 'Team grant',
                    text: 'see attached',
                    html: '<p>see attached</p>',
                    to,
                    driveReferences: [ref],
                };
                const draft = await assertJson<EmailDraft>(
                    await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mail }),
                    }),
                );
                const sendRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/mail/${ctx.alice.user.id}/message/send`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mail: { ...draft, to, driveReferences: [ref] },
                            grantAccessRefIds: [doc.id],
                        }),
                    },
                );
                expect(sendRes.status).toBe(200);

                const { getEntriesForTarget } = await import('../lib/share/registry');
                expect(await getEntriesForTarget(guestEmail)).toContain(teamOwner);

                // request-otp admits the closed-signup guest solely on the registry entry — Phase 2 payoff.
                spy.mockClear();
                const otpRes = await ctx.app.handle(
                    new Request('http://localhost/guest-auth/request-otp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: guestEmail }),
                    }),
                );
                expect(otpRes.status).toBe(200);

                const otpCall = spy.mock.calls.find((c) => c[0].to.some((t) => t.address === guestEmail));
                if (!otpCall) throw new Error('OTP email not sent');
                const otp = otpCall[0].text.match(/\b(\d{6})\b/)?.[1];
                if (!otp) throw new Error('OTP not found in email body');

                const verifyRes = await ctx.app.handle(
                    new Request('http://localhost/guest-auth/verify-otp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: guestEmail, otp }),
                    }),
                );
                expect(verifyRes.status).toBe(200);
                const guestToken =
                    (verifyRes.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)?.[1] || '';

                const { getUserByEmail } = await import('../lib/user');
                const guest = await getUserByEmail(guestEmail);
                if (!guest) throw new Error('guest user not created');

                // The team-owned doc reaches the guest's shared-with-me mirror via reconciliation.
                const shared = await assertJson<DrivePath[]>(
                    await authedRequest(guestToken, `/drive/${guest.id}/shared/with-me`),
                );
                expect(shared.some((p) => p.id === doc.id)).toBe(true);

                // ...and a share notification is persisted for the guest.
                const notifs = await assertJson<Notification[]>(
                    await authedRequest(guestToken, `/notifications/${guest.id}`),
                );
                expect(notifs.some((n) => n.tag === `share:${teamOwner}:${teamMountId}:${doc.id}`)).toBe(true);
            } finally {
                spy.mockRestore();
                await updateServerSettings({ guests: { openSignup: true } });
            }
        });
    });
});
