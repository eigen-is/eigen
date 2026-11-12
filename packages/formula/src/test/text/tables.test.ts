import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { REF } from '../../index';
import type { FormulaNode, Table, TableFinder } from '../../text';
import {
    intersect,
    isLegacy,
    NodeKind,
    parseA1Range,
    parseStored,
    parseXlsx,
    printA1,
    printStored,
    printXlsx,
    resolveTables,
    SheetKind,
    tokens,
    xlsxTree,
} from '../../text';
import { ShapeTable } from '../../text/shapes';
import { engineOf, evaluate, valueAt } from '../recalc/support';
import { at, dice, failure, findSheet, sheetName, shown, stored, treeA1, treeStored } from './support';

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

    test('a $ in the name of a table is refused, as it is in a name', () => {
        for (const text of ['=Sales$[a]', '=T$x[a]', '=$Sales[a]']) {
            expect(failure(text)).toBe('syntax');
            expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
        }
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

// Three tables on Sheet1 and one on Sheet2. One is B2:D7 with a header and a totals row, so its data is rows 3 to 6;
// Two is F2:H6 with a header only; Raw is J3:K6 with neither; Odd is on Sheet2 with names that need an escape; Head is
// M2:N2, a header row and no data row, as a third-party writer may leave one.
const TABLES: Readonly<Record<string, Table>> = {
    one: {
        sheet: 's1',
        top: 1,
        left: 1,
        bottom: 6,
        right: 3,
        headerRows: 1,
        totalsRows: 1,
        columns: ['Region', 'Qty', 'Unit Price'],
    },
    two: {
        sheet: 's1',
        top: 1,
        left: 5,
        bottom: 5,
        right: 7,
        headerRows: 1,
        totalsRows: 0,
        columns: ['Region', 'Qty', 'Unit Price'],
    },
    raw: { sheet: 's1', top: 2, left: 9, bottom: 5, right: 10, headerRows: 0, totalsRows: 0, columns: ['A', 'B'] },
    odd: {
        sheet: 's2',
        top: 0,
        left: 0,
        bottom: 3,
        right: 8,
        headerRows: 1,
        totalsRows: 0,
        columns: ['Q]', "It's", "x'", '#N', 'Unit\nPrice', ' Sum ', '@a', 'a,b', '2019'],
    },
    head: { sheet: 's1', top: 1, left: 12, bottom: 1, right: 13, headerRows: 1, totalsRows: 0, columns: ['A', 'B'] },
};

const findTable: TableFinder = (name, sheet, row, column) =>
    name === ''
        ? Object.values(TABLES).find(
              (table) =>
                  table.sheet === sheet &&
                  row >= table.top &&
                  row <= table.bottom &&
                  column >= table.left &&
                  column <= table.right,
          )
        : TABLES[name.toLowerCase()];

// What a formula of a file reads as at a cell once its table references are replaced.
function resolved(text: string, host = 'E4', sheet = 's1'): string {
    const tree = resolveTables(treeA1(`=${text}`, host), sheet, ...at(host), findTable);
    return printA1(tree, ...at(host), sheetName).slice(1);
}

// Each row: the reference, the range it stands for, and where that meaning comes from. LO is Calc's reader and IC
// IronCalc's, as the research seat reported them; M is Microsoft's description; "ours" is a choice no source settles,
// listed in the unit's report as an Excel check.
const MEANINGS: readonly (readonly [string, string, string])[] = [
    ['One[Qty]', '$C$3:$C$6', 'LO, IC, M'],
    ['One[]', '$B$3:$D$6', 'LO, M'],
    ['One[#Data]', '$B$3:$D$6', 'LO, IC'],
    ['One[#All]', '$B$2:$D$7', 'LO, IC'],
    ['One[#Headers]', '$B$2:$D$2', 'LO, IC'],
    ['One[#Totals]', '$B$7:$D$7', 'LO, IC'],
    ['One[[#Headers],[Qty]]', '$C$2', 'LO'],
    ['One[[#Totals],[Qty]]', '$C$7', 'LO, IC'],
    ['One[[#All],[Qty]]', '$C$2:$C$7', 'LO, IC'],
    ['One[[#Headers],[#Data],[Qty]]', '$C$2:$C$6', 'LO, M'],
    ['One[[#Data],[#Totals],[Qty]]', '$C$3:$C$7', 'LO, M'],
    ['One[[#Data],[#Totals]]', '$B$3:$D$7', 'LO'],
    ['One[[#Data],[Qty]]', '$C$3:$C$6', 'M'],
    ['One[[Region]:[Qty]]', '$B$3:$C$6', 'LO, IC'],
    ['One[[Qty]:[Region]]', '$B$3:$C$6', 'LO; ours'],
    ['One[[Unit Price]]', '$D$3:$D$6', 'LO, IC'],
    ['One[Unit Price]', '$D$3:$D$6', 'LO; the corpus holds 2,064 such'],
    ['One[qty]', '$C$3:$C$6', 'LO, M'],
    ['one[QTY]', '$C$3:$C$6', 'LO, M'],
    ['One[[#this row],[Qty]]', '$C4', 'LO'],
    ['One[[#This Row],[Qty]]', '$C4', 'LO'],
    ['One[@Qty]', '$C4', 'M'],
    ['One[@[Unit Price]]', '$D4', 'M'],
    ['One[[#This Row],[Region]:[Qty]]', '$B4:$C4', 'LO, IC'],
    ['One[@[Region]:[Qty]]', '$B4:$C4', 'M'],
    ['One[#This Row]', '$B4:$D4', 'LO, IC'],
    ['One[@]', '$B4:$D4', 'M'],
    ['Two[#All]', '$F$2:$H$6', 'LO, IC'],
    ['Two[Qty]', '$G$3:$G$6', 'LO, IC'],
    ['Raw[A]', '$J$3:$J$6', 'LO, IC'],
    ['Raw[]', '$J$3:$K$6', 'LO, IC'],
    ['Raw[#All]', '$J$3:$K$6', 'LO'],
    ['Head[#All]', '$M$2:$N$2', 'ours: the rows the table has'],
    ['Head[#Headers]', '$M$2:$N$2', 'ours'],
    ['Head[[#Headers],[B]]', '$N$2', 'ours'],
    ['One[ [#This Row], [Qty] ]', '$C4', 'M: whitespace after [, before ] and after a comma'],
    ['One[ [Region] : [Qty] ]', '$B$3:$C$6', 'ours: whitespace around the colon too'],
    ['One[[#All],[#Data],[Qty]]', '$C$2:$C$7', 'ours: #All holds the data rows'],
    ["Odd[[Q']]]", 'Sheet2!$A$2:$A$4', 'LO, IC'],
    ["Odd[[It''s]]", 'Sheet2!$B$2:$B$4', 'LO, IC'],
    ["Odd[It''s]", 'Sheet2!$B$2:$B$4', 'the corpus: 6 such'],
    ["Odd[[x'']]", 'Sheet2!$C$2:$C$4', 'IC'],
    ["Odd[['#N]]", 'Sheet2!$D$2:$D$4', 'LO, IC'],
    ['Odd[[Unit\nPrice]]', 'Sheet2!$E$2:$E$4', 'LO'],
    ['Odd[[ Sum ]]', 'Sheet2!$F$2:$F$4', 'the corpus: 9 such'],
    ["Odd[['@a]]", 'Sheet2!$G$2:$G$4', 'M'],
    ['Odd[[@a]]', 'Sheet2!$G$2:$G$4', 'ours: an @ inside its own brackets is a name'],
    ['Odd[[a,b]]', 'Sheet2!$H$2:$H$4', 'LO'],
    ['Odd[2019]', 'Sheet2!$I$2:$I$4', 'ours'],
    ['Odd[[#Headers],[2019]]', 'Sheet2!$I$1', 'LO'],
];

// What stays as it was read, and so answers #REF!.
const UNRESOLVED: readonly (readonly [string, string, string])[] = [
    ['Two[#Totals]', 'E4', 'LO, IC: #REF! with no totals row'],
    ['Two[[#Totals],[Qty]]', 'E4', 'LO, IC'],
    ['Two[[#Data],[#Totals]]', 'E4', 'ours: a row asked for by name must be there'],
    ['Raw[#Headers]', 'E4', 'LO: #REF! with no header row'],
    ['Raw[[#Headers],[#Data]]', 'E4', 'ours'],
    ['One[Nope]', 'E4', 'LO answers #NAME?, Excel is not known: ours is #REF!'],
    ['One[[Qty]:[Nope]]', 'E4', 'ours'],
    ['One[[Nope]:[Qty]]', 'E4', 'ours: an unknown first column is no column either'],
    ['Head[A]', 'E4', 'ours: a table with no data row has no data of a column'],
    ['Head[#Data]', 'E4', 'ours'],
    ['Head[]', 'E4', 'ours'],
    ['Nope[Qty]', 'E4', 'Excel: #REF! for a table that is gone'],
    ['One[[#Headers],[#Totals]]', 'E4', 'M: no such combination'],
    ['One[[#This Row],[#Data],[Qty]]', 'E4', 'M: no such combination'],
    ['One[[Region],[Qty]]', 'E4', 'M: two columns are a range, never a list'],
    ['One[[Region]:[Qty]:[Unit Price]]', 'E4', 'M'],
    ['One[[Qty]:[#Data]]', 'E4', 'M'],
    ['One[[#Data]:[Qty]]', 'E4', 'M: a colon stands between two columns, never an item'],
    ['One[#Nothing]', 'E4', 'M: no such item'],
    ['One[[]]', 'E4', 'M'],
    ['One[[Qty],]', 'E4', 'M'],
    ['One[[Qty]x]', 'E4', 'M'],
    ['One[[#This Row],[Qty]]', 'E10', 'LO, M: #VALUE! below the table; ours is #REF!'],
    ['One[[#This Row],[Qty]]', 'E2', 'ours: the header row is no row of the data (LO reads C2)'],
    ['One[[#This Row],[Qty]]', 'E7', 'ours: nor is the totals row (LO reads C7)'],
    ['One[@Qty]', 'E1', 'M'],
    ['[Qty]', 'E20', 'ours: the cell is in no table'],
    ['[@Qty]', 'P4', 'ours'],
    ['Sheet2!Odd[2019]', 'E4', 'M: a table has no sheet prefix'],
    ['[1]!One[Qty]', 'E4', "another workbook's table is not this file's"],
];

describe('text/tables: the range a table reference stands for', () => {
    test.each(MEANINGS)('%s is %s (%s)', (text, range) => {
        expect(resolved(text)).toBe(range);
        // One cell is a cell, with no second corner, so the stored text reads back as the same tree.
        const tree = resolveTables(treeA1(`=${text}`, 'E4'), 's1', ...at('E4'), findTable);
        expect(parseStored(printStored(tree))).toEqual(tree);
    });

    test.each(UNRESOLVED)('%s at %s stays as it was read (%s)', (text, host) => {
        expect(resolved(text, host)).toBe(text);
        const tree = treeA1(`=${text}`, host);
        expect(resolveTables(tree, 's1', ...at(host), findTable)).toBe(tree);
    });

    test('with no name it is the table the cell lies in', () => {
        expect(resolved('[Qty]', 'C4')).toBe('$C$3:$C$6');
        expect(resolved('[@Qty]*[@[Unit Price]]', 'B5')).toBe('$C5*$D5');
        expect(resolved('[@]', 'G3')).toBe('$F3:$H3');
        expect(resolved('SUM([#All])', 'J4')).toBe('SUM($J$3:$K$6)');
        expect(resolved('[@2019]', 'B3', 's2')).toBe('$I3');
    });

    test('a table on another sheet is named with its sheet, and on its own sheet without', () => {
        expect(resolved('SUM(One[Qty])', 'A1', 's2')).toBe('SUM(Sheet1!$C$3:$C$6)');
        expect(resolved('Odd[2019]', 'K9', 's2')).toBe('$I$2:$I$4');
        // Excel reads this row by the row's number alone: `=T[@Qty]` on another sheet's row 4 is the table's row 4.
        expect(resolved('One[@Qty]', 'E4', 's2')).toBe('Sheet1!$C4');
        expect(resolved('Odd[@2019]', 'E3')).toBe('Sheet2!$I3');
        expect(stored('=X', 'A1')).toBe('=X');
        const tree = resolveTables(treeA1('=One[Qty]', 'A1'), 's2', 0, 0, findTable);
        expect(printStored(tree)).toBe('=[s1]!R3C3:R6C3');
        expect(tree).toMatchObject({ kind: NodeKind.Ref, sheetKind: SheetKind.Id, sheet: 's1' });
        expect(parseStored(printStored(tree))).toEqual(tree);
        const own = resolveTables(treeA1('=One[Qty]', 'A1'), 's1', 0, 0, findTable);
        expect(printA1(own, 0, 0, sheetName)).toBe('=$C$3:$C$6');
        expect(own).toMatchObject({ kind: NodeKind.Ref, sheetKind: SheetKind.Host, sheet: '' });
        expect(parseStored(printStored(own))).toEqual(own);
    });

    test('the range does not move with the formula, but for the row of this row', () => {
        const filled = (text: string, to: string) => {
            const tree = resolveTables(treeA1(`=${text}`, 'E4'), 's1', ...at('E4'), findTable);
            return printA1(tree, ...at(to), sheetName);
        };
        expect(filled('SUM(One[Qty])', 'H9')).toBe('=SUM($C$3:$C$6)');
        expect(filled('One[[#Totals],[Qty]]', 'H9')).toBe('=$C$7');
        expect(filled('One[@Qty]*2', 'H5')).toBe('=$C5*2');
        expect(filled('One[[#This Row],[Region]:[Qty]]', 'A6')).toBe('=$B6:$C6');
        // So every row of a calculated column is one shape.
        const at4 = resolveTables(treeA1('=One[@Qty]*2', 'E4'), 's1', ...at('E4'), findTable);
        const at5 = resolveTables(treeA1('=One[@Qty]*2', 'E5'), 's1', ...at('E5'), findTable);
        expect(printStored(at4)).toBe(printStored(at5));
    });

    test('everything else of the formula stays, whitespace included, and a formula with none is the same tree', () => {
        expect(resolved('SUMIF( One[Region],"x", One[Qty])+Nope[a]+A1')).toBe(
            'SUMIF( $B$3:$B$6,"x", $C$3:$C$6)+Nope[a]+A1',
        );
        const plain = treeA1('=SUM(A1:B2)+Rate');
        expect(resolveTables(plain, 's1', 0, 0, findTable)).toBe(plain);
    });

    test('resolved first, this row of one column is one cell and a column is a range to the @ pass', () => {
        const shownAt = (text: string) => {
            const parsed = parseXlsx(text, ...at('E4'), findSheet);
            if ('reason' in parsed) throw new Error(parsed.reason);
            const tree = intersect(resolveTables(parsed, 's1', ...at('E4'), findTable), FUNCTIONS);
            return printA1(tree, ...at('E4'), sheetName);
        };
        expect(shownAt('One[[#This Row],[Qty]]*One[[#This Row],[Unit Price]]')).toBe('=$C4*$D4');
        expect(shownAt('One[Qty]*2')).toBe('=@$C$3:$C$6*2');
        expect(shownAt('SUM(One[Qty])')).toBe('=SUM($C$3:$C$6)');
    });

    test('a resolved formula computes over the cells of its table', () => {
        const cells = { C3: 1, C4: 2, C5: 3, C6: 4, C7: 10, D4: 5 };
        const typed = (text: string) => `=${resolved(text)}`;
        expect(evaluate(typed('SUM(One[Qty])'), cells, 'E4')).toBe(10);
        expect(evaluate(typed('One[@Qty]*One[@[Unit Price]]'), cells, 'E4')).toBe(10);
        expect(evaluate(typed('One[[#Totals],[Qty]]'), cells, 'E4')).toBe(10);
        expect(evaluate(typed('ROWS(One[#All])*COLUMNS(One[#All])'), cells, 'E4')).toBe(18);
    });
});

describe('text/tables: against a model, over generated tables and references', () => {
    const NAMES = ['Qty', 'Net price', 'a]b', "it's", '#x', 'x[1]', 'é', ' pad ', '2019', 'A1', '@at', 'a:b', "q'"];
    // A column name as a formula writes it: a quote before each of the four characters that need one.
    const escaped = (name: string) => name.replace(/['[\]#]/g, "'$&");

    test('every cell the resolved range names is the cell the model names, and its stored text reads back as it', () => {
        const { random, chance, pick } = dice(31);
        const whole = (limit: number) => Math.floor(random() * limit);
        let ranges = 0;
        let kept = 0;
        for (let run = 0; run < 20000; run += 1) {
            const columns = [...NAMES].sort(() => random() - 0.5).slice(0, 1 + whole(6));
            const headerRows = chance(0.8) ? 1 : 0;
            const totalsRows = chance(0.3) ? 1 : 0;
            const top = whole(30);
            const left = whole(20);
            const table: Table = {
                sheet: pick(['s1', 's2']),
                top,
                left,
                bottom: top + headerRows + totalsRows + whole(8),
                right: left + columns.length - 1,
                headerRows,
                totalsRows,
                columns,
            };
            const hostSheet = pick(['s1', 's1', 's2']);
            const hostRow = Math.max(0, top - 2 + whole(table.bottom - top + 5));
            const hostColumn = chance(0.5) ? left + whole(columns.length) : left + columns.length + whole(3);
            const inside =
                hostSheet === table.sheet && hostRow >= top && hostRow <= table.bottom && hostColumn <= table.right;
            // The reference, and the rows and columns the model says it names: null where it names none.
            const first = whole(columns.length);
            const last = whole(columns.length);
            const column = pick(['none', 'one', 'one', 'range', 'missing']);
            const rows = pick([
                '',
                '',
                '#Data',
                '#All',
                '#Headers',
                '#Totals',
                '#This Row',
                '#This Row',
                'HD',
                'DT',
                'HT',
            ]);
            const named = chance(0.8) || !inside;
            const items =
                rows.length === 2
                    ? [...rows].map((letter) => ({ H: '#Headers', D: '#Data', T: '#Totals' })[letter])
                    : rows === ''
                      ? []
                      : [rows];
            const parts = items.map((item) => `[${chance(0.2) ? item?.toUpperCase() : item}]`);
            if (column === 'one') parts.push(`[${escaped(columns[first])}]`);
            if (column === 'missing') parts.push('[no such]');
            if (column === 'range')
                parts.push(`[${escaped(columns[first])}]:[${escaped(columns[last]).toUpperCase()}]`);
            const comma = chance(0.2) ? ', ' : ',';
            let inner = parts.length > 0 && chance(0.2) ? ` ${parts.join(comma)} ` : parts.join(comma);
            // One part alone may be written without brackets of its own, unless its @ would then say this row, and
            // this row may be written as an @.
            if (parts.length === 1 && column !== 'range' && !parts[0].startsWith('[@') && chance(0.5)) {
                inner = parts[0].slice(1, -1);
            }
            if (rows === '#This Row' && chance(0.5)) {
                const rest = parts.slice(1).join('');
                inner = `@${column === 'one' && chance(0.5) ? rest.slice(1, -1) : rest}`;
                // Bare after an @, a name that starts with a bracket or a # would read as something else.
                if (/^@[[#]/.test(inner) && !rest.startsWith('[')) inner = `@${rest}`;
            }
            const text = `${named ? pick(['Tbl', 'tbl', 'TBL']) : ''}[${inner}]`;
            const dataTop = top + headerRows;
            const dataBottom = table.bottom - totalsRows;
            let band: [number, number] | null = [dataTop, dataBottom];
            if (rows === '#All') band = [top, table.bottom];
            if (rows === '#Headers') band = headerRows ? [top, top] : null;
            if (rows === '#Totals') band = totalsRows ? [table.bottom, table.bottom] : null;
            if (rows === 'HD') band = headerRows ? [top, dataBottom] : null;
            if (rows === 'DT') band = totalsRows ? [dataTop, table.bottom] : null;
            if (rows === 'HT') band = null;
            if (rows === '#This Row') {
                band = hostRow >= dataTop && hostRow <= dataBottom ? [hostRow, hostRow] : null;
            }
            if (band !== null && band[0] > band[1]) band = null;
            let span: [number, number] | null = [left, table.right];
            if (column === 'one') span = [left + first, left + first];
            if (column === 'range') span = [left + Math.min(first, last), left + Math.max(first, last)];
            if (column === 'missing') span = null;

            const find: TableFinder = (name, sheet, row, col) => {
                if (name === '') {
                    const within =
                        sheet === table.sheet && row >= top && row <= table.bottom && col >= left && col <= table.right;
                    return within ? table : undefined;
                }
                return name.toLowerCase() === 'tbl' ? table : undefined;
            };
            const parsed = parseXlsx(`SUM(${text})`, hostRow, hostColumn, findSheet);
            if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason}`);
            const tree = resolveTables(parsed, hostSheet, hostRow, hostColumn, find);
            const shownText = printA1(tree, hostRow, hostColumn, sheetName).slice(5, -1);
            if (band === null || span === null) {
                if (tree !== parsed)
                    throw new Error(`run ${run}: ${text} resolved to ${shownText}, and the model names nothing`);
                kept += 1;
                continue;
            }
            const range = parseA1Range(shownText);
            if (range === null) throw new Error(`run ${run}: ${text} at row ${hostRow} stayed ${shownText}`);
            const got = [range.sheet, range.start.row, range.end.row, range.start.column, range.end.column];
            const sheet = table.sheet === hostSheet ? undefined : sheetName(table.sheet);
            expect(`${run} ${text} ${got}`).toBe(`${run} ${text} ${[sheet, band[0], band[1], span[0], span[1]]}`);
            // The tree law holds for a resolved tree: its stored text reads back as itself.
            expect(parseStored(printStored(tree))).toEqual(tree);
            // Read from another cell the columns are the same, and the rows too unless they are this row.
            const moved = parseA1Range(printA1(tree, hostRow + 3, hostColumn + 2, sheetName).slice(5, -1));
            const shift = rows === '#This Row' ? 3 : 0;
            expect([moved?.start.row, moved?.start.column]).toEqual([band[0] + shift, span[0]]);
            ranges += 1;
        }
        expect(ranges).toBeGreaterThan(8000);
        expect(kept).toBeGreaterThan(4000);
    });
});
