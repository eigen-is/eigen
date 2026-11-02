// A batch copy keeps what copied when part of it fails, and says which sources failed and why, so a retry sends
// only those and nothing lands twice. Copy to… and Save to Drive also say how many items copied, and a media
// insert uses what copied.
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

// The source ids the copy route was asked for, in order. The source `bad` always fails.
const posted: string[] = [];

beforeEach(() => {
    toasts.length = 0;
    posted.length = 0;
    g.fetch = async (url: string, init?: RequestInit) => {
        const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1] ?? '';
        posted.push(sourceId);
        if (sourceId === 'bad') return new Response('Server error', { status: 500 });
        const body = JSON.parse(String(init?.body));
        return Response.json(path(`copy-of-${sourceId}`, body.targetParentId));
    };
});

// useCopyPaths sends each source to targetOf(source), which is the media folder unless a test says otherwise.
async function copy(
    hook: 'paths' | 'folder' | 'media',
    sources: DrivePath[],
    targetOf: (source: DrivePath) => typeof TARGET = () => TARGET,
): Promise<{ result: DrivePath[] | null; error: unknown; invalidated: readonly unknown[][] }> {
    const { act } = await import('react');
    const { useCopyPaths, useCopyToFolder, useCopyToMediaFolder } = await import('../../../../core/drive/hooks/writes');
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(
        () => ({ paths: useCopyPaths(), folder: useCopyToFolder(), media: useCopyToMediaFolder(OWNER, 'm1') }),
        queryClient,
    );
    const outcome: { result: DrivePath[] | null; error: unknown } = { result: null, error: null };
    await act(async () => {
        const done =
            hook === 'paths'
                ? latest.paths.mutateAsync(sources.map((source) => ({ source, ...targetOf(source) })))
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

describe('useCopyPaths', () => {
    test('a partly failed batch rejects with what copied and the sources that failed', async () => {
        const { PartialCopyError } = await import('../../../../core/drive/hooks/writes');
        const { error } = await copy('paths', [GOOD, BAD]);
        expect(error).toBeInstanceOf(PartialCopyError);
        if (!(error instanceof PartialCopyError)) return;
        expect(error.copied.map((p) => p.id)).toEqual(['copy-of-good']);
        expect(error.failed).toEqual([BAD]);
        expect(toasts).toEqual(['error: Failed to copy 1 of 2 items: Server error (500)']);
    });

    test('the copies that landed refresh their folder and the mime listings', async () => {
        const { invalidated } = await copy('paths', [GOOD, BAD]);
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'media'])).toBe(true);
        expect(hasKey(invalidated, ['drive', OWNER, 'mime'])).toBe(true);
    });

    test('a batch shaped like Duplicate refreshes the folder of each copy', async () => {
        const sources = [path('a', 'left'), path('b', 'right')];
        const { invalidated } = await copy('paths', sources, (source) => ({
            ...TARGET,
            targetParentId: source.parentId ?? '',
        }));
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'left'])).toBe(true);
        expect(hasKey(invalidated, ['drive', OWNER, 'folder', 'm1', 'right'])).toBe(true);
    });

    test('a retry with the failed sources posts only those', async () => {
        const first = await copy('paths', [GOOD, BAD]);
        posted.length = 0;
        const { PartialCopyError } = await import('../../../../core/drive/hooks/writes');
        if (!(first.error instanceof PartialCopyError)) throw first.error;
        await copy('paths', first.error.failed);
        expect(posted).toEqual(['bad']);
    });

    test('a batch where nothing copied rejects with the server error', async () => {
        const { AppError } = await import('../../../../core/api-error');
        const { error } = await copy('paths', [BAD]);
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
        const { PartialCopyError } = await import('../../../../core/drive/hooks/writes');
        const { error } = await copy('folder', [GOOD, BAD]);
        expect(error).toBeInstanceOf(PartialCopyError);
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
