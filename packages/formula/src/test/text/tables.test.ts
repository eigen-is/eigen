import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { REF } from '../../index';
import type { FormulaNode } from '../../text';
import {
    intersect,
    isLegacy,
    NodeKind,
    parseA1,
    parseStored,
    parseXlsx,
    printA1,
    printStored,
    printXlsx,
    tokens,
    xlsxTree,
} from '../../text';
import { ShapeTable } from '../../text/shapes';
import { engineOf, evaluate, valueAt } from '../recalc/support';
import { at, failure, findSheet, sheetName, shown, stored, treeA1, treeStored } from './support';

// Every form the corpus holds, with its count there, and the forms Excel shows a person.
const FORMS = [
    'Sales[Amount]',
    'Sales[[#This Row],[Amount]]',
    'Sales[#Data]',
    'Sales[#Headers]',
    'Sales[#All]',
    'Sales[[#Headers],[Amount]]',
    'Sales[[#All],[Amount]]',
    'Sales[[#This Row],[Net price]:[Amount]]',
    'Sales[[#Totals],[Amount]]',
    '[Amount]',
    'Sales[[Decimal ]]',
    'Sales[MONTH NUM (HIDE)]',
    "Sales[Parent''s name]",
    "Sales[[#This Row],[Index \r\n'[note 3']]]",
    'Таблица1[[ Sum for Q2 ]]',
    'Sales[@Amount]',
    'Sales[@[Net price]]',
    'Sales[@]',
    '[@Amount]',
    '[@[Net price]:[Amount]]',
    'Sales[]',
    'Sales[[#Headers],[#Data],[Amount]]',
    'Sales[ [Net price]:[Amount] ]',
    'Sales[[#Headers], [Amount]]',
    'Sales[2019]',
    'Sales[,]',
    'Sales[+]',
    "Sales['#x]",
    "Sales[a']b]",
];

function leaves(node: FormulaNode, into: FormulaNode[] = []): FormulaNode[] {
    if (node.children.length === 0) into.push(node);
    for (const child of node.children) leaves(child, into);
    return into;
}

describe('text/tables: a table reference is one leaf that keeps what was written', () => {
    for (const form of FORMS) {
        test(form, () => {
            const tree = treeA1(`=${form}`);
            expect(tree).toMatchObject({ kind: NodeKind.Table, text: form, children: [], space: '' });
            expect(printStored(tree)).toBe(`=${form}`);
            expect(parseStored(printStored(tree))).toEqual(tree);
            expect(shown(`=${form}`)).toBe(`=${form}`);
            expect(printXlsx(tree, ...at('N1'), sheetName)).toBe(form);
        });
    }

    test('the brackets end where Excel ends them: they nest, and a quote takes the next character with it', () => {
        expect(leaves(treeA1('=SUM(T[[a]:[b]],T[c])+1')).map((leaf) => leaf.text)).toEqual(['T[[a]:[b]]', 'T[c]', '']);
        expect(treeA1("=T[a']]+1").children[0].text).toBe("T[a']]");
        expect(treeA1("=T[a'[]+1").children[0].text).toBe("T[a'[]");
        expect(treeA1("=T[a'']+1").children[0].text).toBe("T[a'']");
        for (const open of ['=T[a', '=T[[a]', "=T[a']", '=[', "=T[a'"]) expect(failure(open)).toBe('syntax');
    });

    test('nothing inside the brackets is read: no operator, no string, no reference', () => {
        for (const inner of ['A1:B2', '"', '1+2', 'a(b', '#REF!', ' ', '\n', '@@', '#Nothing', '[x],[y],[z]']) {
            expect(treeA1(`=T[${inner}]`)).toMatchObject({ kind: NodeKind.Table, text: `T[${inner}]` });
        }
    });

    test('whitespace stays where it was typed, before the reference and inside it', () => {
        const tree = treeA1('=SUM( Sales[ Amount ] )');
        expect(tree.children[0]).toMatchObject({ kind: NodeKind.Table, text: 'Sales[ Amount ]', space: ' ' });
        expect(shown('=SUM( Sales[ Amount ] )')).toBe('=SUM( Sales[ Amount ] )');
    });

    test('it stands where a reference may: under a colon, an intersection, a union, a # and an @', () => {
        for (const text of ['=T[a]:T[b]', '=T[a] T[b]', '=(T[a],T[b])', '=T[a]#', '=@T[a]', '=A1:T[a]', '=[a]:[b]']) {
            expect(shown(text)).toBe(text);
            expect(parseStored(stored(text))).toEqual(treeA1(text));
        }
        // A name, whitespace and a bracket are two operands, as a name and a reference are.
        expect(treeA1('=Sales [Amount]')).toMatchObject({ kind: NodeKind.Binary });
    });

    test('a table on a sheet or in another workbook keeps its prefix, as a name does', () => {
        expect(stored('=Sheet2!T[a]')).toBe('=[s2]!T[a]');
        expect(shown('=Sheet2!T[a]')).toBe('=Sheet2!T[a]');
        expect(shown('=NoSuch!T[a]')).toBe('=NoSuch!T[a]');
        expect(shown('=[1]!T[[#All],[a]]')).toBe('=[1]!T[[#All],[a]]');
        expect(shown("='[1]x y'!T[a]")).toBe("='[1]x y'!T[a]");
        expect(treeA1('=[1]!T[a]')).toMatchObject({ kind: NodeKind.Table, text: 'T[a]', sheet: '[1]' });
    });

    test("another workbook's bracket, a sheet id and a stored offset are still what they were", () => {
        expect(treeA1('=[1]Sheet1!A1')).toMatchObject({ kind: NodeKind.Ref });
        expect(treeA1('=[1]!Rate')).toMatchObject({ kind: NodeKind.Name });
        expect(treeStored('=[s2]!R1C1')).toMatchObject({ kind: NodeKind.Ref });
        expect(treeStored('=R[1]C[2]')).toMatchObject({ kind: NodeKind.Ref });
        expect(treeStored('=R[-1]C')).toMatchObject({ kind: NodeKind.Ref });
    });

    test('a table named as the other grammar spells a reference is stored so that it comes back as itself', () => {
        // Typed, R[1] is a table R and its column 1. Stored, it is the row below.
        expect(stored('=R[1]')).toBe('=r[1]');
        expect(stored('=RC[1]')).toBe('=rc[1]');
        expect(parseStored('=R[1]C')).toMatchObject({ kind: NodeKind.Ref });
        // RC[x] is no reference in either grammar.
        expect(treeStored(stored('=RC[x]'))).toMatchObject({ kind: NodeKind.Table, text: 'RC[x]' });
        expect(stored('=C[-1]')).toBe('=c[-1]');
        expect(treeStored('=r[1]')).toMatchObject({ kind: NodeKind.Table, text: 'r[1]' });
        // A cell label before a bracket would come back from stored text as a cell, so it is no table.
        expect(failure('=A1[x]')).toBe('syntax');
        expect(failure('=A1[2]')).toBe('syntax');
        expect(parseStored('=R1C1[2]')).toMatchObject({ reason: 'syntax' });
        expect(parseStored('=A1[2]')).toMatchObject({ reason: 'syntax' });
    });

    test('equal text is one shape, and the letter case of a name is kept', () => {
        const table = new ShapeTable();
        const id = table.internTree(treeA1('=SUM(Sales[Amount])', 'B2'));
        expect(table.internTree(treeA1('=SUM(Sales[Amount])', 'Z99'))).toBe(id);
        expect(table.intern('=SUM(Sales[Amount])')).toBe(id);
        expect(table.internTree(treeA1('=SUM(sales[Amount])'))).not.toBe(id);
        expect(table.shape(id).refs).toEqual([]);
    });

    test('the file reader reads one and writes it back as the file had it', () => {
        const text = 'SUMIF(tblData[DATE],"<="&EOMONTH(fDate,0),tblData[[#This Row],[AMOUNT]])*[@Price]';
        const tree = parseXlsx(text, 4, 4, findSheet);
        if ('reason' in tree) throw new Error(tree.reason);
        const made = intersect(tree, FUNCTIONS);
        expect(printXlsx(xlsxTree(made, FUNCTIONS, isLegacy(made, FUNCTIONS)), 4, 4, sheetName)).toBe(text);
    });

    test('the editor cuts one into a name and its bracket, or the bracket alone', () => {
        expect(tokens('=Sales[[#This Row],[Qty]]*2').map((token) => token.end)).toEqual([1, 6, 25, 26, 27]);
    });
});

describe('text/tables: where an Excel without dynamic arrays read one cell', () => {
    const cut = (text: string): string => {
        const tree = parseXlsx(text, 4, 4, findSheet);
        if ('reason' in tree) throw new Error(tree.reason);
        return printA1(intersect(tree, FUNCTIONS), 4, 4, sheetName);
    };

    test('a whole column is a range like any other', () => {
        expect(cut('Sales[Amount]')).toBe('=@Sales[Amount]');
        expect(cut('Sales[Amount]*2')).toBe('=@Sales[Amount]*2');
        expect(cut('SUM(Sales[Amount])')).toBe('=SUM(Sales[Amount])');
        expect(cut('Sales[#All]+1')).toBe('=@Sales[#All]+1');
        expect(cut('ABS(Sales[[#Headers],[Amount]])')).toBe('=ABS(@Sales[[#Headers],[Amount]])');
    });

    test('this row of one column is one cell and gets no @', () => {
        for (const one of ['Sales[[#This Row],[Amount]]', 'Sales[@Amount]', '[@Amount]', '[@[Net price]]']) {
            expect(cut(`${one}*2`)).toBe(`=${one}*2`);
        }
        expect(cut('Sales[[#this row],[Amount]]*2')).toBe('=Sales[[#this row],[Amount]]*2');
    });

    test('this row of more than one column is as many cells', () => {
        expect(cut('Sales[[#This Row],[a]:[b]]*2')).toBe('=@Sales[[#This Row],[a]:[b]]*2');
        expect(cut('Sales[@]*2')).toBe('=@Sales[@]*2');
        expect(cut('Sales[#This Row]*2')).toBe('=@Sales[#This Row]*2');
    });

    test('a formula that holds one is written plain or as an array by the same rule as a range', () => {
        const plain = (text: string) => isLegacy(treeA1(text), FUNCTIONS);
        expect(plain('=SUM(Sales[Amount])')).toBe(true);
        expect(plain('=Sales[@Amount]*2')).toBe(true);
        expect(plain('=Sales[Amount]*2')).toBe(false);
    });
});

describe('text/tables: a table reference that reaches the engine was not resolved', () => {
    test('it answers #REF!, alone and under anything', () => {
        for (const formula of [
            '=Sales[Amount]',
            '=SUM(Sales[Amount])',
            '=[@Qty]*2',
            '=Sales[[#This Row],[Qty]]+A1',
            '=ROWS(Sales[#All])',
            '=Sales[a]:Sales[b]',
            '=SUM(Sales[a] A1:B2)',
            '=@Sales[a]',
            '=Sheet2!Sales[a]',
            '=NoSuch!Sales[a]',
        ]) {
            expect(evaluate(formula, { A1: 1 })).toBe(REF);
        }
        expect(evaluate('=IFERROR(SUM(Sales[Amount]),7)')).toBe(7);
        expect(evaluate('=ISREF(Sales[Amount])')).toBe(false);
    });

    test('rows and columns come and go, cells move and sheets change around one, and nothing throws', () => {
        const engine = engineOf({
            s1: { A1: 1, B5: '=SUM(Sales[Amount])+A1', C5: '=Sheet2!T[[#This Row],[x]]', D5: '=[@Qty]:A1' },
            s2: { A1: '=Sheet1!A1+T[a]' },
        });
        engine.recalc(Number.POSITIVE_INFINITY);
        engine.editLines({ insert: true, index: 0, count: 2, sheet: 's1', rows: true });
        engine.editLines({ insert: true, index: 0, count: 1, sheet: 's1', rows: false });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(engine.formulaOf('s1', 6, 2)).toBe('=SUM(Sales[Amount])+R[-4]C[-1]');
        expect(valueAt(engine, 'D7')).toBe(REF);
        engine.editLines({ insert: false, index: 2, count: 1, sheet: 's1', rows: true });
        const block = { fromSheet: 's1', row: 5, column: 2, rows: 1, columns: 3 };
        engine.moveCells({ ...block, toSheet: 's2', toRow: 9, toColumn: 0 });
        engine.renameSheet('s2', 'Other');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(engine.formulaOf('s2', 9, 0)).toBe('=SUM(Sales[Amount])+#REF!');
        expect(engine.formulaOf('s2', 9, 1)).toBe('=[s2]!T[[#This Row],[x]]');
        engine.removeSheet('s1');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A10', 's2')).toBe(REF);
    });
});
