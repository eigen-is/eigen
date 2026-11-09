import { afterEach, describe, expect, test } from 'bun:test';
import type { Attachment, AttachmentMeta, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// The forward tests render the hook, so the DOM goes in before React and the hook are imported.
installHappyDom();

const { act, createElement } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { AuthProvider } = await import('@workspace/lib/auth');
const { buildSaveOptions, initFields, mergeServerAttachments, useDraft } = await import(
    '../../../../components/mail/hooks/use-draft'
);

function att(filename: string | undefined, contentType: string, index: number, size = 10): Attachment {
    return { filename, contentType, index, size, content: new Uint8Array(size) };
}

function savedDraft(attachments: Attachment[]): EmailDraft {
    return {
        id: 'draft-1',
        filename: 'draft-1.eml',
        subject: 'Lunch',
        fromShort: 'Alice',
        fromAddress: 'alice@test.eigen.is',
        toShort: 'Bob',
        toAddress: 'bob@test.eigen.is',
        recipientsAll: 'bob@test.eigen.is',
        textShort: 'see you',
        date: new Date('2026-09-15T10:00:00Z'),
        isRead: true,
        isFlagged: false,
        isDraft: true,
        isReplied: false,
        hasAttachments: true,
        mailbox: 'Drafts',
        size: 100,
        attachments,
        html: '<p>see you</p>',
        text: 'see you',
    };
}

describe('mergeServerAttachments', () => {
    const parsed: Attachment[] = [
        att('invite.ics', 'text/calendar', 0),
        att('a.pdf', 'application/pdf', 1),
        att('b.pdf', 'application/pdf', 2),
    ];

    test('a calendar part gets a chip like every other part', () => {
        const { localNext } = mergeServerAttachments([], [], parsed);
        expect(localNext.map((c) => c.filename)).toEqual(['invite.ics', 'a.pdf', 'b.pdf']);
    });

    test('a filename-less part reconciles against the chip named by mailAttachmentName', () => {
        const nameless: Attachment[] = [att(undefined, 'application/pdf', 0)];
        const local: AttachmentMeta[] = [
            { key: 'local-0', tempId: 't1', filename: 'attachment-1', size: 10, contentType: 'application/pdf' },
        ];
        const { serverActual, localNext } = mergeServerAttachments(local, [], nameless);
        expect(serverActual.map((c) => c.filename)).toEqual(['attachment-1']);
        // Same name on both sides: the chip keeps its key and doesn't come back as an in-flight addition.
        expect(localNext.map((c) => c.key)).toEqual(['local-0']);
    });

    test('an uploaded invite settles onto the part the save embedded', () => {
        const local: AttachmentMeta[] = [
            { key: 'local-0', tempId: 't1', filename: 'invite.ics', size: 10, contentType: 'text/calendar' },
        ];
        // The chip keeps its key and loses the tempId the server has already consumed, so no later
        // save re-sends it.
        const { serverActual, localNext } = mergeServerAttachments(local, [], [att('invite.ics', 'text/calendar', 0)]);
        expect(serverActual.map((c) => c.filename)).toEqual(['invite.ics']);
        expect(localNext.map((c) => [c.key, c.tempId])).toEqual([['local-0', undefined]]);
    });
});

describe('initFields', () => {
    test('an invite on the draft opens as a removable chip', () => {
        const fields = initFields(
            savedDraft([att('invite.ics', 'text/calendar', 0), att('menu.pdf', 'application/pdf', 1)]),
        );
        expect(fields.attachments.map((a) => a.filename)).toEqual(['invite.ics', 'menu.pdf']);
    });

    test('a draft without an invite keeps every part', () => {
        const fields = initFields(savedDraft([att('a.pdf', 'application/pdf', 0), att('b.pdf', 'application/pdf', 1)]));
        expect(fields.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.pdf']);
    });
});

test('a reopened reply keeps the message it answers, which its next save names', () => {
    const reopened = { ...savedDraft([]), repliedToId: 'original-1' };
    expect(initFields(reopened).repliedToId).toBe('original-1');
});

describe('buildSaveOptions', () => {
    test('the keep list names the surviving chips by filename and size', () => {
        const fields = initFields(
            savedDraft([
                att('a.pdf', 'application/pdf', 0),
                att('b.pdf', 'application/pdf', 1),
                att('c.pdf', 'application/pdf', 2),
            ]),
        );
        const afterRemove = { ...fields, attachments: fields.attachments.filter((a) => a.filename !== 'b.pdf') };
        const options = buildSaveOptions(afterRemove);
        expect(options.keepAttachments).toEqual([
            { filename: 'a.pdf', size: 10 },
            { filename: 'c.pdf', size: 10 },
        ]);
        expect(options.tempAttachmentIds).toBeUndefined();
    });

    test('a chip still uploading goes to the temp list, not the keep list', () => {
        const fields = initFields(savedDraft([att('a.pdf', 'application/pdf', 0)]));
        const uploading: AttachmentMeta = {
            key: 'local-0',
            tempId: 't1',
            filename: 'new.pdf',
            size: 10,
            contentType: 'application/pdf',
        };
        const options = buildSaveOptions({ ...fields, attachments: [...fields.attachments, uploading] });
        expect(options.tempAttachmentIds).toEqual(['t1']);
        expect(options.keepAttachments).toEqual([{ filename: 'a.pdf', size: 10 }]);
    });
});

test('after the server says the message is no longer a draft, nothing saves again', async () => {
    let saves = 0;
    const seen: { draft?: ReturnType<typeof useDraft> } = {};
    function Probe() {
        seen.draft = useDraft({
            email: savedDraft([]),
            onSave: async () => {
                saves++;
                throw new AppError({ status: 409, error: { status: 409, value: 'This message is no longer a draft' } });
            },
        });
        return null;
    }
    const { unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe)));
    const edit = (subject: string) => act(async () => seen.draft?.setField('subject', subject));

    await edit('Typed in a tab left open');
    await act(async () => {
        await seen.draft?.flushAndGetDraft().catch(() => {});
    });
    expect(saves).toBe(1);

    await edit('And typed some more');
    await act(async () => void (await seen.draft?.flushAndGetDraft()));
    await unmount();
    expect(saves).toBe(1);
});

// Bun fails a test on an unhandled rejection, as the browser raises a page error on one.
test('a failed auto-save reaches the toast and raises no page error', async () => {
    const seen: { draft?: ReturnType<typeof useDraft> } = {};
    function Probe() {
        seen.draft = useDraft({
            email: savedDraft([]),
            // What a mutation's mutateAsync does: the hook's onError toasts, and the promise still rejects.
            onSave: async () => {
                const error = new AppError({ status: 503, error: { status: 503, value: 'Service unavailable' } });
                onMutationError(error);
                throw error;
            },
        });
        return null;
    }
    const { unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe)));

    await act(async () => seen.draft?.setField('subject', 'Typed'));
    await act(async () => void (await Bun.sleep(2700)));
    await unmount();
    await Bun.sleep(10);
}, 10_000);

describe('a forward carries the parts of the message it forwards', () => {
    const forward: NewDraft = { subject: 'FW: Lunch', html: '<p>quoted</p>', text: 'quoted' };
    const part = (tempId: string, filename: string): AttachmentMeta => ({
        key: `forward-${tempId}`,
        tempId,
        filename,
        size: 10,
        contentType: 'application/pdf',
    });

    let unmount = async () => {};
    afterEach(() => unmount());

    // Opens a forward's composer state. `saved` lists the temp ids of every save the composer asks for,
    // and each save answers as a draft the server now holds.
    async function openForward() {
        const saved: (string[] | undefined)[] = [];
        const seen: { draft?: ReturnType<typeof useDraft> } = {};
        function Probe() {
            seen.draft = useDraft({
                email: null,
                prefillDraft: forward,
                onSave: async (_draft, options) => {
                    saved.push(options?.tempAttachmentIds);
                    return savedDraft([]);
                },
            });
            return null;
        }
        ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe))));
        const draft = () => {
            if (!seen.draft) throw new Error('the composer state never rendered');
            return seen.draft;
        };
        const run = (change: (d: ReturnType<typeof useDraft>) => void) => act(async () => change(draft()));
        // Sends what the composer would send now: a save when anything changed, none otherwise.
        const flush = () => act(async () => void (await draft().flushAndGetDraft()));
        return { saved, run, flush };
    }

    test('both parts of a two-part message go out with the first save, and only an edit saves', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await run((d) => d.addPrefillAttachment(part('t2', 'b.pdf')));
        // Like the quoted body, the parts are the prefill: a forward the user leaves saves no draft.
        await flush();
        expect(saved).toEqual([]);

        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(saved).toEqual([['t1', 't2']]);
    });

    test('closing the composer saves what is not saved yet, and nothing when all of it is', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(saved.length).toBe(1);

        await unmount();
        unmount = async () => {};
        expect(saved.length).toBe(1);

        const edited = await openForward();
        await edited.run((d) => d.setField('to', 'bob@test.eigen.is'));
        await unmount();
        unmount = async () => {};
        expect(edited.saved.length).toBe(1);
    });

    test('removing one part in the composer sends the other', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await run((d) => d.addPrefillAttachment(part('t2', 'b.pdf')));
        await run((d) => d.removeAttachment(0));
        await flush();
        expect(saved).toEqual([['t2']]);
    });

    test('a forward of a message without attachments sends none', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(saved).toEqual([undefined]);
    });

    test('a part that lands after the user typed rides on the pending save', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await flush();
        expect(saved).toEqual([['t1']]);
    });

    test('a part that lands after the draft was saved is an edit, so the next save embeds it', async () => {
        const { saved, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await flush();
        expect(saved).toEqual([undefined, ['t1']]);
    });
});
