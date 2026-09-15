import { describe, expect, test } from 'bun:test';
import { isCalendarPart, mailAttachmentName } from '../../types/mail';

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

    test('keeps only the basename of a sender-supplied path', () => {
        expect(mailAttachmentName({ filename: '../../../etc/evil.txt' }, 0)).toBe('evil.txt');
        expect(mailAttachmentName({ filename: 'C:\\Windows\\System32\\evil.dll' }, 0)).toBe('evil.dll');
    });

    test('falls back when the name is nothing but separators', () => {
        expect(mailAttachmentName({ filename: '///' }, 3)).toBe('attachment-4');
        expect(mailAttachmentName({ filename: '../../' }, 0)).toBe('attachment-1');
    });

    test('strips control characters that would forge a header line', () => {
        expect(mailAttachmentName({ filename: 'in\r\nvoice.pdf' }, 0)).toBe('invoice.pdf');
        expect(mailAttachmentName({ filename: '\u007f' }, 0)).toBe('attachment-1');
    });
});

describe('isCalendarPart', () => {
    test('matches the bare type and a parameterized one', () => {
        expect(isCalendarPart({ contentType: 'text/calendar' })).toBe(true);
        expect(isCalendarPart({ contentType: 'text/calendar; method=REQUEST; charset=utf-8' })).toBe(true);
    });

    test('leaves every other part alone', () => {
        expect(isCalendarPart({ contentType: 'application/pdf' })).toBe(false);
        expect(isCalendarPart({ contentType: 'text/plain' })).toBe(false);
        expect(isCalendarPart({ contentType: 'application/ics' })).toBe(false);
    });
});
