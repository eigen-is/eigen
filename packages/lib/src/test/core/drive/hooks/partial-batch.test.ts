// A batch move, delete or permanent delete sends one request per item. When the server refuses some, the rest
// still go through, the error names the ones that failed and why, and a retry with those sends only them. When
// every item fails, the server's own error comes back.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DrivePath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const path = (id: string): DrivePath => ({
    id,
    name: `${id}.txt`,
    mountId: 'm1',
    type: 'file',
    parentId: 'folder',
    ownerId: OWNER,
    mimeType: 'text/plain',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

const A = path('a');
const B = path('b');
const BAD = path('bad');

// The path ids each request named, in order. The server refuses `bad`.
const sent: string[] = [];

beforeEach(() => {
    toasts.length = 0;
    sent.length = 0;
    g.fetch = async (url: string) => {
        const id = /\/(?:path|trash)\/([^/]+)/.exec(url)?.[1] ?? '';
        sent.push(id);
        if (id === 'bad') return new Response('No access', { status: 403 });
        return Response.json(path(id));
    };
});

type Hooks = {
    move: (paths: readonly DrivePath[]) => Promise<unknown>;
    trash: (paths: readonly DrivePath[]) => Promise<unknown>;
    destroy: (paths: readonly DrivePath[]) => Promise<unknown>;
};

async function run(hook: keyof Hooks, paths: readonly DrivePath[]): Promise<{ result: unknown; error: unknown }> {
    const { act } = await import('react');
    const { useDeletePaths, useMovePaths } = await import('../../../../core/drive/hooks/writes');
    const { usePermanentlyDelete } = await import('../../../../core/drive/hooks/trash');
    const { queryClient } = trackingClient();
    const { latest, unmount } = await renderHook((): Hooks => {
        const move = useMovePaths(OWNER, 'm1', 'folder');
        const trash = useDeletePaths();
        const destroy = usePermanentlyDelete(OWNER, 'm1');
        return {
            move: (items) => move.mutateAsync({ paths: items, targetParentId: 'elsewhere' }),
            trash: (items) => trash.mutateAsync(items),
            destroy: (items) => destroy.mutateAsync(items),
        };
    }, queryClient);
    const outcome: { result: unknown; error: unknown } = { result: null, error: null };
    await act(async () => {
        await latest[hook](paths).then(
            (result) => {
                outcome.result = result;
            },
            (error) => {
                outcome.error = error;
            },
        );
    });
    await unmount();
    return outcome;
}

describe.each([
    ['move', 'move'],
    ['trash', 'delete'],
    ['destroy', 'permanently delete'],
] as const)('%s', (hook, verb) => {
    test('a refused item does not stop the others, and the error names it', async () => {
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        const { error } = await run(hook, [A, BAD, B]);
        expect(sent).toEqual(['a', 'bad', 'b']);
        expect(error).toBeInstanceOf(PartialBatchError);
        if (!(error instanceof PartialBatchError)) return;
        expect(error.succeeded.map((p) => p.id)).toEqual(['a', 'b']);
        expect(error.failed).toEqual([BAD]);
        expect(toasts).toEqual([`error: Failed to ${verb} 1 of 3 items: No access (403)`]);
    });

    test('a retry with the failed items sends only those', async () => {
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        const first = await run(hook, [A, BAD, B]);
        if (!(first.error instanceof PartialBatchError)) throw first.error;
        sent.length = 0;
        await run(hook, first.error.failed);
        expect(sent).toEqual(['bad']);
    });

    test('a batch where every item failed rejects with the server error', async () => {
        const { AppError } = await import('../../../../core/api-error');
        const { error } = await run(hook, [BAD]);
        expect(error).toBeInstanceOf(AppError);
        expect(toasts).toEqual(['error: No access (403)']);
    });

    test('a batch that went through resolves with its items', async () => {
        const { result } = await run(hook, [A, B]);
        expect(Array.isArray(result) && result.map((p: DrivePath) => p.id)).toEqual(['a', 'b']);
        expect(toasts).toEqual([]);
    });
});
