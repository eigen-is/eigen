import { describe, expect, test } from 'bun:test';
import { bindSheet, offGrid, printA1, printStored } from '../../text';
import { ShapeTable } from '../../text/shapes';
import { sheetName, tree } from './support';

describe('bindSheet', () => {
    test('binds the references that name the sheet, in any case, and no other', () => {
        const before = tree("=Later!A1+SUM('LATER'!A:A)+later!Rate+Later!#REF!+'Later on'!A1+Sheet2!A1", 'A1');
        expect(printStored(bindSheet(before, 'Later', 'n9'))).toBe(
            "=[n9]!RC+SUM([n9]!C:C)+[n9]!Rate+[n9]!#REF!+'Later on'!RC+[s2]!RC",
        );
    });
    test('returns the same tree when nothing names the sheet', () => {
        const before = tree('=Later!A1+Sheet2!A1+A1', 'A1');
        expect(bindSheet(before, 'Sheet2', 'n9')).toBe(before);
        expect(bindSheet(before, 'Late', 'n9')).toBe(before);
    });
    test('folds case as sheet names do, so ß is not ss', () => {
        const before = tree("='Straße'!A1", 'A1');
        expect(bindSheet(before, 'STRASSE', 'n9')).toBe(before);
        expect(bindSheet(before, 'straße', 'n9')).not.toBe(before);
    });
    test('leaves a shape that names no sheet any more', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.internTree(tree('=Later!A1+Later!B2', 'A1')));
        expect(shape.namesSheet).toBe(true);
        if (shape.tree === null) throw new Error('unparsed');
        expect(table.shape(table.internTree(bindSheet(shape.tree, 'later', 'n9'))).namesSheet).toBe(false);
    });
});

describe('a deleted sheet needs no rewrite', () => {
    const before = tree('=Sheet2!A1+SUM(Sheet2!A:A)', 'A1');
    const without = (id: string) => (id === 's2' ? undefined : sheetName(id));
    test('its references read #REF! while it is gone and bind again when undo brings it back', () => {
        expect(printA1(before, 0, 0, without)).toBe('=#REF!+SUM(#REF!)');
        expect(printA1(before, 0, 0, sheetName)).toBe('=Sheet2!A1+SUM(Sheet2!A:A)');
    });
    test('a new sheet of the same name has another id, so they stay #REF!', () => {
        const names = (id: string) => (id === 'n9' ? 'Sheet2' : without(id));
        expect(printA1(bindSheet(before, 'Sheet2', 'n9'), 0, 0, names)).toBe('=#REF!+SUM(#REF!)');
    });
});

describe('offGrid: a copy keeps the stored text and only checks where it lands', () => {
    const refs = (text: string, host: string) => {
        const table = new ShapeTable();
        return table.shape(table.internTree(tree(text, host))).refs;
    };
    test.each<[string, string, [number, number], boolean[]]>([
        ['=A1', 'B2', [0, 0], [true]],
        ['=A1', 'B2', [0, 1], [true]],
        ['=A1', 'B2', [1, 0], [true]],
        ['=A1', 'B2', [3, 3], [false]],
        ['=$A$1+A$1+$A1', 'B2', [0, 0], [false, true, true]],
        ['=SUM(A1:B2)', 'C3', [1, 1], [true]],
        ['=SUM(A:B)+SUM(1:2)', 'D4', [9, 2], [true, false]],
        ['=SUM(A:B)+SUM(1:2)', 'D4', [2, 9], [false, true]],
        ['=XFD1+A1048576', 'A1', [0, 1], [true, false]],
        ['=XFD1+A1048576', 'A1', [1, 0], [false, true]],
        ['=SUM(A1:A2)', 'A1', [1048575, 0], [true]],
        ['=SUM(A2:A1)', 'A1', [1048575, 0], [true]],
        ['=SUM(A1:A2)', 'A1', [1048574, 0], [false]],
        ['=SUM(A1:B1)', 'A1', [0, 16383], [true]],
        ['=SUM(B1:A1)', 'A1', [0, 16383], [true]],
        ['=SUM(A1:B1)', 'A1', [0, 16382], [false]],
        ['=Sheet2!A1', 'B2', [0, 0], [true]],
    ])('%s typed at %s and copied to %p', (text, host, [row, column], expected) => {
        const found = refs(text, host);
        expect(found.map((reference) => offGrid(reference, row, column))).toEqual(expected);
        expect(printA1(tree(text, host), row, column, sheetName).includes('#REF!')).toBe(expected.includes(true));
    });
});
