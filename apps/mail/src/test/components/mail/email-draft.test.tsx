// A forward's parts are fetched and attached once, while the forward has no saved draft: a composer that
// opens on the saved draft already holds them, so it fetches none of them again. The route drops them from
// history state only once a saved draft holds them all.
import { afterEach, expect, jest, test } from 'bun:test';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type { EmailDraft as EmailDraftType } from '@workspace/lib/types/mail';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { EmailDraft } = await import('../../../components/mail/email-draft');

let unmount = async () => {};
afterEach(() => unmount());

const fetched: string[] = [];
// The network a test stands up; by default there is none.
let network = async (_url: string, _init?: RequestInit): Promise<Response> => {
    throw new TypeError('A component test has no network');
};
globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
        fetched.push(String(input));
        return network(String(input), init);
    },
    { preconnect: () => {} },
);

const part: FileSubject = {
    mail: { ownerId: 'u1', messageId: 'm1', index: 0 },
    part: { filename: 'menu.pdf', contentType: 'application/pdf', size: 10 },
    attachment: true,
};

const savedForward: EmailDraftType = {
    id: 'draft-1',
    filename: 'draft-1.eml',
    subject: 'FW: Lunch',
    fromShort: 'Alice',
    fromAddress: 'alice@test.eigen.is',
    toShort: 'Bob',
    toAddress: 'bob@test.eigen.is',
    recipientsAll: 'bob@test.eigen.is',
    textShort: 'quoted',
    date: new Date('2026-09-15T10:00:00Z'),
    isRead: true,
    isFlagged: false,
    isDraft: true,
    isReplied: false,
    hasAttachments: true,
    mailbox: 'Drafts',
    size: 100,
    attachments: [
        { filename: 'menu.pdf', contentType: 'application/pdf', index: 0, size: 10, content: new Uint8Array(10) },
    ],
    html: '<p>quoted</p>',
    text: 'quoted',
};

async function openComposer(email: EmailDraftType | null) {
    fetched.length = 0;
    ({ unmount } = await renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(EmailDraft, {
                email,
                prefillDraft: { subject: 'FW: Lunch', html: '<p>quoted</p>', text: 'quoted' },
                forwardedParts: [part],
                sendDraft: async () => {},
                isSending: false,
                onPreparingSendChange: () => {},
                filePickerOpen: false,
                onFilePickerOpenChange: () => {},
            }),
        ),
    ));
    await act(async () => {});
    return fetched.filter((url) => url.includes('/attachment/0/menu.pdf'));
}

test('a fresh forward fetches the part it carries', async () => {
    expect(await openComposer(null)).toHaveLength(1);
});

test('a forward reopened on its saved draft fetches no part again', async () => {
    expect(await openComposer(savedForward)).toEqual([]);
});

test('a forward whose first save ran while its part uploaded reports the parts saved only once a save holds it', async () => {
    let download = (_response: Response) => {};
    network = async (url, init) => {
        if (init?.method === 'POST') {
            return Response.json({ tempId: 't1', filename: 'menu.pdf', size: 10, contentType: 'application/pdf' });
        }
        if (url.includes('/attachment/0/menu.pdf')) return new Promise((resolve) => (download = resolve));
        throw new TypeError(`no route for ${url}`);
    };
    const saves: (string[] | undefined)[] = [];
    let partsSaved = 0;
    jest.useFakeTimers();
    try {
        ({ unmount } = await renderInDocument(
            createElement(
                AuthProvider,
                null,
                createElement(EmailDraft, {
                    email: null,
                    prefillDraft: { subject: 'FW: Lunch', html: '<p>quoted</p>', text: 'quoted' },
                    forwardedParts: [part],
                    sendDraft: async () => {},
                    onAutoSave: async (_draft, options) => {
                        saves.push(options?.tempAttachmentIds);
                        return {
                            ...savedForward,
                            attachments: options?.tempAttachmentIds ? savedForward.attachments : [],
                        };
                    },
                    onForwardedPartsSaved: () => partsSaved++,
                    isSending: false,
                    onPreparingSendChange: () => {},
                    filePickerOpen: false,
                    onFilePickerOpenChange: () => {},
                }),
            ),
        ));
        const subject = document.querySelector('#subject');
        if (!(subject instanceof HTMLInputElement)) throw new Error('no subject field');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(subject, 'FW: Lunch!');
            subject.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => void jest.advanceTimersByTime(3000));
        expect(saves).toEqual([undefined]);
        expect(partsSaved).toBe(0);

        await act(async () => download(new Response(new Uint8Array(10))));
        expect(partsSaved).toBe(0);
        await act(async () => void jest.advanceTimersByTime(3000));
        expect(saves).toEqual([undefined, ['t1']]);
        expect(partsSaved).toBe(1);
    } finally {
        jest.useRealTimers();
        network = async () => {
            throw new TypeError('A component test has no network');
        };
    }
});
