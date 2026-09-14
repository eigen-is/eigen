import { describe, expect, test } from 'bun:test';
import { mailAttachmentName } from '../../types/mail';

describe('mailAttachmentName', () => {
    test('returns the part filename when it has one', () => {
        expect(mailAttachmentName({ filename: 'invoice.pdf' }, 0)).toBe('invoice.pdf');
    });

    test('falls back to a 1-based hyphenated name when the part carries no filename', () => {
        expect(mailAttachmentName({ filename: undefined }, 0)).toBe('attachment-1');
        expect(mailAttachmentName({ filename: undefined }, 1)).toBe('attachment-2');
    });

    test('treats an empty filename as missing', () => {
        expect(mailAttachmentName({ filename: '' }, 2)).toBe('attachment-3');
    });
});
