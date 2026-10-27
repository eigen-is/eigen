// The accounts a demo visitor can be signed in as, read from the org's members so the list cannot drift from the
// seeder. A demo entry picks one at random.

import { and, eq, isNull, or } from 'drizzle-orm';
import { member, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from './auth';

// Plain members only, so the setup admin, the org owner, stays out of a visitor's reach. A member with 2FA is left
// out too, because signInEmail would send it into the 2FA step without a cookie.
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
