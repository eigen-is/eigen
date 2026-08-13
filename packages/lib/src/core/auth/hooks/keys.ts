// Query-key factories for the auth domain. Kept internal (not surfaced from the domain barrel),
// matching their previous file-private scope — only the sibling hook files consume them.
export const appPasswordKeys = {
    all: ['app-passwords'] as const,
    list: (userId: string) => [...appPasswordKeys.all, userId] as const,
};

export const inviteKeys = {
    all: ['invite'] as const,
    validate: (token: string | undefined) => [...inviteKeys.all, 'validate', token] as const,
};
