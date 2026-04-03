export type OrgMember = {
    id: string;
    userId: string;
    role: string;
    email: string;
    name: string;
    image?: string | null;
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
