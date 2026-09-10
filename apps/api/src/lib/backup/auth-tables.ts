import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { account, apikey, member, organization, team, teamMember, twoFactor, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';

// A users3.db table one user's archive carries: the key it has in auth.json, the column that scopes
// its rows to that user, and — for a membership — the row it would be an orphan without.
export type AuthTableSpec = {
    key: string;
    table: SQLiteTable;
    owner: SQLiteColumn;
    parent?: { table: SQLiteTable; id: SQLiteColumn; column: string };
};

// One list for both directions, in insert order (the user row first, then the rows that reference
// it), so a table added here is archived AND restored. Sessions and verification rows are
// deliberately absent: a restore re-inserts identity, it does not hand out logins. Every column of
// the rest rides along, so the insert on restore is complete.
export const AUTH_TABLES: AuthTableSpec[] = [
    { key: 'user', table: user, owner: user.id },
    { key: 'account', table: account, owner: account.userId },
    { key: 'two_factor', table: twoFactor, owner: twoFactor.userId },
    { key: 'apikey', table: apikey, owner: apikey.referenceId },
    {
        key: 'member',
        table: member,
        owner: member.userId,
        parent: { table: organization, id: organization.id, column: 'organizationId' },
    },
    {
        key: 'team_member',
        table: teamMember,
        owner: teamMember.userId,
        parent: { table: team, id: team.id, column: 'teamId' },
    },
];

// The key auth.json spells the owner column under: a Drizzle select keys its rows by the schema's
// property name, not by the SQL column name, and a restore filters the archive's rows on that key.
export function ownerKeyOf(spec: AuthTableSpec): string {
    const found = Object.entries(getTableColumns(spec.table)).find(([, column]) => column === spec.owner);
    if (!found) throw new Error(`${spec.key}: its owner column is not one of its own`);
    return found[0];
}

// What a restored identity comes back as, whatever the archive says. `user.role` is better-auth's
// own admin flag and a `member` row of the default org is what requireAdmin reads, so neither is
// carried in from a file an admin uploaded: a restore puts a home's data back, it never hands out
// privilege. An admin who was one before their restore is made one again by hand.
export const RESTORED_USER_ROLE = 'user';
export const RESTORED_MEMBER_ROLE = 'member';

// The rows auth.json holds for one user, keyed the way the file spells them.
export function readAuthRows(userId: string): Record<string, unknown[]> {
    const db = getAuthDrizzleDb();
    const rows: Record<string, unknown[]> = {};
    for (const spec of AUTH_TABLES) {
        rows[spec.key] = db.select().from(spec.table).where(eq(spec.owner, userId)).all();
    }
    return rows;
}
