export type AdminUser = {
    id: string;
    email: string;
    name: string;
    role: string | null;
    createdAt: Date;
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
