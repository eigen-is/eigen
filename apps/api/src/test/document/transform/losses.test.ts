import { describe, expect, test } from 'bun:test';
import { lossSummary } from '../../../lib/document/transform/losses';
import { COUNTED_WARNING_CODES } from '../../../lib/document/transform/protocol';

// The toast after an Import…: one short line per kind of loss, from the counted warnings of any format's reader.
describe('an import summary', () => {
    test('nothing lost says nothing', () => {
        expect(lossSummary([], 'import')).toBeNull();
        expect(lossSummary([{ code: 'recalc-failed', message: 'no' }], 'import')).toBeNull();
    });

    test('one of one kind is singular', () => {
        expect(lossSummary([{ code: 'tables-dropped', count: 1 }], 'import')).toBe('1 table was not imported.');
    });

    test('kinds are listed in a fixed order, what was left out before what was simplified', () => {
        expect(
            lossSummary(
                [
                    { code: 'shapes-simplified', count: 5 },
                    { code: 'diagrams-dropped', count: 1 },
                    { code: 'tables-dropped', count: 2 },
                ],
                'import',
            ),
        ).toBe('2 tables and 1 SmartArt graphic were not imported; 5 shapes were simplified.');
    });

    test('a picture left out is not imported, and one kept that no browser shows is said apart', () => {
        expect(
            lossSummary(
                [
                    { code: 'images-dropped', count: 1 },
                    { code: 'images-unshown', count: 2 },
                    { code: 'charts-dropped', count: 1 },
                    { code: 'objects-dropped', count: 3 },
                ],
                'import',
            ),
        ).toBe("1 chart, 3 embedded objects and 1 picture were not imported; 2 pictures can't be shown.");
    });

    test('every simplification has its noun', () => {
        expect(
            lossSummary(
                [
                    { code: 'text-simplified', count: 1 },
                    { code: 'fills-simplified', count: 396 },
                ],
                'import',
            ),
        ).toBe('396 fills and 1 text box were simplified.');
    });

    // A flipped picture comes in, unflipped.
    test("a picture's flip is said to be what was not imported", () => {
        expect(lossSummary([{ code: 'mirrors-dropped', count: 1 }], 'import')).toBe(
            "1 picture's flip was not imported.",
        );
        expect(lossSummary([{ code: 'mirrors-dropped', count: 2 }], 'import')).toBe(
            "2 pictures' flips were not imported.",
        );
    });

    test("a docx's losses have their nouns", () => {
        expect(
            lossSummary(
                [
                    { code: 'diagrams-dropped', count: 2 },
                    { code: 'section-pages-dropped', count: 1 },
                    { code: 'even-bands-dropped', count: 2 },
                    { code: 'band-content-dropped', count: 1 },
                    { code: 'blocks-flattened', count: 3 },
                    { code: 'band-images-unanchored', count: 1 },
                ],
                'import',
            ),
        ).toBe(
            "2 SmartArt graphics, 1 section's page setup, 2 even-page headers or footers and 1 header or footer item " +
                'were not imported; 1 header or footer picture was simplified; 3 parts of the document lost their layout.',
        );
    });

    test('a clause says its verb of one as of one', () => {
        expect(
            lossSummary(
                [
                    { code: 'images-unshown', count: 1 },
                    { code: 'blocks-flattened', count: 1 },
                ],
                'import',
            ),
        ).toBe("1 part of the document lost its layout; 1 picture can't be shown.");
    });

    test("an xlsx's dropped conditional formats and validations have their nouns", () => {
        expect(
            lossSummary(
                [
                    { code: 'validations-dropped', count: 1 },
                    { code: 'conditional-formats-dropped', count: 4 },
                    { code: 'charts-dropped', count: 1 },
                ],
                'import',
            ),
        ).toBe('1 chart, 4 conditional formats and 1 data validation rule were not imported.');
    });
});

// The toast after a download or a print: the same nouns, said of the file the export wrote.
describe('an export summary', () => {
    test('nothing lost says nothing', () => {
        expect(lossSummary([], 'export')).toBeNull();
        expect(lossSummary([{ code: 'byte-guard-truncated', bytes: 9 }], 'export')).toBeNull();
    });

    test('what the writer left out is left out of the file, said of one as of one', () => {
        expect(lossSummary([{ code: 'charts-dropped', count: 1 }], 'export')).toBe('1 chart was left out of the file.');
        expect(
            lossSummary(
                [
                    { code: 'images-dropped', count: 2 },
                    { code: 'charts-dropped', count: 1 },
                ],
                'export',
            ),
        ).toBe('1 chart and 2 pictures were left out of the file.');
    });

    test("a pptx's and a docx's simplifications have their nouns", () => {
        expect(
            lossSummary(
                [
                    { code: 'fills-simplified', count: 2 },
                    { code: 'charts-simplified', count: 1 },
                    { code: 'tables-simplified', count: 1 },
                    { code: 'shapes-simplified', count: 3 },
                ],
                'export',
            ),
        ).toBe('1 table, 1 chart, 3 shapes and 2 fills were simplified.');
    });

    test("an xlsx's limits and a print's cuts have their nouns, in a fixed order", () => {
        expect(
            lossSummary(
                [
                    { code: 'sheet-names-changed', count: 1 },
                    { code: 'texts-cut', count: 2 },
                    { code: 'formulas-dropped', count: 1 },
                    { code: 'sheets-cut', count: 1 },
                    { code: 'sheets-left-out', count: 3 },
                    { code: 'band-blocks-cut', count: 1 },
                ],
                'export',
            ),
        ).toBe(
            '3 sheets and 1 formula were left out of the file; 1 header or footer, 1 sheet and 2 long texts were cut ' +
                'to fit; 1 sheet was renamed.',
        );
    });

    // A stored edit that doesn't decode is skipped, as on a live read, so the file misses it.
    test('part of the document that could not be read is said first', () => {
        expect(
            lossSummary(
                [
                    { code: 'fills-simplified', count: 1 },
                    { code: 'corrupt-blobs-skipped', count: 1 },
                ],
                'export',
            ),
        ).toBe("1 part of the document couldn't be read and is missing; 1 fill was simplified.");
    });
});

describe('every counted loss', () => {
    // A code with no phrase would leave its loss out of the toast without a word.
    test.each(COUNTED_WARNING_CODES)('%s is phrased both ways, in plain ASCII a header can carry', (code) => {
        for (const direction of ['import', 'export'] as const) {
            for (const count of [1, 2]) {
                const summary = lossSummary([{ code, count }], direction);
                expect(summary).toMatch(new RegExp(`^${count} [\\x20-\\x7e]+\\.$`));
            }
        }
    });
});
