import { and, eq, isNull, or } from 'drizzle-orm';
import { member, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from './auth';

// The demo visitor pool, discovered from org membership so it can't drift from the seeder.
// role='member' excludes the setup admin (org 'owner'), keeping the admin surface out of a
// visitor's reach. 2FA-enabled members are excluded: signInEmail would divert them into the 2FA
// flow with no cookie. Exported so the demo-mode tests assert against THE query the route uses.
export function getDemoPersonaPool(orgId: string): { id: string; email: string }[] {
    return getAuthDrizzleDb()
        .select({ id: user.id, email: user.email })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(
            and(
                eq(member.organizationId, orgId),
                eq(member.role, 'member'),
                or(isNull(user.twoFactorEnabled), eq(user.twoFactorEnabled, false)),
            ),
        )
        .all();
}
