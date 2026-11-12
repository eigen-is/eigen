// A batch copy keeps what copied when part of it fails, and says which sources failed and why, so a retry sends
// only those and nothing lands twice. Copy to… and Save to Drive also say how many items copied, and a media
// insert uses what copied. Make a copy lands beside its original as "Copy of" its name and says so.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DrivePath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const path = (id: string, parentId = 'folder'): DrivePath => ({
    id,
    name: `${id}.png`,
    mountId: 'm1',
    type: 'file',
    parentId,
    ownerId: OWNER,
    mimeType: 'image/png',
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

const TARGET = { targetOwnerId: OWNER, targetMountId: 'm1', targetParentId: 'media' };
const GOOD = path('good');
const BAD = path('bad');

// The source ids the copy route was asked for, in order, and the bodies. The source `bad` always fails.
const posted: string[] = [];
const bodies: unknown[] = [];

beforeEach(() => {
    toasts.length = 0;
    posted.length = 0;
    bodies.length = 0;
    g.fetch = async (url: string, init?: RequestInit) => {
        const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1] ?? '';
        posted.push(sourceId);
        if (sourceId === 'bad') return new Response('Server error', { status: 500 });
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return Response.json(path(`copy-of-${sourceId}`, body.targetParentId));
    };
});

// Duplicate copies each source into its own folder; the other hooks copy into the media folder.
async function copy(
    hook: 'duplicate' | 'folder' | 'media',
    sources: readonly DrivePath[],
): Promise<{ result: readonly DrivePath[] | null; error: unknown; invalidated: readonly unknown[][] }> {
    const { act } = await import('react');
    const { useCopyToFolder, useCopyToMediaFolder, useDuplicatePaths } = await import(
        '../../../../core/drive/hooks/writes'
    );
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(
        () => ({ duplicate: useDuplicatePaths(), folder: useCopyToFolder(), media: useCopyToMediaFolder(OWNER, 'm1') }),
        queryClient,
    );
    const outcome: { result: readonly DrivePath[] | null; error: unknown } = { result: null, error: null };
    await act(async () => {
        const done =
            hook === 'duplicate'
                ? latest.duplicate.mutateAsync(sources)
                : hook === 'folder'
                  ? latest.folder.mutateAsync({ items: sources, ...TARGET })
                  : latest.media.mutateAsync({ paths: sources, mediaFolderId: TARGET.targetParentId });
        await done.then(
            (result) => {
                outcome.result = result;
            },
            (error) => {
                outcome.error = error;
            },
        );
    });
    await unmount();
    return { ...outcome, invalidated };
}

describe('useDuplicatePaths', () => {
    test('a partly failed batch rejects with what copied and the sources that failed', async () => {
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        const { error } = await copy('duplicate', [GOOD, BAD]);
        expect(error).toBeInstanceOf(PartialBatchError);
        if (!(error instanceof PartialBatchError)) return;
        expect(error.succeeded.map((p) => p.id)).toEqual(['copy-of-good']);
        expect(error.failed).toEqual([BAD]);
        expect(toasts).toEqual(['error: Failed to copy 1 of 2 items: Server error (500)']);
    });

    test('the copies that landed refresh their folder and the mime listings', async () => {
        const { invalidated } = await copy('duplicate', [GOOD, BAD]);
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'folder'])).toBe(true);
        expect(hasKey(invalidated, ['drive', OWNER, 'mime'])).toBe(true);
    });

    test('a duplicate refreshes the folder of each copy', async () => {
        const sources = [path('a', 'left'), path('b', 'right')];
        const { invalidated } = await copy('duplicate', sources);
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'left'])).toBe(true);
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'right'])).toBe(true);
    });

    test('a failed copy does not stop another one into the same folder', async () => {
        const { error } = await copy('duplicate', [BAD, GOOD]);
        expect(posted).toEqual(['bad', 'good']);
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        if (!(error instanceof PartialBatchError)) throw error;
        expect(error.succeeded.map((p) => p.id)).toEqual(['copy-of-good']);
        expect(error.failed).toEqual([BAD]);
    });

    test('a retry with the failed sources posts only those', async () => {
        const first = await copy('duplicate', [GOOD, BAD]);
        posted.length = 0;
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        if (!(first.error instanceof PartialBatchError)) throw first.error;
        await copy('duplicate', first.error.failed);
        expect(posted).toEqual(['bad']);
    });

    test('a batch where nothing copied rejects with the server error', async () => {
        const { AppError } = await import('../../../../core/api-error');
        const { error } = await copy('duplicate', [BAD]);
        expect(error).toBeInstanceOf(AppError);
        expect(toasts).toEqual(['error: Server error (500)']);
    });
});

describe('useCopyToFolder', () => {
    test('a full success says how many items copied', async () => {
        const { result } = await copy('folder', [GOOD, path('other')]);
        expect(result?.length).toBe(2);
        expect(toasts).toEqual(['success: 2 items copied']);
    });

    test('a single copy says so in the singular', async () => {
        await copy('folder', [GOOD]);
        expect(toasts).toEqual(['success: 1 item copied']);
    });

    test('a partial failure shows no success toast and rejects with the failures', async () => {
        const { PartialBatchError } = await import('../../../../core/drive/hooks/writes');
        const { error } = await copy('folder', [GOOD, BAD]);
        expect(error).toBeInstanceOf(PartialBatchError);
        expect(toasts).toEqual(['error: Failed to copy 1 of 2 items: Server error (500)']);
    });
});

describe('useCopyToMediaFolder', () => {
    test('a partial failure says why and still returns the copies that landed', async () => {
        const { result, error } = await copy('media', [GOOD, BAD]);
        expect(error).toBeNull();
        expect(result?.map((p) => p.id)).toEqual(['copy-of-good']);
        expect(toasts).toEqual(['error: Failed to copy 1 of 2 items: Server error (500)']);
    });

    // A card's Save stops when its attachment did not copy.
    test('a total failure rejects with the server error', async () => {
        const { AppError } = await import('../../../../core/api-error');
        const { error } = await copy('media', [BAD]);
        expect(error).toBeInstanceOf(AppError);
        expect(toasts).toEqual(['error: Server error (500)']);
    });
});

describe('useMakeCopy', () => {
    async function makeCopy(source: DrivePath): Promise<{ result: DrivePath | null; error: unknown }> {
        const { act } = await import('react');
        const { useMakeCopy } = await import('../../../../core/drive/hooks/writes');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useMakeCopy(), queryClient);
        const outcome: { result: DrivePath | null; error: unknown } = { result: null, error: null };
        await act(async () => {
            await latest.mutateAsync(source).then(
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

    test('the copy lands in the folder of its original, named "Copy of" it, and a toast says so', async () => {
        const { result } = await makeCopy(path('plan', 'projects'));
        expect(bodies).toEqual([
            { targetOwnerId: OWNER, targetMountId: 'm1', targetParentId: 'projects', name: 'Copy of plan.png' },
        ]);
        expect(result?.id).toBe('copy-of-plan');
        expect(toasts).toEqual(['success: Copy made']);
    });

    test('a failed copy toasts the server error and no success', async () => {
        const { error } = await makeCopy(BAD);
        expect(error).not.toBeNull();
        expect(toasts).toEqual(['error: Server error (500)']);
    });
});
