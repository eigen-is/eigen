import { describe, expect, test } from 'bun:test';
import { lossCounter } from '../../../lib/document/transform/protocol';
import { nameInliner } from '../../../lib/import/sheets/names';
import type { DefinedName } from '../../../lib/import/sheets/package';
import { MAX_FORMULA_LENGTH } from '../../../lib/ooxml/spreadsheetml';

// A workbook's defined names inlined into the formulas that use them, on the sheet each formula sits on.

function inliner(names: DefinedName[]) {
    const losses = lossCounter();
    return { inline: nameInliner(names, losses.lost), warnings: () => losses.warnings() };
}

describe('a defined name', () => {
    test('becomes the range it names, in any case it is written in', () => {
        const { inline, warnings } = inliner([{ name: 'Sales', text: "'Q 1'!$A$1:$A$9" }]);
        expect(inline('=SUM(Sales)+sales', 'Data')).toBe("=SUM('Q 1'!$A$1:$A$9)+'Q 1'!$A$1:$A$9");
        expect(warnings()).toEqual([]);
    });

    test("a sheet's own name wins over the workbook's on that sheet only, and a qualified one is that sheet's", () => {
        const { inline } = inliner([
            { name: 'Rate', text: 'Inputs!$B$2' },
            { name: 'RATE', sheet: 'Local', text: 'Local!$Z$1' },
        ]);
        expect(inline('=Rate', 'local')).toBe('=Local!$Z$1');
        expect(inline('=Rate', 'Data')).toBe('=Inputs!$B$2');
        expect(inline('=Local!Rate+Data!Rate', 'Data')).toBe('=Local!$Z$1+Data!Rate');
    });

    test('naming another name is inlined through it; a formula is inlined in parentheses, a constant as itself', () => {
        const { inline } = inliner([
            { name: 'Total', text: 'SUM(Sales)*Rate' },
            { name: 'Sales', text: 'Data!$A$1:$A$3' },
            { name: 'Rate', text: '0.2' },
            { name: 'Label', text: '"VAT"' },
        ]);
        expect(inline('=Total-1', 'Data')).toBe('=(SUM(Data!$A$1:$A$3)*0.2)-1');
        expect(inline('=Label&Rate', 'Data')).toBe('="VAT"&0.2');
    });

    test('pointing at a deleted range is #REF!, as Excel shows it', () => {
        const { inline, warnings } = inliner([{ name: 'Gone', text: 'Data!#REF!' }]);
        expect(inline('=Gone*2', 'Data')).toBe('=#REF!*2');
        expect(warnings()).toEqual([]);
    });

    // Each stays as written, and counts once however many formulas use it.
    test('in another workbook, over several areas, relative or in a cycle stays, counted once', () => {
        const { inline, warnings } = inliner([
            { name: 'External', text: '[1]Prices!$A$1' },
            { name: 'Areas', text: 'Data!$A$1,Data!$C$1' },
            { name: 'Here', text: 'Data!A1' },
            { name: 'Ping', text: 'Pong+1' },
            { name: 'Pong', text: 'Ping+1' },
        ]);
        for (const formula of ['=External+1', '=SUM(Areas)', '=Here', '=Ping', '=External'])
            expect(inline(formula, 'Data')).toBe(formula);
        expect(warnings()).toEqual([{ code: 'names-dropped', count: 4 }]);
    });

    test('that makes the formula longer than Excel allows stays, counted', () => {
        const { inline, warnings } = inliner([{ name: 'Long', text: `"${'x'.repeat(MAX_FORMULA_LENGTH / 2)}"` }]);
        expect(inline('=Long&Long&Long', 'Data')).toBe('=Long&Long&Long');
        expect(warnings()).toEqual([{ code: 'names-dropped', count: 1 }]);
    });

    test('nobody defined stays as written, uncounted', () => {
        const { inline, warnings } = inliner([{ name: 'Rate', text: '0.2' }]);
        expect(inline('=Unknown*2', 'Data')).toBe('=Unknown*2');
        expect(warnings()).toEqual([]);
    });
});
