import {describe, test, expect} from 'bun:test';
import {getTestContext, authedRequest} from './setup';
import {getServerConfig} from '../lib/config/server-config';

async function getFullOrganization(sessionToken: string, orgId: string) {
    const res = await authedRequest(sessionToken,
        `/auth/organization/get-full-organization?organizationId=${orgId}`);
    return await res.json() as any;
}

describe('Organization Infrastructure', () => {
    describe('Setup creates organization', () => {
        test('server config contains orgName and orgId', async () => {
            await getTestContext();
            const config = getServerConfig();
            expect(config).not.toBeNull();
            expect(config!.orgName).toBe('Test Organization');
            expect(config!.orgId).toBeTruthy();
            expect(typeof config!.orgId).toBe('string');
        });

        test('organization exists via API', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();
            const org = await getFullOrganization(ctx.alice.user.sessionToken, config!.orgId);
            expect(org).not.toBeNull();
            expect(org.name).toBe('Test Organization');
            expect(org.slug).toBe('test-organization');
        });
    });

    describe('Admin is org owner', () => {
        test('alice (admin) is org owner', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();
            const org = await getFullOrganization(ctx.alice.user.sessionToken, config!.orgId);
            const aliceMember = org.members.find((m: any) => m.userId === ctx.alice.user.id);
            expect(aliceMember).not.toBeUndefined();
            expect(aliceMember.role).toBe('owner');
        });
    });

    describe('Auto-join org on user creation', () => {
        test('bob is auto-joined as member', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();
            const org = await getFullOrganization(ctx.alice.user.sessionToken, config!.orgId);
            const bobMember = org.members.find((m: any) => m.userId === ctx.bob.user.id);
            expect(bobMember).not.toBeUndefined();
            expect(bobMember.role).toBe('member');
        });

        test('charlie is auto-joined as member', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();
            const org = await getFullOrganization(ctx.alice.user.sessionToken, config!.orgId);
            const charlieMember = org.members.find((m: any) => m.userId === ctx.charlie.user.id);
            expect(charlieMember).not.toBeUndefined();
            expect(charlieMember.role).toBe('member');
        });
    });

    describe('Teams', () => {
        test('can create team via API', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();

            // Set active org first
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/set-active', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({organizationId: config!.orgId}),
                });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/create-team', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        name: 'Engineering',
                        organizationId: config!.orgId,
                    }),
                });
            const team = await res.json() as any;
            expect(team).not.toBeNull();
            expect(team.name).toBe('Engineering');

            // cleanup
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/remove-team', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({teamId: team.id}),
                });
        });
    });

    describe('Organization member count', () => {
        test('org has 3 members (alice + bob + charlie)', async () => {
            const ctx = await getTestContext();
            const config = getServerConfig();
            const org = await getFullOrganization(ctx.alice.user.sessionToken, config!.orgId);
            expect(org.members.length).toBe(3);
        });
    });
});
