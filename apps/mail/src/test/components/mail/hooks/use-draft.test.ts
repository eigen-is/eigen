import { describe, expect, test } from 'bun:test';
import type { Attachment, AttachmentMeta } from '@workspace/lib/types/mail';
import { mergeServerAttachments } from '../../../../components/mail/hooks/use-draft';

function att(filename: string | undefined, contentType: string, size = 10): Attachment {
    return { filename, contentType, size, content: new Uint8Array(size) };
}

describe('mergeServerAttachments', () => {
    // A chip's index feeds keepAttachmentIndexes verbatim, so it must be a raw index into the full list.
    const parsed: Attachment[] = [
        att('invite.ics', 'text/calendar'),
        att('a.pdf', 'application/pdf'),
        att('b.pdf', 'application/pdf'),
    ];

    test('chips carry raw indexes when a calendar part precedes real attachments', () => {
        const { localNext } = mergeServerAttachments([], [], parsed);
        expect(localNext.map((c) => c.filename)).toEqual(['a.pdf', 'b.pdf']);
        expect(localNext.map((c) => c.index)).toEqual([1, 2]);
    });

    test('removing a chip keeps the surviving attachment its raw index', () => {
        const { localNext } = mergeServerAttachments([], [], parsed);
        // The reducer removes a chip by position; the survivor's index is what reaches the save.
        const afterRemove = localNext.filter((_, i) => i !== 0);
        expect(afterRemove.map((c) => c.index)).toEqual([2]);
    });

    test('a filename-less part reconciles against the chip named by mailAttachmentName', () => {
        const nameless: Attachment[] = [att(undefined, 'application/pdf')];
        const local: AttachmentMeta[] = [
            { key: 'local-0', tempId: 't1', filename: 'attachment-1', size: 10, contentType: 'application/pdf' },
        ];
        const { serverActual, localNext } = mergeServerAttachments(local, [], nameless);
        expect(serverActual.map((c) => c.filename)).toEqual(['attachment-1']);
        // Same name on both sides: the chip keeps its key and doesn't come back as an in-flight addition.
        expect(localNext.map((c) => c.key)).toEqual(['local-0']);
    });
});
