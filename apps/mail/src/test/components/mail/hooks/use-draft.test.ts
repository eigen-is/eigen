import { describe, expect, test } from 'bun:test';
import type { Attachment, AttachmentMeta, EmailDraft } from '@workspace/lib/types/mail';
import { buildSaveOptions, initFields, mergeServerAttachments } from '../../../../components/mail/hooks/use-draft';

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
    // A chip's index feeds keepAttachmentIndexes verbatim, so it must be a raw index into the full list.
    const parsed: Attachment[] = [
        att('invite.ics', 'text/calendar', 0),
        att('a.pdf', 'application/pdf', 1),
        att('b.pdf', 'application/pdf', 2),
    ];

    test('a calendar part gets a chip like every other part', () => {
        const { localNext } = mergeServerAttachments([], [], parsed);
        expect(localNext.map((c) => c.filename)).toEqual(['invite.ics', 'a.pdf', 'b.pdf']);
        expect(localNext.map((c) => c.index)).toEqual([0, 1, 2]);
    });

    test('removing a chip keeps the surviving attachment its raw index', () => {
        const { localNext } = mergeServerAttachments([], [], parsed);
        // The reducer removes a chip by position; the survivors' indexes are what reach the save.
        const afterRemove = localNext.filter((_, i) => i !== 1);
        expect(afterRemove.map((c) => c.index)).toEqual([0, 2]);
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
        expect(serverActual.map((c) => [c.filename, c.index])).toEqual([['invite.ics', 0]]);
        expect(localNext.map((c) => [c.key, c.tempId])).toEqual([['local-0', undefined]]);
    });

    test('chips take the index the server gave each part, not its position in the answer', () => {
        // What a fast save answers with: the named parts only, each under its raw EML index.
        const fastSave: Attachment[] = [att('a.pdf', 'application/pdf', 1), att('b.pdf', 'application/pdf', 3)];
        const { localNext } = mergeServerAttachments([], [], fastSave);
        expect(localNext.map((c) => c.index)).toEqual([1, 3]);
    });
});

describe('initFields', () => {
    test('an invite on the draft opens as a removable chip', () => {
        const fields = initFields(
            savedDraft([att('invite.ics', 'text/calendar', 0), att('menu.pdf', 'application/pdf', 1)]),
        );
        expect(fields.attachments.map((a) => a.filename)).toEqual(['invite.ics', 'menu.pdf']);
        // The keep list the save sends is built from these indexes, so they stay raw EML positions.
        expect(fields.attachments.map((a) => a.index)).toEqual([0, 1]);
    });

    test('a draft without an invite keeps every part', () => {
        const fields = initFields(savedDraft([att('a.pdf', 'application/pdf', 0), att('b.pdf', 'application/pdf', 1)]));
        expect(fields.attachments.map((a) => a.index)).toEqual([0, 1]);
    });
});

describe('buildSaveOptions', () => {
    test('the keep list names the surviving chips by the index the server gave them', () => {
        const fields = initFields(
            savedDraft([
                att('a.pdf', 'application/pdf', 0),
                att('b.pdf', 'application/pdf', 1),
                att('c.pdf', 'application/pdf', 2),
            ]),
        );
        // The user removes the middle chip: the two survivors keep 0 and 2, never 0 and 1.
        const afterRemove = { ...fields, attachments: fields.attachments.filter((a) => a.filename !== 'b.pdf') };
        const options = buildSaveOptions(afterRemove, false);
        expect(options.keepAttachmentIndexes).toEqual([0, 2]);
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
        const options = buildSaveOptions({ ...fields, attachments: [...fields.attachments, uploading] }, false);
        expect(options.tempAttachmentIds).toEqual(['t1']);
        expect(options.keepAttachmentIndexes).toEqual([0]);
    });
});
