export type WaitlistEntry = {
    id: string;
    email: string;
    notes: string;
    status: 'pending' | 'invited' | 'registered' | 'rejected';
    createdAt: string | Date;
    invitedAt?: string | Date | null;
    registeredAt?: string | Date | null;
    inviteExpiresAt?: string | Date | null;
    userId?: string | null;
};
