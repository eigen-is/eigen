export type WaitlistEntry = {
    id: string;
    email: string;
    notes: string;
    status: string;
    inviteToken: string | null;
    inviteExpiresAt: Date | null;
    invitedAt: Date | null;
    registeredAt: Date | null;
    userId: string | null;
    createdAt: Date;
    updatedAt: Date;
};
