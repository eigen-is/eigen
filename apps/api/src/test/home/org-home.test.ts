import { beforeAll, describe, expect, test } from 'bun:test';
import { orgOwnerId } from '@workspace/lib/types';
import { organization } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getHome } from '../../lib/home/get-home';
import { getOrgExists } from '../../lib/org/org';
import { getTestContext } from '../setup';

describe('OrgHome', () => {
    let orgId: string;

    beforeAll(async () => {
        await getTestContext();
        const db = getAuthDrizzleDb();
        const org = db.select({ id: organization.id }).from(organization).get();
        if (!org) throw new Error('No organization found in test DB');
        orgId = org.id;
    });

    test('getOrgExists returns true for existing org', async () => {
        expect(await getOrgExists(orgId)).toBe(true);
    });

    test('getOrgExists returns false for nonexistent org', async () => {
        expect(await getOrgExists('00000000000000000000000000000000')).toBe(false);
    });

    test('getHome resolves for org ownerId', async () => {
        const home = await getHome(orgOwnerId(orgId));
        expect(home).toBeDefined();
        expect(home.user.id).toBe(orgOwnerId(orgId));
    });

    test('getHome throws 404 for nonexistent org', async () => {
        try {
            await getHome(orgOwnerId('00000000000000000000000000000000'));
            expect(true).toBe(false);
        } catch (e) {
            expect((e as { status: number }).status).toBe(404);
        }
    });
});
