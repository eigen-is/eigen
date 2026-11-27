// An optimistic read must survive every order in which the inbox list and the write can land. A fake server holds
// each message's read flag, answers a list request with the flags as they stood when it was sent, and answers a read
// only when the test commits and acknowledges it. Every script ends with all requests answered and checks that the
// cached row says what the server says. The two attempts reverted before this design each fail one of these.
import { afterEach, describe, expect, test } from 'bun:test';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { emailKeys } from '../../../../core/mail/hooks/keys';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER } from '../../../transfer-harness';

installTransferHarness();

const { act } = await import('react');
const { useEmails, useToggleReadEmail } = await import('../../../../core/mail/hooks/use-emails');

function summary(id: string): EmailSummary {
    return {
        id,
        filename: `${id}.eml`,
        subject: 'Hello',
        fromShort: 'Bob',
        fromAddress: 'bob@example.com',
        toShort: 'Me',
        toAddress: 'me@example.com',
        recipientsAll: 'me@example.com',
        textShort: '',
        date: new Date(0),
        receivedAt: new Date(0),
        isRead: false,
        isFlagged: false,
        isDraft: false,
        isReplied: false,
        hasAttachments: false,
        mailbox: 'INBOX',
        size: 1,
    };
}

const FIRST = summary('msg-1');
const SECOND = summary('msg-2');
const INBOX = emailKeys.list(OWNER, 'inbox');

type Write = { id: string; commit: () => void; ack: () => void; fail: () => void };

// The server's flags, the list requests waiting for an answer and the reads waiting to be stored or answered.
const server = {
    read: new Map<string, boolean>(),
    waitingLists: [] as (() => void)[],
    listRequests: 0,
    writes: [] as Write[],
};

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
    server.read.clear();
    server.waitingLists.length = 0;
    server.listRequests = 0;
    server.writes.length = 0;
});

function installServer(): void {
    globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            if (method === 'GET' && url.includes('/mailbox/inbox')) {
                server.listRequests++;
                const rows = [FIRST, SECOND].map((e) => ({ ...e, isRead: server.read.get(e.id) ?? false }));
                return new Promise<Response>((resolve) => server.waitingLists.push(() => resolve(Response.json(rows))));
            }
            const readRoute = url.match(/\/message\/([^/?]+)\/read/);
            if (method === 'PUT' && readRoute) {
                const id = readRoute[1];
                const { read } = JSON.parse(String(init?.body));
                return new Promise<Response>((resolve) =>
                    server.writes.push({
                        id,
                        commit: () => server.read.set(id, read),
                        ack: () => resolve(Response.json(null)),
                        fail: () => resolve(Response.json({ message: 'refused' }, { status: 500 })),
                    }),
                );
            }
            return Response.json(null, { status: 404 });
        },
        { preconnect: realFetch.preconnect },
    );
}

// Lets the fetches, the mutation's steps and React's renders run to rest.
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

async function answerLists(): Promise<void> {
    const waiting = server.waitingLists.splice(0);
    for (const answer of waiting) answer();
    await settle();
}

// Answers every list request, including the ones an answer starts, until none is left.
async function answerAllLists(): Promise<void> {
    while (server.waitingLists.length > 0) await answerLists();
}

function nextWrite(): Write {
    const write = server.writes.shift();
    if (!write) throw new Error('no read is waiting');
    return write;
}

async function storeAndAnswer(write: Write): Promise<void> {
    write.commit();
    write.ack();
    await settle();
}

function cachedIsRead(queryClient: QueryClient, id: string): boolean | undefined {
    const data = queryClient.getQueryData<InfiniteData<EmailSummary[]>>(INBOX);
    return data?.pages.flat().find((e) => e.id === id)?.isRead;
}

async function openInbox() {
    installServer();
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { latest, unmount } = await renderHook(
        () => ({ list: useEmails('inbox'), toggle: useToggleReadEmail() }),
        queryClient,
    );
    await settle();
    const markRead = async (email: EmailSummary, isRead = true) => {
        latest.toggle.mutate({ email, isRead });
        await settle();
    };
    return { queryClient, markRead, unmount };
}

describe('a mail read on a list still loading', () => {
    test('the first page, answered before the write is stored, does not leave the row unread', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await markRead(FIRST);

        await answerLists();
        await storeAndAnswer(nextWrite());
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(true);
        await unmount();
    });

    test('a page still on its way when the write is answered does not leave the row unread', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await markRead(FIRST);

        await storeAndAnswer(nextWrite());
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(true);
        await unmount();
    });

    test('the list is never left without data while the write waits', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await markRead(FIRST);

        await answerLists();

        expect(queryClient.getQueryData(INBOX)).toBeDefined();
        expect(cachedIsRead(queryClient, FIRST.id)).toBe(false);
        await unmount();
    });
});

describe('a mail read on a loaded list', () => {
    test('a refetch answered while the write waits does not leave the row unread', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await answerLists();
        await markRead(FIRST);

        // Stands in for an SSE event, such as new mail arriving, that refetches the list during the write.
        void queryClient.invalidateQueries({ queryKey: INBOX });
        await settle();
        await answerLists();
        expect(cachedIsRead(queryClient, FIRST.id)).toBe(false);

        await storeAndAnswer(nextWrite());
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(true);
        await unmount();
    });

    test('a refetch sent before the write and answered after it does not leave the row unread', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await answerLists();
        await markRead(FIRST);

        void queryClient.invalidateQueries({ queryKey: INBOX });
        await settle();
        await storeAndAnswer(nextWrite());
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(true);
        await unmount();
    });

    test('asks the server for no list once the write is answered', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await answerLists();
        const before = server.listRequests;

        await markRead(FIRST);
        await storeAndAnswer(nextWrite());

        expect(server.listRequests).toBe(before);
        expect(cachedIsRead(queryClient, FIRST.id)).toBe(true);
        await unmount();
    });

    test("another row's refused read does not undo this row's read", async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await answerLists();
        await markRead(FIRST);
        await markRead(SECOND);
        const first = nextWrite();
        const second = nextWrite();

        first.fail();
        await settle();
        await storeAndAnswer(second);
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(false);
        expect(cachedIsRead(queryClient, SECOND.id)).toBe(true);
        await unmount();
    });

    test('read then unread on one row ends unread', async () => {
        const { queryClient, markRead, unmount } = await openInbox();
        await answerLists();
        await markRead(FIRST);
        await markRead({ ...FIRST, isRead: true }, false);

        await storeAndAnswer(nextWrite());
        await storeAndAnswer(nextWrite());
        await answerAllLists();

        expect(cachedIsRead(queryClient, FIRST.id)).toBe(false);
        await unmount();
    });
});
