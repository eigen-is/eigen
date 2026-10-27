import { describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { XmlError } from '../../lib/core/xml';
import { IMPORT_MESSAGES, importError } from '../../lib/import/messages';
import { ZipError } from '../../lib/ooxml/zip';

describe("an import's error", () => {
    const { tooLarge, invalid } = IMPORT_MESSAGES.xlsx;

    test("is a zip's or the XML's refusal in the format's words", () => {
        expect(importError(new ZipError('too-large'), 'xlsx')).toMatchObject({ status: 413, message: tooLarge });
        expect(importError(new ZipError('bad-crc'), 'xlsx')).toMatchObject({ status: 400, message: invalid });
        expect(importError(new XmlError('malformed'), 'docx')).toMatchObject({
            status: 400,
            message: IMPORT_MESSAGES.docx.invalid,
        });
    });

    test('is a stack the file outgrew as too large, and an out-of-memory or an ApiError as it is', () => {
        const stack = new RangeError('Maximum call stack size exceeded.');
        expect(importError(stack, 'xlsx')).toMatchObject({ status: 413, message: tooLarge });
        expect(importError(stack, 'pptx')).toMatchObject({ status: 413, message: IMPORT_MESSAGES.pptx.tooLarge });
        const outOfMemory = new RangeError('Out of memory');
        expect(importError(outOfMemory, 'xlsx')).toBe(outOfMemory);
        const refused = new ApiError(413, 'Spreadsheet has too many cells');
        expect(importError(refused, 'xlsx')).toBe(refused);
    });

    test("is the reader's slip as a file it can't read, logged with its format", () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(importError(new TypeError('slip'), 'xlsx')).toMatchObject({ status: 400, message: invalid });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('xlsx');
        } finally {
            warn.mockRestore();
        }
    });
});
