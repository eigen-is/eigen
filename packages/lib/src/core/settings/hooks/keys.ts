import type { QueryClient } from '@tanstack/react-query';

export const settingsKeys = {
    all: ['settings'] as const,
    server: () => [...settingsKeys.all, 'server'] as const,
};

// Not surfaced from the domain barrel (see hooks/index.ts) — only the sibling hook file consumes it.
export const s3ConfigKeys = {
    all: [...settingsKeys.all, 's3config'] as const,
};

export function invalidateServerSettings(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: settingsKeys.server() });
}

export function invalidateServerS3Config(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: s3ConfigKeys.all });
}
