import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { BACKUP_UPLOAD_MAX_BYTES } from '@workspace/lib/constants/backup';
import { SSEventType } from '@workspace/lib/types/sse';
import { backupKeys, invalidateBackup } from '../../../../core/admin/hooks/keys';
import { handleAdminSSEvent } from '../../../../core/admin/sse-handlers';

// react-dom needs a DOM to render the upload hook into; the globals are removed again in afterAll so
// later test files see the plain bun environment. Recipe: the use-members test.
const { Window } = await import('happy-dom');
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

// Record every queryKey passed to invalidateQueries so we can assert which caches a call touches.
function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    };
    return { queryClient, invalidated };
}

const OWNER = 'a1b2c3d4';
const TEAM_OWNER = 'team_t1';

describe('backupKeys', () => {
    test('scopes both lists by ownerId so switching admin rows never serves another home', () => {
        expect(backupKeys.artifacts(OWNER)).toEqual(['backup', OWNER, 'artifacts']);
        expect(backupKeys.jobs(OWNER)).toEqual(['backup', OWNER, 'jobs']);
        expect(backupKeys.artifacts(TEAM_OWNER)).not.toEqual(backupKeys.artifacts(OWNER));
        expect(backupKeys.jobs(TEAM_OWNER)).not.toEqual(backupKeys.jobs(OWNER));
    });
});

describe('invalidateBackup', () => {
    test('invalidates exactly the artifacts and jobs keys of one home', () => {
        const { queryClient, invalidated } = trackingClient();

        invalidateBackup(queryClient, OWNER);

        expect(invalidated).toEqual([[...backupKeys.artifacts(OWNER)], [...backupKeys.jobs(OWNER)]]);
    });
});

describe('handleAdminSSEvent', () => {
    test('refetches the poked home on backup:job-updated — the event carries no state of its own', () => {
        const { queryClient, invalidated } = trackingClient();

        const handled = handleAdminSSEvent(
            { type: SSEventType.BACKUP_JOB_UPDATED, jobId: 'job-1', ownerId: OWNER },
            queryClient,
        );

        expect(handled).toBe(true);
        expect(invalidated).toEqual([[...backupKeys.artifacts(OWNER)], [...backupKeys.jobs(OWNER)]]);
    });

    test('ignores events of other domains', () => {
        const { queryClient, invalidated } = trackingClient();

        const handled = handleAdminSSEvent(
            {
                type: SSEventType.DRIVE_FILE_UPLOADED,
                path: { ownerId: OWNER, mountId: 'm1', id: 'p1', parentId: 'root', mimeType: 'image/png' },
            },
            queryClient,
        );

        expect(handled).toBe(false);
        expect(invalidated).toEqual([]);
    });
});

describe('useUploadBackup', () => {
    test('refuses an archive over the upload limit before touching the network', async () => {
        const { act, createElement } = await import('react');
        const { createRoot } = await import('react-dom/client');
        const { QueryClientProvider } = await import('@tanstack/react-query');
        const { useUploadBackup } = await import('../../../../core/admin/hooks/use-backup');

        type Result = ReturnType<typeof useUploadBackup>;
        const seen: { latest: Result | null } = { latest: null };
        function Harness() {
            seen.latest = useUploadBackup(OWNER);
            return null;
        }

        const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
        const container = window.document.createElement('div');
        const root = createRoot(container as unknown as Element);
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
        });

        const file = new File(['x'], `home-${OWNER}-20260909-120000.tar.zst`);
        // A 1 GB+ File is declared, not allocated — only its size matters to the guard.
        Object.defineProperty(file, 'size', { value: BACKUP_UPLOAD_MAX_BYTES + 1 });

        let message = '';
        await act(async () => {
            await seen.latest?.mutateAsync(file).catch((error: unknown) => {
                message = error instanceof Error ? error.message : String(error);
            });
        });

        expect(message).toBe(
            "Archives over 1 GB must be copied into the server's backups folder (EIGEN_BACKUPS_DIR) by hand",
        );
        await act(() => root.unmount());
    });
});
