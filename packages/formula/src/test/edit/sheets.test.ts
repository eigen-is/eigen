import { describe, expect, test } from 'bun:test';
import { bindSheet, offGrid, printA1, printStored, remapSheets } from '../../text';
import { ShapeTable } from '../../text/shapes';
import { treeStored } from '../text/support';
import { sheetName, tree } from './support';

describe('remapSheets', () => {
    const ids = new Map([
        ['s1', 'n1'],
        ['s2', 'n2'],
    ]);
    test('rewrites the id of every reference, scoped name and broken reference', () => {
        const before = treeStored('=RC+[s1]!R[1]C+SUM([s2]!C1:C2, [s3]!R1C1)+[s1]!Rate+[s2]!#REF!');
        expect(printStored(remapSheets(before, ids))).toBe(
            '=RC+[n1]!R[1]C+SUM([n2]!C1:C2, [s3]!R1C1)+[n1]!Rate+[n2]!#REF!',
        );
    });
    test('leaves the host sheet, a name that is no sheet and another workbook alone, and returns the same tree', () => {
        const before = treeStored("=RC+'s1'!RC+'[1]s1'!RC+[s9]!RC+\"[s1]!RC\"");
        expect(remapSheets(before, ids)).toBe(before);
    });
    test('maps every id once, so two sheets can swap ids', () => {
        const swap = new Map([
            ['s1', 's2'],
            ['s2', 's1'],
        ]);
        expect(printStored(remapSheets(treeStored('=[s1]!RC+[s2]!R1C1:R2C2+[s2]!Rate+[s1]!#REF!'), swap))).toBe(
            '=[s2]!RC+[s1]!R1C1:R2C2+[s1]!Rate+[s2]!#REF!',
        );
    });
    test('reaches every term of a sum of thousands, which is a tree that deep', () => {
        const before = treeStored(`=${'[s1]!RC+'.repeat(16000)}RC`);
        expect(printStored(remapSheets(before, ids))).toBe(`=${'[n1]!RC+'.repeat(16000)}RC`);
    });
    test('a duplicated tab points its references to itself at the copy', () => {
        const copy = remapSheets(tree('=A1+Sheet1!B1+Sheet2!C1', 'D1'), new Map([['s1', 'copy']]));
        const names = (id: string) => (id === 'copy' ? 'Sheet1 (2)' : sheetName(id));
        expect(printA1(copy, 0, 3, names)).toBe("=A1+'Sheet1 (2)'!B1+Sheet2!C1");
    });
});

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
