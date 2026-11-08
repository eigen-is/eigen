import { describe, expect, test } from 'bun:test';
import { getServerConfig } from '../../lib/config/server-config';
import { getOrgRole } from '../../lib/user';
import { authedRequest, createTestUser, ensureServer, getTestContext } from '../setup';

// Eigen has one org, and no app code leaves or deletes it.
describe("better-auth's ways out of the org", () => {
    function call(sessionToken: string, path: string): Promise<Response> {
        return authedRequest(sessionToken, `/auth/organization/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: getServerConfig()?.orgId }),
        });
    }

    test('leaving is closed', async () => {
        await ensureServer();
        const member = await createTestUser(`leave-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Leave');

        const res = await call(member.sessionToken, 'leave');

        expect(res.status).toBe(404);
        expect(await getOrgRole(member.id)).toBe('member');
    });

    test('deleting is closed, even for the owner', async () => {
        const { alice } = await getTestContext();

        const res = await call(alice.user.sessionToken, 'delete');

        expect(res.status).toBe(404);
        expect(await getOrgRole(alice.user.id)).toBe('owner');
    });
});
