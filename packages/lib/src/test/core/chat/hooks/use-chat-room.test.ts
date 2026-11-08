// A send clears the drive attachments waiting beside the composer at once. Pinned here: a post that fails puts them
// back and still rejects, so the composer restores its own text, and a post that succeeds leaves them gone.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { DrivePath } from '../../../../types/drive';
import { DRIVE_MIME_DOC } from '../../../../types/drive';
import { toAttachmentReference } from '../../../../types/drive-reference';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));
const realSonnerModule = { ...(await import('sonner')) };
const toasts: string[] = [];
mock.module('sonner', () => ({ toast: { error: (message: string) => toasts.push(message) } }));
afterAll(() => {
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('sonner', () => realSonnerModule);
});

const { act } = await import('react');
const { driveKeys } = await import('../../../../core/drive/hooks/keys');
const { useChatRoom } = await import('../../../../core/chat/hooks/use-chat-room');

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
    toasts.length = 0;
});

function path(over: Partial<DrivePath> & Pick<DrivePath, 'id' | 'name' | 'type' | 'mimeType'>): DrivePath {
    return {
        mountId: 'm1',
        parentId: 'chat-1',
        ownerId: 'owner-1',
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
const media = path({ id: 'media-1', name: 'media', type: 'folder', mimeType: '' });
const doc = path({ id: 'doc-1', name: 'Plan.eigendoc', type: 'doc', mimeType: DRIVE_MIME_DOC });

// Reads fail, so the room keeps what the test seeded. Only a post answers with the status under test.
function answerPostsWith(status: number) {
    globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const isPost = init?.method === 'POST' || (input instanceof Request && input.method === 'POST');
            return Response.json({ id: 'message-1' }, { status: isPost ? status : 503 });
        },
        { preconnect: realFetch.preconnect },
    );
}

async function renderRoom() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'chat-1'), [media]);
    const seen: { room?: ReturnType<typeof useChatRoom> } = {};
    const { unmount } = await renderHook(() => {
        seen.room = useChatRoom('owner-1', 'm1', 'chat-1');
        return null;
    }, queryClient);
    const room = () => {
        if (!seen.room) throw new Error('the hook never rendered');
        return seen.room;
    };
    await act(async () => room().addDriveAttachments([doc]));
    return { room, unmount };
}

test('a post that fails puts the drive attachments back, rejects, and toasts once', async () => {
    answerPostsWith(503);
    const { room, unmount } = await renderRoom();
    expect(room().driveAttachments).toEqual([toAttachmentReference(doc)]);

    let rejected = false;
    await act(async () => {
        await room()
            .handleSendMessage('hello')
            .catch(() => {
                rejected = true;
            });
    });
    expect(rejected).toBe(true);
    expect(room().driveAttachments).toEqual([toAttachmentReference(doc)]);
    expect(toasts).toHaveLength(1);
    await unmount();
});

test('a post that succeeds leaves the drive attachments gone', async () => {
    answerPostsWith(200);
    const { room, unmount } = await renderRoom();
    await act(async () => room().handleSendMessage('hello'));
    expect(room().driveAttachments).toEqual([]);
    await unmount();
});
