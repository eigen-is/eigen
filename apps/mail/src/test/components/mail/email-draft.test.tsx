// A forward's parts are fetched and attached once, while the forward has no saved draft: a composer that
// opens on the saved draft already holds them, so it fetches none of them again.
import { afterEach, expect, test } from 'bun:test';
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
globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
        fetched.push(String(input));
        throw new TypeError('A component test has no network');
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
