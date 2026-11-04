// The one rule every comment surface reads: a card is deleted when the host no longer uses it, or when its thread is
// gone from the chat folder. Neither half may decide before it knows: the host's active set before it is ready, and
// a missing thread before the listing's refetch settled.
import { describe, expect, spyOn, test } from 'bun:test';
import type { CommentCard } from '../../../../types/comments';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the provider into.
installHappyDom();

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { driveKeys } = await import('../../../../core/drive/hooks/keys');
const { MediaResolverProvider } = await import('../../../../core/drive/media-resolver');
const { useIsCardDeleted } = await import('../../../../core/comments/hooks/use-is-card-deleted');

// The chat folder's listing as the server holds it, and a gate a test holds a refetch at until it lets it answer.
const chatFolder: { listing: { id: string; name: string }[]; gate: Promise<void> } = {
    listing: [],
    gate: Promise.resolve(),
};
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async () => {
            await chatFolder.gate;
            return Response.json(chatFolder.listing);
        },
        { preconnect: fetch.preconnect },
    ),
);

const card: CommentCard = { id: 'card-1', title: 'Check this', description: '', chatName: 'thread-1.eigenchat' };

// Mounts the predicate under a resolver whose chat folder is already listed, and reads it for `card` on every render.
// Only a name the listing lacks fetches, through the refetch that miss asks for.
async function mountPredicate(active: boolean, ready: boolean) {
    const seen: { deleted: boolean | null } = { deleted: null };
    const state = { active, ready };
    function Harness() {
        const isCardDeleted = useIsCardDeleted(new Set(state.active ? [card.id] : []), state.ready);
        seen.deleted = isCardDeleted(card);
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'chat-1'), chatFolder.listing);
    const render = () =>
        act(async () => {
            root.render(
                <QueryClientProvider client={queryClient}>
                    <MediaResolverProvider ownerId="owner-1" mountId="m1" mediaFolderId={null} chatFolderId="chat-1">
                        <Harness />
                    </MediaResolverProvider>
                </QueryClientProvider>,
            );
        });
    // Lets a queued refetch and the re-render it causes land.
    const flush = async () => {
        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };
    await render();
    await flush();
    return {
        deleted: () => seen.deleted,
        flush,
        setReady: async (next: boolean) => {
            state.ready = next;
            await render();
        },
        unmount: () => act(() => root.unmount()),
    };
}

describe('useIsCardDeleted', () => {
    test('a card the host uses, whose thread is listed, is live', async () => {
        chatFolder.listing = [{ id: 'chat-a', name: 'thread-1.eigenchat' }];
        const predicate = await mountPredicate(true, true);
        expect(predicate.deleted()).toBe(false);
        await predicate.unmount();
    });

    test('a card the ready host does not use is deleted', async () => {
        chatFolder.listing = [{ id: 'chat-a', name: 'thread-1.eigenchat' }];
        const predicate = await mountPredicate(false, true);
        expect(predicate.deleted()).toBe(true);
        await predicate.unmount();
    });

    test('before the host is ready, a card it does not use yet is not deleted', async () => {
        chatFolder.listing = [{ id: 'chat-a', name: 'thread-1.eigenchat' }];
        const predicate = await mountPredicate(false, false);
        expect(predicate.deleted()).toBe(false);
        await predicate.setReady(true);
        expect(predicate.deleted()).toBe(true);
        await predicate.unmount();
    });

    test('a used card whose thread is gone is deleted, once the refetch settled', async () => {
        chatFolder.listing = [];
        let release = () => {};
        chatFolder.gate = new Promise((resolve) => {
            release = resolve;
        });
        const predicate = await mountPredicate(true, true);
        // The refetch the miss asked for still waits at the gate.
        expect(predicate.deleted()).toBe(false);
        release();
        await predicate.flush();
        expect(predicate.deleted()).toBe(true);
        chatFolder.gate = Promise.resolve();
        await predicate.unmount();
    });
});
