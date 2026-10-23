import { describe, expect, test } from 'bun:test';
import { bundledFont } from '@workspace/lib/constants/fonts';
import { BATCH_BYTES, MAX_XLSX_ELEMENTS, readBudget } from '../../../lib/import/sheets/package';
import { readSharedStrings, stringOf, textOf } from '../../../lib/import/sheets/strings';
import { parseOoxml } from '../../../lib/ooxml/ooxml';
import { SML } from '../../fixtures/xlsx';

// Shared and inline strings: the text a cell shows, with a rich string's runs kept beside it.

const PALETTE = ['#FFFFFF', '#000000'];
const sst = (items: string[]) =>
    new TextEncoder().encode(`<sst xmlns="${SML}">${items.map((item) => `<si>${item}</si>`).join('')}</sst>`);

describe('a shared string', () => {
    test("is its text, as written, spaces and line breaks too; an empty one is ''", () => {
        expect(
            readSharedStrings(
                sst(['<t>plain</t>', '<t xml:space="preserve">  two\nlines </t>', '<t/>', '']),
                PALETTE,
                readBudget(),
            ),
        ).toEqual(['plain', '  two\nlines ', '', '']);
    });

    test("keeps a rich one's runs with their looks, and its text is theirs joined", () => {
        const [rich] = readSharedStrings(
            sst([
                '<r><t>Bold</t><rPr><b/></rPr></r><r><rPr><i/><rFont val="Arial"/><color theme="1"/></rPr><t xml:space="preserve"> and plain</t></r>',
            ]),
            PALETTE,
            readBudget(),
        );
        expect(rich).toEqual({
            text: 'Bold and plain',
            runs: [
                { v: 'Bold', bl: 1 },
                { v: ' and plain', it: 1, ff: bundledFont('Arial'), fc: '#000000' },
            ],
        });
        expect(textOf(rich)).toBe('Bold and plain');
    });

    test("keeps a run without properties, and text beside the runs, as plain text, in its cell's font", () => {
        const [rich] = readSharedStrings(
            sst(['<t xml:space="preserve">Lead </t><r><t>plain</t></r><r><rPr><b/></rPr><t>bold</t></r>']),
            PALETTE,
            readBudget(),
        );
        expect(rich).toEqual({ text: 'Lead plainbold', runs: ['Lead ', 'plain', { v: 'bold', bl: 1 }] });
    });

    test('reads past its phonetic runs, which annotate the text', () => {
        expect(
            readSharedStrings(
                sst(['<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>']),
                PALETTE,
                readBudget(),
            ),
        ).toEqual(['東京']);
    });

    test('decodes _xHHHH_ in either case, and _x005F_ escapes the underscore of one', () => {
        expect(
            readSharedStrings(
                sst(['<t>a_x000D__x000a_b</t>', '<t>_x005F_x0041_</t>', '<t>_x12_ _xZZZZ_</t>']),
                PALETTE,
                readBudget(),
            ),
        ).toEqual(['a\r\nb', '_x0041_', '_x12_ _xZZZZ_']);
    });

    test('keeps its index across the batches a long part is read in', () => {
        const count = Math.ceil((2 * BATCH_BYTES) / 40);
        const strings = readSharedStrings(
            sst(Array.from({ length: count }, (_, index) => `<t>${index}</t><rPh><t>x</t></rPh>`)),
            PALETTE,
            readBudget(),
        );
        expect(strings).toHaveLength(count);
        expect(strings[count - 1]).toBe(String(count - 1));
    });

    // 40 million empty strings, never shown, were a 1 MB file read for 14 s into 4.2 GB.
    test('are charged their elements before any is read', () => {
        const budget = readBudget();
        budget.chargeElements(MAX_XLSX_ELEMENTS - 1);
        expect(() => readSharedStrings(sst(['', '']), PALETTE, budget)).toThrow(
            'This spreadsheet is too large to import',
        );
    });

    test('no part is no strings', () => {
        expect(readSharedStrings(undefined, PALETTE, readBudget())).toEqual([]);
    });
});

describe('an inline string', () => {
    test('reads as a shared one does', () => {
        const is = parseOoxml(`<is xmlns="${SML}"><r><rPr><u/></rPr><t>x_x0041_</t></r></is>`) ?? undefined;
        if (!is) throw new Error('no element');
        expect(stringOf(is, PALETTE)).toEqual({ text: 'xA', runs: [{ v: 'xA', un: 1 }] });
    });
});
