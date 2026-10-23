import { describe, expect, test } from 'bun:test';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { sharedStringTable } from '../../../../lib/export/sheets/xlsx/strings';
import { readBudget } from '../../../../lib/import/sheets/package';
import { readSharedStrings } from '../../../../lib/import/sheets/strings';

function tableOf() {
    const lost: CountedWarningCode[] = [];
    return { table: sharedStringTable((code) => lost.push(code)), lost };
}

function partOf(xml: Iterable<string>): string {
    return [...xml].join('');
}

function readBack(xml: string) {
    return readSharedStrings(new TextEncoder().encode(xml), [], readBudget());
}

describe('the shared strings', () => {
    test('are interned once each, counted per use, in the order first used', () => {
        const { table } = tableOf();
        expect([table.text('b'), table.text('a'), table.text('b'), table.text('')]).toEqual([0, 1, 0, 2]);
        const xml = partOf(table.xml());
        expect(xml).toStartWith(
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="3">',
        );
        expect(readBack(xml)).toEqual(['b', 'a', '']);
    });

    test("a character XML can't hold is written _xHHHH_ and a literal _xHHHH_ escaped, so the reader decodes both back", () => {
        const { table } = tableOf();
        const text = 'bell\u0007 tab\t line\nliteral _x0041_ end';
        table.text(text);
        const xml = partOf(table.xml());
        expect(xml).toContain('bell_x0007_');
        expect(xml).toContain('_x005F_x0041_');
        expect(readBack(xml)).toEqual([text]);
    });

    test('text with whitespace at an edge keeps it', () => {
        const { table } = tableOf();
        table.text('  padded ');
        const xml = partOf(table.xml());
        expect(xml).toContain('<t xml:space="preserve">  padded </t>');
        expect(readBack(xml)).toEqual(['  padded ']);
    });

    test("past Excel's 32,767 characters a text is cut, and each cut counted", () => {
        const { table, lost } = tableOf();
        const long = 'x'.repeat(40_000);
        table.text(long);
        table.text(long);
        expect(lost).toEqual(['texts-cut', 'texts-cut']);
        expect(readBack(partOf(table.xml()))).toEqual(['x'.repeat(32_767)]);
    });

    test('a rich string keeps its runs and their fonts; runs without text are left out, and none is no string', () => {
        const { table } = tableOf();
        const runs = [{ v: 'Hello ', bl: 1, fc: '#FF0000' }, { v: '' }, { v: 'world', it: 1, ff: 'Georgia', fs: 14 }];
        expect(table.runs(runs)).toBe(0);
        expect(table.runs(runs)).toBe(0);
        expect(table.runs([{ v: '' }, { bl: 1 }])).toBeUndefined();
        expect(table.text('Hello world')).toBe(1);
        const [rich] = readBack(partOf(table.xml()));
        expect(rich).toEqual({
            text: 'Hello world',
            runs: [
                { v: 'Hello ', bl: 1, fs: 10, ff: 'Inter', fc: '#FF0000' },
                { v: 'world', it: 1, fs: 14, ff: 'Source Serif 4' },
            ],
        });
    });

    test('are written in batches, never one string past its batch', () => {
        const { table } = tableOf();
        for (let index = 0; index < 50_000; index++) table.text(`string number ${index} ${'x'.repeat(40)}`);
        const batches = [...table.xml()];
        expect(batches.length).toBeGreaterThan(2);
        for (const batch of batches) expect(batch.length).toBeLessThan(1.1 * 1024 * 1024);
        expect(readBack(batches.join(''))).toHaveLength(50_000);
    });
});
