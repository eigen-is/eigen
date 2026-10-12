// What a renderer reads to swap its loader for the missing look: a name that cannot resolve reads missing,
// one still uploading in this tab never does.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
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
