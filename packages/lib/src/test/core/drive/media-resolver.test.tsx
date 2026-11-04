// What a renderer reads to swap its loader for the missing look: a name that cannot resolve reads missing,
// one still uploading in this tab never does. A comment thread reads missing the same way. And which URL a small
// copy of a picture draws.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { driveKeys } from '../../../core/drive/hooks/keys';
import type { DrivePath } from '../../../types/drive';
import { installHappyDom } from '../../happy-dom';
import { renderHook } from '../../render-hook';

// react-dom needs a DOM to render the provider into.
installHappyDom();

const { MediaResolverProvider, PENDING_PREFIX, useMediaResolver } = await import('../../../core/drive/media-resolver');

// A document without a media folder: nothing it names can resolve, and nothing is fetched.
async function resolverWithoutMediaFolder() {
    return renderHook(useMediaResolver, new QueryClient(), (children) => (
        <MediaResolverProvider ownerId="owner-1" mountId="m1" mediaFolderId={null} chatFolderId={null}>
            {children}
        </MediaResolverProvider>
    ));
}

describe('isMediaMissing', () => {
    test('a document with no media folder reads every stored name missing', async () => {
        const { latest, unmount } = await resolverWithoutMediaFolder();
        expect(latest.isMediaMissing('photo.png')).toBe(true);
        await unmount();
    });

    test('an upload still pending in this tab never reads missing', async () => {
        const { latest, unmount } = await resolverWithoutMediaFolder();
        expect(latest.isMediaMissing(`${PENDING_PREFIX}upload-1`)).toBe(false);
        await unmount();
    });
});

describe('isChatMissing', () => {
    test('a document with no chat folder reads every thread missing', async () => {
        const { latest, unmount } = await resolverWithoutMediaFolder();
        expect(latest.isChatMissing('thread-1.eigenchat')).toBe(true);
        await unmount();
    });

    test('a thread the listing holds never reads missing', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
        queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'chat-1'), [
            mediaFile({ id: 'chat-a', name: 'thread-1.eigenchat', parentId: 'chat-1' }),
        ]);
        const { latest, unmount } = await renderHook(useMediaResolver, queryClient, (children) => (
            <MediaResolverProvider ownerId="owner-1" mountId="m1" mediaFolderId={null} chatFolderId="chat-1">
                {children}
            </MediaResolverProvider>
        ));
        expect(latest.resolveChatId('thread-1.eigenchat')).toBe('chat-a');
        expect(latest.isChatMissing('thread-1.eigenchat')).toBe(false);
        await unmount();
    });
});

function mediaFile(over: Partial<DrivePath> & Pick<DrivePath, 'id' | 'name'>): DrivePath {
    return {
        mountId: 'm1',
        type: 'file',
        parentId: 'media-1',
        ownerId: 'owner-1',
        mimeType: 'image/gif',
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
        ...over,
    };
}

// A document whose media folder is already listed, so nothing is fetched.
async function resolverOver(files: DrivePath[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
    queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'media-1'), files);
    return renderHook(useMediaResolver, queryClient, (children) => (
        <MediaResolverProvider ownerId="owner-1" mountId="m1" mediaFolderId="media-1" chatFolderId={null}>
            {children}
        </MediaResolverProvider>
    ));
}

describe('resolveMediaThumbnailUrl', () => {
    test('a picture with a thumbnail draws its still thumbnail', async () => {
        const { latest, unmount } = await resolverOver([
            mediaFile({ id: 'gif-1', name: 'party.gif', thumbnail: 'gif-1.webp' }),
        ]);
        expect(latest.resolveMediaThumbnailUrl('party.gif')).toContain('/drive/owner-1/m1/thumb/gif-1.webp');
        await unmount();
    });

    test('a picture without one yet draws its preview', async () => {
        const { latest, unmount } = await resolverOver([mediaFile({ id: 'gif-1', name: 'party.gif' })]);
        expect(latest.resolveMediaThumbnailUrl('party.gif')).toBe(latest.resolveMediaUrl('party.gif'));
        expect(latest.resolveMediaThumbnailUrl('party.gif')).toContain('/file/gif-1/preview');
        await unmount();
    });
});
