export type OrgRole = 'owner' | 'admin' | 'member';

export type AdminUserRow = {
    id: string;
    name: string;
    email: string;
    memberId: string | null; // member-table row id — the role mutation needs it; null = orphan
    role: OrgRole | null; // null = orphan (no organization)
    createdAt: Date;
    lastActiveAt: Date | null; // max(lastLoginAt, MAX(session.updatedAt)); null = pre-migration, never seen
    teams: string[]; // team names
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
