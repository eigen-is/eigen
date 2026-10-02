import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DrivePath, teamOwnerId } from '@workspace/lib/types';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema, teamMember as teamMemberSchema, team as teamSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig, updateServerConfig } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import * as mailer from '../../lib/core/mailer';
import { getUserByEmail } from '../../lib/user';
import { assertJson, authedRequest, eventually, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'testpassword123';

// The new user hook joins the organization and, when setup's team is pinned and still there, that team too.
describe('a new user joins the default team', () => {
    let ctx: TestCtx;
    let orgId: string;
    let setupTeamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        orgId = getServerConfig()?.orgId ?? '';
        // The test org has exactly the team setup made, named after it.
        const setupTeam = getAuthDrizzleDb()
            .select({ id: teamSchema.id })
            .from(teamSchema)
            .where(and(eq(teamSchema.organizationId, orgId), eq(teamSchema.name, 'Test Organization')))
            .get();
        setupTeamId = setupTeam?.id ?? '';
    });

    function isOrgMember(userId: string): boolean {
        return (
            getAuthDrizzleDb()
                .select({ id: memberSchema.id })
                .from(memberSchema)
                .where(and(eq(memberSchema.userId, userId), eq(memberSchema.organizationId, orgId)))
                .get() !== undefined
        );
    }

    function teamIdsOf(userId: string): string[] {
        return getAuthDrizzleDb()
            .select({ teamId: teamMemberSchema.teamId })
            .from(teamMemberSchema)
            .where(eq(teamMemberSchema.userId, userId))
            .all()
            .map((row) => row.teamId);
    }

    async function adminCreatesUser(local: string): Promise<{ id: string; email: string }> {
        const email = `${local}-${randomUUID().slice(0, 8)}@test.eigen.is`;
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/create-user', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ email, password: PASSWORD, name: local, role: 'user' }),
        });
        const created = await assertJson<{ user: { id: string } }>(res);
        return { id: created.user.id, email };
    }

    test('setup pins the team it made', () => {
        expect(setupTeamId).toBeTruthy();
        expect(getServerConfig()?.defaultTeamId).toBe(setupTeamId);
    });

    test('a user an admin creates in Admin → Users is in the default team', async () => {
        const user = await adminCreatesUser('admin-made');
        expect(isOrgMember(user.id)).toBe(true);
        expect(teamIdsOf(user.id)).toEqual([setupTeamId]);
    });

    test('a share to the default team made before the user existed reaches them', async () => {
        const root = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/root`),
        );
        const folder = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/folder/${root.id}`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ folderName: `everyone-${randomUUID()}` }),
            }),
        );
        const shared = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
            {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ add: [{ id: teamOwnerId(setupTeamId), read: true, write: false }] }),
            },
        );
        expect(shared.status).toBe(200);

        const user = await adminCreatesUser('late-joiner');
        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email: user.email, password: PASSWORD },
        });
        const token = signIn.headers.get('set-cookie')?.match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';

        await eventually(async () => {
            const paths = await assertJson<DrivePath[]>(await authedRequest(token, `/drive/${user.id}/shared/with-me`));
            return paths.find((p) => p.id === folder.id);
        }, 'the team share in the new user’s Shared with me');
    });

    test('a guest gets no team row', async () => {
        const openSignup = getServerSettings().guests.openSignup;
        await updateServerSettings({ guests: { openSignup: true } });
        const send = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        try {
            const email = `guest-${randomUUID()}@external.com`;
            const requested = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ email }),
                }),
            );
            expect(requested.status).toBe(200);
            const otp = send.mock.calls
                .find((c) => c[0].to.some((t) => t.address === email))?.[0]
                .text.match(/\b(\d{6})\b/)?.[1];
            const verified = await ctx.app.handle(
                new Request('http://localhost/guest-auth/verify-otp', {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ email, otp }),
                }),
            );
            expect(verified.status).toBe(200);

            const guest = await getUserByEmail(email);
            expect(guest?.role).toBe('guest');
            expect(isOrgMember(guest?.id ?? '')).toBe(false);
            expect(teamIdsOf(guest?.id ?? '')).toEqual([]);
        } finally {
            send.mockRestore();
            await updateServerSettings({ guests: { openSignup } });
        }
    });

    describe('without a default team to join', () => {
        afterAll(async () => {
            await updateServerConfig({ defaultTeamId: setupTeamId });
        });

        test('a deleted default team still lets the user join the organization', async () => {
            const gone = await auth.api.createTeam({ body: { name: `Gone ${randomUUID()}`, organizationId: orgId } });
            await updateServerConfig({ defaultTeamId: gone.id });
            getAuthDrizzleDb().delete(teamSchema).where(eq(teamSchema.id, gone.id)).run();

            const user = await adminCreatesUser('after-delete');
            expect(isOrgMember(user.id)).toBe(true);
            expect(teamIdsOf(user.id)).toEqual([]);
        });

        test('an install with no pinned default team joins the user to the organization only', async () => {
            await updateServerConfig({ defaultTeamId: undefined });

            const user = await adminCreatesUser('unpinned');
            expect(isOrgMember(user.id)).toBe(true);
            expect(teamIdsOf(user.id)).toEqual([]);
        });
    });
});
