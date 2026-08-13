export const collabKeys = {
    all: ['collab'] as const,
    info: () => [...collabKeys.all, 'info'] as const,
    document: (ownerId: string, mountId: string, pathId: string) =>
        [...collabKeys.info(), ownerId, mountId, pathId] as const,
};
