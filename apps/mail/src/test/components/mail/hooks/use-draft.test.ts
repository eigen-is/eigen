import { afterEach, describe, expect, test } from 'bun:test';
import type { Attachment, AttachmentMeta, DraftUpdateOptions, EmailDraft, NewDraft } from '@workspace/lib/types/mail';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// The tests render the hook, so the DOM goes in before React and the hook are imported.
installHappyDom();

const { act, createElement } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { AuthProvider } = await import('@workspace/lib/auth');
const { useDraft } = await import('../../../../components/mail/hooks/use-draft');

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

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    unmount = async () => {};
});

// Opens a composer's state, as the route does. `saves` lists every save the composer asks for, and each answers as a
// draft the server now holds with the parts in `answer`, unless the options bring an onSave of their own.
async function openDraft(options: Partial<Parameters<typeof useDraft>[0]>, answer: Attachment[] = []) {
    const saves: { draft: NewDraft; options?: DraftUpdateOptions }[] = [];
    const seen: { draft?: ReturnType<typeof useDraft> } = {};
    function Probe() {
        seen.draft = useDraft({
            email: null,
            onSave: async (draft, saveOptions) => {
                saves.push({ draft, options: saveOptions });
                return savedDraft(answer);
            },
            ...options,
        });
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe))));
    const composer = () => {
        if (!seen.draft) throw new Error('the composer state never rendered');
        return seen.draft;
    };
    const run = (change: (d: ReturnType<typeof useDraft>) => unknown) =>
        act(async () => void (await change(composer())));
    // Sends what the composer would send now: a save when anything changed, none otherwise.
    const flush = () => act(async () => void (await composer().flushAndGetDraft()));
    return { saves, run, flush, chips: () => composer().state.attachments };
}

const uploading = (filename: string, contentType = 'application/pdf'): AttachmentMeta => ({
    key: 'local-0',
    tempId: 't1',
    filename,
    size: 10,
    contentType,
});

describe('the chips after a save', () => {
    test('a calendar part gets a chip like every other part', async () => {
        const parts = [
            att('invite.ics', 'text/calendar', 0),
            att('a.pdf', 'application/pdf', 1),
            att('b.pdf', 'application/pdf', 2),
        ];
        const { run, flush, chips } = await openDraft({ email: savedDraft([]) }, parts);
        await run((d) => d.setField('subject', 'Edited'));
        await flush();
        expect(chips().map((c) => c.filename)).toEqual(['invite.ics', 'a.pdf', 'b.pdf']);
    });

    test('a filename-less part reconciles against the chip named by mailAttachmentName', async () => {
        const nameless = [att(undefined, 'application/pdf', 0)];
        const { run, flush, chips } = await openDraft({ email: savedDraft([]) }, nameless);
        await run((d) => d.addAttachment(uploading('attachment-1')));
        await flush();
        // Same name on both sides: the chip keeps its key and doesn't come back as an in-flight addition.
        expect(chips().map((c) => [c.key, c.filename])).toEqual([['local-0', 'attachment-1']]);
    });

    test('an uploaded invite settles onto the part the save embedded', async () => {
        const parts = [att('invite.ics', 'text/calendar', 0)];
        const { run, flush, chips } = await openDraft({ email: savedDraft([]) }, parts);
        await run((d) => d.addAttachment(uploading('invite.ics', 'text/calendar')));
        await flush();
        // The chip keeps its key and loses the tempId the server has already consumed, so no later save re-sends it.
        expect(chips().map((c) => [c.key, c.tempId])).toEqual([['local-0', undefined]]);
    });
});

describe('a saved draft opening in the composer', () => {
    test('an invite on the draft opens as a removable chip', async () => {
        const { chips } = await openDraft({
            email: savedDraft([att('invite.ics', 'text/calendar', 0), att('menu.pdf', 'application/pdf', 1)]),
        });
        expect(chips().map((a) => a.filename)).toEqual(['invite.ics', 'menu.pdf']);
    });

    test('a reopened reply keeps the message it answers, which its next save names', async () => {
        const { saves, run, flush } = await openDraft({ email: { ...savedDraft([]), repliedToId: 'original-1' } });
        await run((d) => d.setField('subject', 'Edited'));
        await flush();
        expect(saves[0].draft.repliedToId).toBe('original-1');
    });
});

describe('what a save asks the server to keep', () => {
    const threeParts = () =>
        savedDraft([
            att('a.pdf', 'application/pdf', 0),
            att('b.pdf', 'application/pdf', 1),
            att('c.pdf', 'application/pdf', 2),
        ]);

    test('the keep list names the surviving chips by filename and size', async () => {
        const { saves, run, flush } = await openDraft({ email: threeParts() });
        await run((d) => d.removeAttachment(1));
        await flush();
        expect(saves[0].options?.keepAttachments).toEqual([
            { filename: 'a.pdf', size: 10 },
            { filename: 'c.pdf', size: 10 },
        ]);
        expect(saves[0].options?.tempAttachmentIds).toBeUndefined();
    });

    test('a chip still uploading goes to the temp list, not the keep list', async () => {
        const { saves, run, flush } = await openDraft({ email: savedDraft([att('a.pdf', 'application/pdf', 0)]) });
        await run((d) => d.addAttachment(uploading('new.pdf')));
        await flush();
        expect(saves[0].options?.tempAttachmentIds).toEqual(['t1']);
        expect(saves[0].options?.keepAttachments).toEqual([{ filename: 'a.pdf', size: 10 }]);
    });

    test('removing every chip sends an empty list, and a draft with no id sends none', async () => {
        const saved = await openDraft({ email: savedDraft([att('a.pdf', 'application/pdf', 0)]) });
        await saved.run((d) => d.removeAttachment(0));
        await saved.flush();
        expect(saved.saves[0].options?.keepAttachments).toEqual([]);
        await unmount();

        const fresh = await openDraft({});
        await fresh.run((d) => d.setField('subject', 'New'));
        await fresh.flush();
        expect(fresh.saves[0].options?.keepAttachments).toBeUndefined();
    });
});

describe('a save the server refuses', () => {
    const refusing = (status: number, value: string) => async () => {
        const error = new AppError({ status, error: { status, value } });
        // What a mutation's mutateAsync does: the hook's onError toasts, and the promise still rejects.
        onMutationError(error);
        throw error;
    };

    test('after the server says the message is no longer a draft, nothing saves again', async () => {
        let saves = 0;
        const refuse = refusing(409, 'This message is no longer a draft');
        const { run, flush } = await openDraft({
            email: savedDraft([]),
            onSave: () => {
                saves++;
                return refuse();
            },
        });

        await run((d) => d.setField('subject', 'Typed in a tab left open'));
        await run((d) => d.flushAndGetDraft().catch(() => {}));
        expect(saves).toBe(1);

        await run((d) => d.setField('subject', 'And typed some more'));
        await flush();
        await unmount();
        expect(saves).toBe(1);
    });

    // Bun fails a test on an unhandled rejection, as the browser raises a page error on one.
    test('a failed auto-save reaches the toast and raises no page error', async () => {
        const { run } = await openDraft({ email: savedDraft([]), onSave: refusing(503, 'Service unavailable') });

        await run((d) => d.setField('subject', 'Typed'));
        await act(async () => void (await Bun.sleep(2700)));
        await unmount();
        await Bun.sleep(10);
    }, 10_000);
});

describe('closing the composer while a save is in flight', () => {
    // Holds each answer until the test lets it go, so the closing save has a save to wait for.
    function heldSaves() {
        const saves: { draft: NewDraft; options?: DraftUpdateOptions; answer: (parts: Attachment[]) => void }[] = [];
        const onSave = (draft: NewDraft, options?: DraftUpdateOptions) =>
            new Promise<EmailDraft>((resolve) => {
                saves.push({ draft, options, answer: (parts) => resolve(savedDraft(parts)) });
            });
        const answer = (index: number, parts: Attachment[] = []) =>
            act(async () => {
                saves[index].answer(parts);
                await Bun.sleep(0);
            });
        return { saves, onSave, answer };
    }

    test('the closing save waits, and names the upload the save before it embedded as a part to keep', async () => {
        const { saves, onSave, answer } = heldSaves();
        const { run } = await openDraft({ email: savedDraft([]), onSave });
        await run((d) => d.addAttachment(uploading('new.pdf')));
        await run((d) => void d.flushAndGetDraft());
        await run((d) => d.setField('subject', 'Typed during the save'));
        await unmount();
        expect(saves.length).toBe(1);
        expect(saves[0].options?.tempAttachmentIds).toEqual(['t1']);

        await answer(0, [att('new.pdf', 'application/pdf', 0)]);

        expect(saves.length).toBe(2);
        expect(saves[1].draft.subject).toBe('Typed during the save');
        expect(saves[1].options?.tempAttachmentIds).toBeUndefined();
        expect(saves[1].options?.keepAttachments).toEqual([{ filename: 'new.pdf', size: 10 }]);
    });

    test('a first save still in flight gives the closing save its id, and the closed composer stays closed', async () => {
        const { saves, onSave, answer } = heldSaves();
        const assigned: string[] = [];
        const { run } = await openDraft({ onSave, onDraftIdAssigned: (id) => assigned.push(id) });
        await run((d) => d.setField('subject', 'First'));
        await run((d) => void d.flushAndGetDraft());
        await run((d) => d.setField('subject', 'Typed during the save'));
        await unmount();
        expect(saves.map((s) => s.draft.id)).toEqual([undefined]);

        await answer(0);

        expect(saves.map((s) => s.draft.id)).toEqual([undefined, 'draft-1']);
        expect(assigned).toEqual([]);
    });

    test('with nothing typed since the save in flight, closing saves nothing more', async () => {
        const { saves, onSave, answer } = heldSaves();
        const { run } = await openDraft({ onSave });
        await run((d) => d.setField('subject', 'First'));
        await run((d) => void d.flushAndGetDraft());
        await unmount();

        await answer(0);

        expect(saves.length).toBe(1);
    });

    test('a send flush and the closing save both waiting go one after the other', async () => {
        const { saves, onSave, answer } = heldSaves();
        const { run } = await openDraft({ email: savedDraft([]), onSave });
        await run((d) => d.setField('subject', 'First'));
        await run((d) => void d.flushAndGetDraft());
        await run((d) => d.setField('subject', 'Typed during the save'));
        await run((d) => void d.flushAndGetDraft());
        await unmount();

        await answer(0);
        expect(saves.length).toBe(2);

        await answer(1);
        expect(saves.length).toBe(2);
    });
});

describe('a forward carries the parts of the message it forwards', () => {
    const forward: NewDraft = { subject: 'FW: Lunch', html: '<p>quoted</p>', text: 'quoted' };
    const part = (tempId: string, filename: string): AttachmentMeta => ({
        key: `forward-${tempId}`,
        tempId,
        filename,
        size: 10,
        contentType: 'application/pdf',
    });

    async function openForward() {
        const opened = await openDraft({ prefillDraft: forward });
        return { ...opened, staged: () => opened.saves.map((s) => s.options?.tempAttachmentIds) };
    }

    test('both parts of a two-part message go out with the first save, and only an edit saves', async () => {
        const { staged, run, flush } = await openForward();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await run((d) => d.addPrefillAttachment(part('t2', 'b.pdf')));
        // Like the quoted body, the parts are the prefill: a forward the user leaves saves no draft.
        await flush();
        expect(staged()).toEqual([]);

        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(staged()).toEqual([['t1', 't2']]);
    });

    test('closing the composer saves what is not saved yet, and nothing when all of it is', async () => {
        const { saves, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(saves.length).toBe(1);

        await unmount();
        expect(saves.length).toBe(1);

        const edited = await openForward();
        await edited.run((d) => d.setField('to', 'bob@test.eigen.is'));
        await unmount();
        expect(edited.saves.length).toBe(1);
    });

    test('removing one part in the composer sends the other', async () => {
        const { staged, run, flush } = await openForward();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await run((d) => d.addPrefillAttachment(part('t2', 'b.pdf')));
        await run((d) => d.removeAttachment(0));
        await flush();
        expect(staged()).toEqual([['t2']]);
    });

    test('a forward of a message without attachments sends none', async () => {
        const { staged, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        expect(staged()).toEqual([undefined]);
    });

    test('a part that lands after the user typed rides on the pending save', async () => {
        const { staged, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await flush();
        expect(staged()).toEqual([['t1']]);
    });

    test('a part that lands after the draft was saved is an edit, so the next save embeds it', async () => {
        const { staged, run, flush } = await openForward();
        await run((d) => d.setField('to', 'bob@test.eigen.is'));
        await flush();
        await run((d) => d.addPrefillAttachment(part('t1', 'a.pdf')));
        await flush();
        expect(staged()).toEqual([undefined, ['t1']]);
    });
});
