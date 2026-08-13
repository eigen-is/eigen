// Not surfaced from the domain barrel (see ../index.ts) — only the sibling hook file consumes it.
export const publicKeys = {
    config: ['publicConfig'] as const,
};

export const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};
