import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { BACKUP_UPLOAD_MAX_BYTES, BACKUP_UPLOAD_MAX_LABEL } from '@workspace/lib/constants/backup';
import type { BackupJob } from '@workspace/lib/types/backup';
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

// The queries below read `useIsGuest`, which reads the auth context; there is no provider here.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: 'admin-1', role: 'admin' } }),
}));

// The Eden client, stubbed to the two calls this file drives. Mocked before the hooks are imported,
// and restored in afterAll so later files see the real client. Recipe: the use-members test.
const realApiModule = await import('../../../../core/api');
const safetyCalls: { ownerId: string; name: string }[] = [];
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    backupApi: {
        safety: (ownerParam: { ownerId: string }) => (nameParam: { name: string }) => ({
            restore: {
                post: async () => {
                    safetyCalls.push({ ownerId: ownerParam.ownerId, name: nameParam.name });
                    return { data: { jobId: 'job-9' }, error: null, status: 200 };
                },
            },
        }),
    },
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
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

// One React root for every hook that has to be rendered to be observed.
async function renderHook<T>(use: () => T, queryClient: QueryClient): Promise<{ latest: T; unmount: () => void }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const container = window.document.createElement('div');
    const root = createRoot(container as unknown as Element);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    return { latest: seen.latest as T, unmount: () => root.unmount() };
}

function runningJob(ownerId: string): BackupJob {
    return {
        id: 'job-1',
        kind: 'restore',
        ownerId,
        startedBy: 'admin-1',
        state: 'running',
        progress: { step: 'extract', done: 1, total: 4 },
        startedAt: new Date(),
    };
}

async function uploadRefusal(file: File): Promise<string> {
    const { act } = await import('react');
    const { useUploadBackup } = await import('../../../../core/admin/hooks/use-backup');
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { latest, unmount } = await renderHook(() => useUploadBackup(), queryClient);

    let message = '';
    await act(async () => {
        await latest.mutateAsync(file).catch((error: unknown) => {
            message = error instanceof Error ? error.message : String(error);
        });
    });
    await act(() => unmount());
    return message;
}

describe('useUploadBackup', () => {
    test('refuses an archive over the upload limit before touching the network', async () => {
        const file = new File(['x'], `home-${OWNER}-20260909-120000.tar.zst`);
        // A 1 GB+ File is declared, not allocated — only its size matters to the guard.
        Object.defineProperty(file, 'size', { value: BACKUP_UPLOAD_MAX_BYTES + 1 });

        expect(await uploadRefusal(file)).toBe(
            `Archives over ${BACKUP_UPLOAD_MAX_LABEL} must be copied into the server's backups folder (EIGEN_BACKUPS_DIR) by hand`,
        );
    });

    test('refuses an empty file with a message about what is wrong with it', async () => {
        // Zero bytes fail the route's Content-Length check, which answers with the 413 about the
        // 1 GB maximum — an answer that would send the admin looking in the wrong direction.
        const name = `home-${OWNER}-20260909-120000.tar.zst`;
        expect(await uploadRefusal(new File([], name))).toBe(`'${name}' is empty`);
    });

    test('refuses a file that is not named like an artifact, by the same grammar the route uses', async () => {
        // Right extension, no timestamp: the route would answer 400, so the browser answers first.
        expect(await uploadRefusal(new File(['x'], 'my-backup.tar.zst'))).toBe(
            "'my-backup.tar.zst' is not the name of an Eigen backup archive",
        );
        expect(await uploadRefusal(new File(['x'], `home-${OWNER}-20260909-120000.tar.gz`))).toBe(
            `'home-${OWNER}-20260909-120000.tar.gz' is not the name of an Eigen backup archive`,
        );
    });
});

describe('useBackupArtifacts', () => {
    test("polls while a job of this home runs, so a restore's new safety copy appears without a poke", async () => {
        const { useBackupArtifacts } = await import('../../../../core/admin/hooks/use-backup');
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const { unmount } = await renderHook(() => useBackupArtifacts(OWNER), queryClient);

        const query = queryClient.getQueryCache().find({ queryKey: backupKeys.artifacts(OWNER) });
        const interval = query?.observers[0]?.options.refetchInterval;
        if (typeof interval !== 'function') throw new Error('the artifacts query must poll conditionally');

        expect(interval(query!)).toBe(false);
        queryClient.setQueryData(backupKeys.jobs(OWNER), [runningJob(OWNER)]);
        expect(interval(query!)).toBe(2000);
        // Another home's running job is another pane's business.
        queryClient.setQueryData(backupKeys.jobs(OWNER), []);
        queryClient.setQueryData(backupKeys.jobs(TEAM_OWNER), [runningJob(TEAM_OWNER)]);
        expect(interval(query!)).toBe(false);

        const { act } = await import('react');
        await act(() => unmount());
    });
});

describe('useBackupJobs', () => {
    test('refetches the artifact list the moment a job leaves running', async () => {
        const { act } = await import('react');
        const { useBackupJobs } = await import('../../../../core/admin/hooks/use-backup');
        const { queryClient, invalidated } = trackingClient();
        // Seeded before the render and inside staleTime, so the query serves it without a fetch.
        queryClient.setQueryData(backupKeys.jobs(OWNER), [runningJob(OWNER)]);
        const { unmount } = await renderHook(() => useBackupJobs(OWNER), queryClient);

        expect(invalidated).toEqual([]);
        // The artifact list's own poll clears on this same change, so nothing else would refetch it
        // and the artifact the job just wrote would sit there unlisted.
        await act(async () => {
            queryClient.setQueryData(backupKeys.jobs(OWNER), [
                { ...runningJob(OWNER), state: 'done' as const, finishedAt: new Date() },
            ]);
            // The observer notifies on a scheduled batch, so the effect runs a tick later.
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(invalidated).toEqual([[...backupKeys.artifacts(OWNER)]]);
        await act(() => unmount());
    });
});

describe('useRestoreSafetyCopy', () => {
    test('posts to the copy of this home and invalidates both of its lists', async () => {
        const { act } = await import('react');
        const { useRestoreSafetyCopy } = await import('../../../../core/admin/hooks/use-backup');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useRestoreSafetyCopy(OWNER), queryClient);

        const copy = `home-${OWNER}.pre-restore-20260909-120000`;
        await act(async () => {
            await latest.mutateAsync(copy);
        });

        expect(safetyCalls).toEqual([{ ownerId: OWNER, name: copy }]);
        expect(invalidated).toEqual([[...backupKeys.artifacts(OWNER)], [...backupKeys.jobs(OWNER)]]);
        await act(() => unmount());
    });
});
