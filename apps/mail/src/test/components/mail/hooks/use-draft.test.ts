import { describe, expect, test } from 'bun:test';
import type { Attachment } from '@workspace/lib/types/mail';
import { mergeServerAttachments } from '../../../../components/mail/hooks/use-draft';

function att(filename: string, contentType: string, size = 10): Attachment {
    return { filename, contentType, size } as Attachment;
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
});
