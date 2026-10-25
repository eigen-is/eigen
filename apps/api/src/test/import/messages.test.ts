import { describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { XmlError } from '../../lib/core/xml';
import { IMPORT_MESSAGES, importError, importSummary } from '../../lib/import/messages';
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

// The toast after an Import…: one short line per kind of loss, from the counted warnings of any format's reader.
describe('importSummary', () => {
    test('nothing lost says nothing', () => {
        expect(importSummary([])).toBeNull();
        expect(importSummary([{ code: 'recalc-failed', message: 'no' }])).toBeNull();
    });

    test('one of one kind is singular', () => {
        expect(importSummary([{ code: 'tables-dropped', count: 1 }])).toBe('1 table was not imported.');
    });

    test('kinds are listed in a fixed order, what was left out before what was simplified', () => {
        expect(
            importSummary([
                { code: 'shapes-simplified', count: 5 },
                { code: 'diagrams-dropped', count: 1 },
                { code: 'tables-dropped', count: 2 },
            ]),
        ).toBe('2 tables and 1 SmartArt graphic were not imported; 5 shapes were simplified.');
    });

    test('a picture that is not shown and one that is not imported are one kind', () => {
        expect(
            importSummary([
                { code: 'images-dropped', count: 1 },
                { code: 'images-unshown', count: 2 },
                { code: 'charts-dropped', count: 1 },
                { code: 'objects-dropped', count: 3 },
            ]),
        ).toBe('1 chart, 3 embedded objects and 3 pictures were not imported.');
    });

    test('every simplification has its noun', () => {
        expect(
            importSummary([
                { code: 'text-simplified', count: 1 },
                { code: 'mirrors-dropped', count: 2 },
                { code: 'fills-simplified', count: 396 },
            ]),
        ).toBe('396 fills, 1 text box and 2 flipped pictures were simplified.');
    });

    test("a docx's losses have their nouns", () => {
        expect(
            importSummary([
                { code: 'graphics-dropped', count: 2 },
                { code: 'section-pages-dropped', count: 1 },
                { code: 'even-bands-dropped', count: 2 },
                { code: 'band-content-dropped', count: 1 },
                { code: 'blocks-flattened', count: 3 },
                { code: 'band-images-unanchored', count: 1 },
            ]),
        ).toBe(
            '2 SmartArt graphics, 1 section page setup, 2 even-page headers or footers and 1 header or footer item ' +
                'were not imported; 3 blocks and 1 header or footer picture were simplified.',
        );
    });

    test("an xlsx's dropped conditional formats have their noun", () => {
        expect(
            importSummary([
                { code: 'conditional-formats-dropped', count: 4 },
                { code: 'charts-dropped', count: 1 },
            ]),
        ).toBe('1 chart and 4 conditional formats were not imported.');
    });

    test("SmartArt is one kind, whether a deck's or a document's", () => {
        expect(
            importSummary([
                { code: 'diagrams-dropped', count: 1 },
                { code: 'graphics-dropped', count: 1 },
            ]),
        ).toBe('2 SmartArt graphics were not imported.');
    });
});
