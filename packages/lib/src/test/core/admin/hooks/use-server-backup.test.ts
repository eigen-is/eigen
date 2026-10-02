import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { BackupJob } from '@workspace/lib/types/backup';
import { orgOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { backupKeys, invalidateServerBackup, serverBackupKeys } from '../../../../core/admin/hooks/keys';
import { handleAdminSSEvent } from '../../../../core/admin/sse-handlers';
import { publicKeys } from '../../../../core/public/hooks/keys';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

// The queries read `useIsGuest`, which reads the auth context; there is no provider here.
const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: 'owner-1', role: 'admin' } }),
}));

// The Eden client, stubbed to the one call this file drives, and restored for later files. Recipe: use-backup.test.
const realApiModule = await import('../../../../core/api');
const startCalls: unknown[] = [];
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    serverBackupApi: {
        post: async (body: unknown) => {
            startCalls.push(body);
            return { data: { jobId: 'job-7' }, error: null, status: 200 };
        },
    },
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const ORG_ID = 'o'.repeat(32);
const SERVER_OWNER = orgOwnerId(ORG_ID);
const USER_OWNER = 'u'.repeat(32);
const NAME = 'server-scheduled-full-20260930-020000.tar';

function trackingClient(): { queryClient: QueryClient; invalidated: readonly unknown[][] } {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) invalidated.push([...filters.queryKey]);
        return original(filters as never);
    };
    // The org id the server jobs are listed under comes from the public config, seeded so nothing fetches it.
    queryClient.setQueryData(publicKeys.config, { orgId: ORG_ID });
    return { queryClient, invalidated };
}

async function renderHook<T>(use: () => T, queryClient: QueryClient): Promise<{ latest: T; unmount: () => void }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    return { latest: seen.latest as T, unmount: () => root.unmount() };
}

describe('invalidateServerBackup', () => {
    test('refetches the archive list and the org jobs', () => {
        const { queryClient, invalidated } = trackingClient();

        invalidateServerBackup(queryClient, SERVER_OWNER);

        expect(invalidated).toEqual([[...serverBackupKeys.archives()], [...backupKeys.jobs(SERVER_OWNER)]]);
    });
});

describe('handleAdminSSEvent', () => {
    // An upload rewrites its archive's record while it runs, and the list shows the record.
    test("a server job's poke refetches the org jobs and the archive list", () => {
        const { queryClient, invalidated } = trackingClient();

        handleAdminSSEvent(
            { type: SSEventType.BACKUP_JOB_UPDATED, jobId: 'job-1', ownerId: SERVER_OWNER },
            queryClient,
        );

        expect(invalidated).toContainEqual([...backupKeys.jobs(SERVER_OWNER)]);
        expect(invalidated).toContainEqual([...serverBackupKeys.archives()]);
    });

    test("a home job's poke leaves the server archive list alone", () => {
        const { queryClient, invalidated } = trackingClient();

        handleAdminSSEvent({ type: SSEventType.BACKUP_JOB_UPDATED, jobId: 'job-2', ownerId: USER_OWNER }, queryClient);

        expect(invalidated).toContainEqual([...backupKeys.jobs(USER_OWNER)]);
        expect(invalidated).not.toContainEqual([...serverBackupKeys.archives()]);
    });
});

function serverJob(state: BackupJob['state']): BackupJob {
    return {
        id: 'job-1',
        kind: 'server-backup',
        ownerId: SERVER_OWNER,
        state,
        progress: { step: 'home 1 of 2', done: 0, total: 0 },
        artifact: NAME,
        startedAt: new Date(),
    };
}

describe('useServerBackupJobs', () => {
    test('refetches the archive list the moment a server job leaves running', async () => {
        const { act } = await import('react');
        const { useServerBackupJobs } = await import('../../../../core/admin/hooks/use-server-backup');
        const { queryClient, invalidated } = trackingClient();
        queryClient.setQueryData(backupKeys.jobs(SERVER_OWNER), [serverJob('running')]);
        const { unmount } = await renderHook(() => useServerBackupJobs(), queryClient);

        expect(invalidated).toEqual([]);
        await act(async () => {
            queryClient.setQueryData(backupKeys.jobs(SERVER_OWNER), [serverJob('done')]);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(invalidated).toEqual([[...serverBackupKeys.archives()]]);
        await act(() => unmount());
    });
});

describe('useStartServerBackup', () => {
    test('posts the level and refetches the archives and the org jobs', async () => {
        const { act } = await import('react');
        const { useStartServerBackup } = await import('../../../../core/admin/hooks/use-server-backup');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useStartServerBackup(), queryClient);

        await act(async () => {
            await latest.mutateAsync('light');
        });

        expect(startCalls).toEqual([{ level: 'light' }]);
        expect(invalidated).toEqual([[...serverBackupKeys.archives()], [...backupKeys.jobs(SERVER_OWNER)]]);
        await act(() => unmount());
    });
});
