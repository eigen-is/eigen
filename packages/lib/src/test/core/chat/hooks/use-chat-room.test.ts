// A send clears the drive attachments waiting beside the composer at once. Pinned here: a post that fails puts them
// back and still rejects, so the composer restores its own text, and a post that succeeds leaves them gone. A local
// command, such as /help, posts and uploads nothing, leaves them waiting and tells the composer to keep its files. The
// composer can't send until the room's media folder is known, so no staged file is ever skipped.
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
    posts.length = 0;
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

// A staged file goes up by XHR, which the fetch stub never sees, so its upload is a post answered the same way.
let uploadAnswer = { status: 0, body: '' };
class AnsweredUpload {
    public withCredentials = false;
    public status = 0;
    public responseText = '';
    public upload = { onprogress: null };
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onabort: (() => void) | null = null;
    private url = '';

    public open(_method: string, url: string) {
        this.url = url;
    }

    public send() {
        posts.push(this.url);
        this.status = uploadAnswer.status;
        this.responseText = uploadAnswer.body;
        this.onload?.();
    }

    public getResponseHeader() {
        return 'application/json';
    }
}
Object.assign(globalThis, { XMLHttpRequest: AnsweredUpload });

// Reads fail, so the room keeps what the test seeded. Only a post answers with the status under test.
const posts: string[] = [];
function answerPostsWith(status: number, body: unknown = { id: 'message-1' }) {
    uploadAnswer = { status, body: JSON.stringify(body) };
    globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const isPost = init?.method === 'POST' || (input instanceof Request && input.method === 'POST');
            if (isPost) posts.push(input instanceof Request ? input.url : String(input));
            return Response.json(body, { status: isPost ? status : 503 });
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

const staged = [new File(['x'], 'photo.png', { type: 'image/png' })];

test.each(['/help', '/whoami', '/nosuchcommand', '/inspect ada@example.com', '/invite not-an-email', '/reply hello'])(
    '%s posts and uploads nothing, leaves the attachments waiting and keeps the staged files',
    async (command) => {
        answerPostsWith(200);
        const { room, unmount } = await renderRoom();
        let filesTaken: boolean | undefined;
        await act(async () => {
            filesTaken = await room().handleSendMessage(command, staged);
        });
        expect(posts).toEqual([]);
        expect(filesTaken).toBe(false);
        expect(room().driveAttachments).toEqual([toAttachmentReference(doc)]);
        expect(room().messages.at(-1)?.type).toBe('system');
        await unmount();
    },
);

test('an /invite that reaches the server uploads nothing and leaves the attachments waiting', async () => {
    answerPostsWith(200, { alreadyHasAccess: false });
    const { room, unmount } = await renderRoom();
    let filesTaken: boolean | undefined;
    await act(async () => {
        filesTaken = await room().handleSendMessage('/invite bob@example.com', staged);
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEndWith('/invite');
    expect(filesTaken).toBe(false);
    expect(room().driveAttachments).toEqual([toAttachmentReference(doc)]);
    expect(room().messages.at(-1)?.content).toBe('You invited bob@example.com.');
    await unmount();
});

test('a message takes the staged files: it uploads them and posts', async () => {
    answerPostsWith(200, [{ ...media, name: 'photo.png' }]);
    const { room, unmount } = await renderRoom();
    let filesTaken: boolean | undefined;
    await act(async () => {
        filesTaken = await room().handleSendMessage('hello', staged);
    });
    expect(filesTaken).toBe(true);
    expect(posts).toHaveLength(2);
    await unmount();
});

test('the composer is disabled until the media folder is known', async () => {
    answerPostsWith(200);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: { room?: ReturnType<typeof useChatRoom> } = {};
    const { unmount } = await renderHook(() => {
        seen.room = useChatRoom('owner-1', 'm1', 'chat-1');
        return null;
    }, queryClient);
    expect(seen.room?.disabled).toBe(true);
    await act(async () => {
        queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'chat-1'), [media]);
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(seen.room?.disabled).toBe(false);
    await unmount();
});
