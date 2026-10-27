// The shapes the Admin app works with: a row of its users and guests lists, and an organization's
// members and teams. The API builds them and the admin hooks hand them to the pages.

export type OrgRole = 'owner' | 'admin' | 'member';

export type AdminUserRow = {
    id: string;
    name: string;
    email: string;
    memberId: string | null; // member-table row id — the role mutation needs it; null = orphan
    role: OrgRole | null; // null = orphan (no organization)
    createdAt: Date;
    lastActiveAt: Date | null; // max(lastLoginAt, MAX(session.updatedAt)); null = pre-migration, never seen
    teams: Pick<OrgTeam, 'id' | 'name'>[]; // the org's teams the user is a member of
};

export type OrgMember = {
    id: string;
    userId: string;
    role: string;
    email: string;
    name: string;
    createdAt: Date;
};

export type OrgTeam = {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt?: Date;
};

export type FullOrganization = {
    name: string;
    slug: string;
    members: OrgMember[];
    teams: OrgTeam[];
};
