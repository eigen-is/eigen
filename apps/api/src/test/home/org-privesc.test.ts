import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { requireAdmin } from '../../lib/core/access';
import { getOrgRole } from '../../lib/user';
import { authedRequest, getTestContext } from '../setup';

// Mirrors setup.ts's extractSessionToken so this file stays self-contained (do not edit setup.ts).
function extractSessionToken(headers: Headers): string {
    const setCookie = headers.get('set-cookie') || '';
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`Session token not found in set-cookie header: ${setCookie}`);
    return match[1];
}

describe('Org role privilege escalation: requireAdmin is scoped to the default org', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let defaultOrgId: string;
    let attackerId: string;
    let attackerToken: string;
    let secondOrgId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        if (!config) throw new Error('server config not set');
        defaultOrgId = config.orgId;

        // Throwaway attacker: a normal user, auto-joined to the default org as 'member'.
        const email = `attacker-${randomUUID()}@test.eigen.is`;
        const password = 'testpassword123';
        const signUp = await auth.api.signUpEmail({ body: { email, password, name: 'Attacker' } });
        attackerId = signUp.user.id;

        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        attackerToken = extractSessionToken(signIn.headers);

        // Make the attacker the OWNER of a self-created second org via the system-action bypass
        // (userId + no session — the path setup uses), reproducing the exploit precondition even
        // though allowUserToCreateOrganization:false blocks the session-bearing route.
        const org2 = await auth.api.createOrganization({
            body: { name: 'Attacker Org', slug: `attacker-${randomUUID()}`, userId: attackerId },
        });
        if (!org2) throw new Error('failed to create second org');
        secondOrgId = org2.id;
    });

    test('a normal member cannot create an organization', async () => {
        // allowUserToCreateOrganization:false — better-auth rejects the session-bearing create.
        const res = await authedRequest(ctx.bob.user.sessionToken, '/auth/organization/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Bob Org', slug: `bob-${randomUUID()}` }),
        });
        expect(res.status).toBe(403);
    });

    test('a self-created owner membership does not grant instance admin', async () => {
        // Precondition — the attacker really is 'owner' of their second org; else the test is vacuous.
        const secondOrgRole = getAuthDrizzleDb()
            .select({ role: memberSchema.role })
            .from(memberSchema)
            .where(and(eq(memberSchema.userId, attackerId), eq(memberSchema.organizationId, secondOrgId)))
            .get();
        expect(secondOrgRole?.role).toBe('owner');

        // getOrgRole is scoped to the default org, so the second-org 'owner' role is ignored.
        const role = await getOrgRole(attackerId);
        expect(role).not.toBe('owner');
        expect(role).not.toBe('admin');

        await expect(requireAdmin(attackerId)).rejects.toThrow();

        const res = await authedRequest(attackerToken, '/settings/server');
        expect(res.status).toBe(403);
    });

    test('after leaving the default org, still not admin', async () => {
        // Simulate the exploit's "leave the default org" step by removing the default-org member row.
        getAuthDrizzleDb()
            .delete(memberSchema)
            .where(and(eq(memberSchema.userId, attackerId), eq(memberSchema.organizationId, defaultOrgId)))
            .run();

        expect(await getOrgRole(attackerId)).toBeNull();
        await expect(requireAdmin(attackerId)).rejects.toThrow();

        const res = await authedRequest(attackerToken, '/settings/server');
        expect(res.status).toBe(403);
    });
});
