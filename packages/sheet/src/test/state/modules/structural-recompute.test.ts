import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { createArrayResolver } from '../../../engine/cell-resolver';
import { FormulaEngine } from '../../../engine/formula-engine';
import { FormulaGraph } from '../../../engine/formula-graph';
import { walkFormulaRefs } from '../../../engine/formula-shift';
import { recomputeAfter } from '../../../engine/recalc';
import { replaySheetsOps, SkippedRecompute } from '../../../engine/replay-ops';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from '../../../engine/rowcol';
import { copySheet } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { applyOpBatch } from '../../../state/modules/apply-ops';
import { updateCell } from '../../../state/modules/cell';
import { warmFormulaGraph } from '../../../state/modules/formula-exec';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, deleteSheet, renameSheet } from '../../../state/modules/sheet';
import type { Op, Sheet } from '../../../state/types';
import { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { contextFactory, selectionFactory } from '../factories/context';
import { cellLinks } from '../factories/links';

const n = (v: number) => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });
const f = (formula: string, v: number | string) => ({ f: formula, v, m: `${v}`, ct: { fa: 'General', t: 'n' } });

type Grid = unknown[][];
function book(...grids: { name?: string; cells: Grid }[]): Context {
    return contextFactory({
        currentSheetId: 's1',
        selections: selectionFactory([0, 0], [0, 0], 0, 0),
        sheets: grids.map(({ name, cells }, i) => ({
            name: name ?? ['One', 'Two', 'Three'][i],
            id: `s${i + 1}`,
            order: i,
            data: cells,
            row: cells.length,
            column: cells[0].length,
        })),
    } as never) as Context;
}

const at = (sheets: readonly Sheet[], id: string, r: number, c: number) =>
    sheets.find((s) => s.id === id)?.data?.[r]?.[c];

const deleteRow = (start: number, id = 's1') => ({ type: 'row', start, end: start, id }) as const;
const insertRow = (index: number, id = 's1') => ({ type: 'row', index, count: 1, direction: 'lefttop', id }) as const;

function removeRow(t: ReturnType<typeof tab>, start: number) {
    const op = deleteRow(start);
    return tabEdit(t, (d) => deleteRowCol(d, op), { deleteRowColOp: op });
}

function values(sheets: readonly Sheet[]) {
    return sheets.map((s) => s.data?.map((row) => row.map((cell) => (cell?.f ? [cell.f, cell.v, cell.m] : null))));
}

describe('a row delete', () => {
    const start = () =>
        book(
            {
                cells: [
                    [n(10), f('=A2*2', 40), f('=SUM(A1:A3)', 60), f('=SUM(A:A)', 60), f('=B1+1', 41)],
                    [n(20), null, null, null, null],
                    [n(30), null, null, null, null],
                ],
            },
            { cells: [[f('=One!A2', 20), f('=A1+1', 21), f('=One!C1', 60), f('=ROWS(One!A1:A3)', 3)]] },
        );

    test('the author, a peer and a joiner store the same text and values, from the marker alone', () => {
        const base = start();
        const author = tab(base);
        const peer = tab(base);
        const batch = removeRow(author, 1);
        expect(batch).toEqual([{ op: 'deleteRowCol', id: 's1', path: [], value: deleteRow(1) }]);
        tabReceive(peer, batch);
        const joiner = join(base, [batch]);
        for (const sheets of [author.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(at(sheets, 's1', 0, 1)?.f).toBe('=#REF!*2');
            expect(at(sheets, 's1', 0, 1)?.v).toBe('#REF!');
            expect(at(sheets, 's1', 0, 1)?.ct?.t).toBe('e');
            expect(at(sheets, 's1', 0, 2)?.f).toBe('=SUM(A1:A2)');
            expect(at(sheets, 's1', 0, 2)?.v).toBe(40);
            expect(at(sheets, 's1', 0, 2)?.m).toBe('40');
            expect(at(sheets, 's1', 0, 3)?.v).toBe(40);
            expect(at(sheets, 's1', 0, 4)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 0)?.f).toBe('=#REF!');
            expect(at(sheets, 's2', 0, 0)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 1)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 2)?.v).toBe(40);
            expect(at(sheets, 's2', 0, 3)?.v).toBe(2);
        }
        expect(values(author.ctx.sheets)).toEqual(values(joiner));
        expect(values(peer.ctx.sheets)).toEqual(values(joiner));
        expect(joiner[0].celldata?.find((e) => e.r === 0 && e.c === 2)?.v?.v).toBe(40);
    });

    test('a function around the #REF! traps it, in a recompute and in a later edit alike', () => {
        const t = tab(
            book({
                cells: [
                    [n(1), f('=IFERROR(A2,7)', 2)],
                    [n(2), null],
                ],
            }),
        );
        removeRow(t, 1);
        expect(at(t.ctx.sheets, 's1', 0, 1)?.f).toBe('=IFERROR(#REF!,7)');
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(7);
    });

    test('the next edit finds the formula graph the recompute built', () => {
        const t = tab(start());
        warmFormulaGraph(t.ctx);
        removeRow(t, 1);
        expect(t.ctx.formulaCache.graph?.formulaAt('s1', 0, 2)?.formula).toBe('=SUM(A1:A2)');
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 11);
        });
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(41);
    });
});

describe('an insert', () => {
    const start = () =>
        book({
            cells: [
                [
                    n(10),
                    f('=SUM(A1:A3)', 60),
                    f('=ROWS(A1:A3)', 3),
                    f('=INDEX(A1:A3,2)', 20),
                    f('=COUNTBLANK(A1:A3)', 0),
                ],
                [n(20), null, null, null, null],
                [n(30), f('=A3*2', 60), f('=INDEX(A1:A3,2)+1', 21), null, null],
            ],
        });

    test('a row: every function over the grown range sees the new line, on every reader', () => {
        const base = start();
        const author = tab(base);
        const op = insertRow(1);
        const batch = tabEdit(author, (d) => insertRowCol(d, op, false), { insertRowColOp: op });
        expect(batch.length).toBe(1);
        const joiner = join(base, [batch]);
        for (const sheets of [author.ctx.sheets, joiner]) {
            expect(at(sheets, 's1', 0, 1)?.v).toBe(60);
            expect(at(sheets, 's1', 0, 2)?.v).toBe(4);
            expect(at(sheets, 's1', 0, 3)?.f).toBe('=INDEX(A1:A4,2)');
            expect(at(sheets, 's1', 0, 3)?.v).toBe(0);
            expect(at(sheets, 's1', 0, 4)?.v).toBe(1);
            expect(at(sheets, 's1', 3, 1)?.v).toBe(60);
            expect(at(sheets, 's1', 3, 2)?.v).toBe(1);
        }
    });

    test('a column: a VLOOKUP into a table that grew reads the new blank column', () => {
        const t = tab(
            book({ cells: [[n(1), n(10), n(100), f('=VLOOKUP(1,A1:C1,2,FALSE)', 10), f('=SUM(A1:C1)', 111)]] }),
        );
        const op = { type: 'column', index: 1, count: 1, direction: 'lefttop', id: 's1' } as const;
        tabEdit(t, (d) => insertRowCol(d, op, false), { insertRowColOp: op });
        expect(at(t.ctx.sheets, 's1', 0, 4)?.f).toBe('=VLOOKUP(1,A1:D1,2,FALSE)');
        expect(at(t.ctx.sheets, 's1', 0, 4)?.v).toBe(0);
        expect(at(t.ctx.sheets, 's1', 0, 5)?.v).toBe(111);
    });

    test('a column delete: a reference to it is #REF!, a range across it sums what is left', () => {
        const t = tab(book({ cells: [[n(1), n(10), n(100), f('=SUM(A1:C1)', 111), f('=B1', 10)]] }));
        const op = { type: 'column', start: 1, end: 1, id: 's1' } as const;
        tabEdit(t, (d) => deleteRowCol(d, op), { deleteRowColOp: op });
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(101);
        expect(at(t.ctx.sheets, 's1', 0, 3)?.f).toBe('=#REF!');
        expect(at(t.ctx.sheets, 's1', 0, 3)?.v).toBe('#REF!');
    });
});

describe('a sheet delete', () => {
    const start = () =>
        book(
            { cells: [[n(10)]] },
            {
                cells: [
                    [
                        f('=One!A1*2', 20),
                        f('=SUM(ONE!A:A)', 10),
                        f('=A1+1', 21),
                        f("='My Sheet'!A1", 3),
                        f('=DONE!A1', '#REF!'),
                        n(5),
                    ],
                ],
            },
            { name: 'My Sheet', cells: [[n(3), f('=Two!C1', 21)]] },
        );
    const remove = (t: ReturnType<typeof tab>, id: string) =>
        tabEdit(t, (d) => deleteSheet(d, id), { deleteSheetOp: { id } });

    test('a formula naming it takes the text a row delete gives, and #REF! flows downstream on every reader', () => {
        const base = start();
        const author = tab(base);
        const peer = tab(base);
        const batch = remove(author, 's1');
        tabReceive(peer, batch);
        const joiner = join(base, [batch]);
        for (const sheets of [author.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(at(sheets, 's2', 0, 0)?.f).toBe('=#REF!*2');
            expect(at(sheets, 's2', 0, 0)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 1)?.f).toBe('=SUM(#REF!)');
            expect(at(sheets, 's2', 0, 1)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 2)?.v).toBe('#REF!');
            expect(at(sheets, 's3', 0, 1)?.v).toBe('#REF!');
            expect(at(sheets, 's2', 0, 3)?.f).toBe("='My Sheet'!A1");
            expect(at(sheets, 's2', 0, 4)?.f).toBe('=DONE!A1');
        }
        expect(values(author.ctx.sheets)).toEqual(values(joiner));
    });

    test('a quoted name is read as a name', () => {
        const t = tab(start());
        remove(t, 's3');
        expect(at(t.ctx.sheets, 's2', 0, 3)?.f).toBe('=#REF!');
        expect(at(t.ctx.sheets, 's2', 0, 3)?.v).toBe('#REF!');
        expect(at(t.ctx.sheets, 's2', 0, 0)?.f).toBe('=One!A1*2');
    });

    test('a replay rewrites a sheet no batch names, which holds only stored cells', () => {
        const stored: Sheet[] = [
            { name: 'One', id: 's1', order: 0, row: 1, column: 1, celldata: [{ r: 0, c: 0, v: n(10) }] },
            {
                name: 'Two',
                id: 's2',
                order: 1,
                row: 1,
                column: 2,
                celldata: [
                    { r: 0, c: 0, v: f('=One!A1*2', 20) },
                    { r: 0, c: 1, v: f('=A1+1', 21) },
                ],
            },
        ] as never;
        const [two] = replaySheetsOps(stored, [[{ op: 'deleteSheet', id: 's1', path: [], value: { id: 's1' } }]]);
        expect(two.celldata?.find((e) => e.c === 0)?.v?.f).toBe('=#REF!*2');
        expect(two.celldata?.find((e) => e.c === 0)?.v?.v).toBe('#REF!');
        expect(two.celldata?.find((e) => e.c === 1)?.v?.v).toBe('#REF!');
    });

    test('a new tab with the old name does not heal it', () => {
        const t = tab(start());
        remove(t, 's1');
        const value = { name: 'One', id: 's9', order: 3, data: [[n(7)]], row: 1, column: 1 } as never;
        tabEdit(t, (d) => addSheet(d, 's9', undefined, value), { addSheetOp: true });
        expect(at(t.ctx.sheets, 's2', 0, 0)?.f).toBe('=#REF!*2');
        expect(at(t.ctx.sheets, 's2', 0, 0)?.v).toBe('#REF!');
    });

    test('its undo brings the text and values back on the other tabs, as one entry, and the redo is the op again', () => {
        const base = start();
        const t = tab(base);
        const peer = tab(base);
        tabReceive(peer, remove(t, 's1'));
        expect(t.history.undoList.length).toBe(1);
        const undo = tabUndo(t);
        tabReceive(peer, undo);
        expect(t.history.undoList.length).toBe(0);
        expect(t.history.redoList.length).toBe(1);
        for (const sheets of [t.ctx.sheets, peer.ctx.sheets]) {
            expect(at(sheets, 's2', 0, 0)?.f).toBe('=One!A1*2');
            expect(at(sheets, 's2', 0, 0)?.v).toBe(20);
            expect(at(sheets, 's2', 0, 1)?.f).toBe('=SUM(ONE!A:A)');
            expect(at(sheets, 's2', 0, 2)?.v).toBe(21);
            expect(at(sheets, 's3', 0, 1)?.v).toBe(21);
        }
        const redo = tabRedo(t);
        expect(redo[0].op).toBe('deleteSheet');
        expect(at(t.ctx.sheets, 's2', 0, 0)?.f).toBe('=#REF!*2');
    });
});

describe('a name a formula holds that no sheet held', () => {
    const start = () => book({ cells: [[n(10)]] }, { cells: [[f('=Three!A1', '#REF!'), f('=One!A1*2', 20)]] });

    test('a rename onto it brings the formula to life, and a live reference keeps its value', () => {
        const base = start();
        const t = tab(base);
        const batch = tabEdit(t, (d) => renameSheet(d, { id: 's1', name: 'Three' }), { renameSheetOp: { id: 's1' } });
        for (const sheets of [t.ctx.sheets, join(base, [batch])]) {
            expect(at(sheets, 's2', 0, 0)?.v).toBe(10);
            expect(at(sheets, 's2', 0, 1)?.f).toBe('=Three!A1*2');
            expect(at(sheets, 's2', 0, 1)?.v).toBe(20);
        }
    });

    test('an added sheet with it does too', () => {
        const base = start();
        const t = tab(base);
        const value = { name: 'Three', id: 's3', order: 2, data: [[n(7)]], row: 1, column: 1 } as never;
        const batch = tabEdit(t, (d) => addSheet(d, 's3', undefined, value), { addSheetOp: true });
        for (const sheets of [t.ctx.sheets, join(base, [batch])]) expect(at(sheets, 's2', 0, 0)?.v).toBe(7);
    });
});

describe('a row op`s undo', () => {
    test('restores every text and value, a third sheet reading a value included, on a peer too', () => {
        const base = book(
            {
                cells: [
                    [n(10), f('=A2*2', 40), f('=SUM(A1:A3)', 60), f('=ROWS(A1:A3)', 3)],
                    [n(20), null, null, null],
                    [n(30), null, null, null],
                ],
            },
            { cells: [[f('=One!C1', 60), f('=A1+1', 61)]] },
            { cells: [[f('=Two!B1', 61), f('=One!B1', 40)]] },
        );
        const t = tab(base);
        const peer = tab(base);
        tabReceive(peer, removeRow(t, 1));
        expect(at(t.ctx.sheets, 's3', 0, 1)?.v).toBe('#REF!');
        const undo = tabUndo(t);
        tabReceive(peer, undo);
        const joiner = join(base, [[{ op: 'deleteRowCol', id: 's1', path: [], value: deleteRow(1) }], undo]);
        for (const sheets of [t.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(at(sheets, 's1', 0, 1)?.f).toBe('=A2*2');
            expect(at(sheets, 's1', 0, 1)?.v).toBe(40);
            expect(at(sheets, 's1', 0, 2)?.f).toBe('=SUM(A1:A3)');
            expect(at(sheets, 's1', 0, 2)?.v).toBe(60);
            expect(at(sheets, 's1', 0, 3)?.v).toBe(3);
            expect(at(sheets, 's2', 0, 1)?.v).toBe(61);
            expect(at(sheets, 's3', 0, 0)?.v).toBe(61);
            expect(at(sheets, 's3', 0, 1)?.v).toBe(40);
        }
        tabRedo(t);
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(40);
    });

    // The forward delete changes no value on Three, so its entry records nothing of it, and only a recompute after the
    // repairs can bring back what the marker alone would disturb.
    test('leaves a sheet the delete never changed as it was', () => {
        const base = book(
            {
                cells: [
                    [n(10), f('=COUNTBLANK(A1:A3)', 0)],
                    [n(20), null],
                    [n(30), null],
                ],
            },
            { cells: [[f('=One!B1', 0)]] },
        );
        const t = tab(base);
        const peer = tab(base);
        tabReceive(peer, removeRow(t, 1));
        tabReceive(peer, tabUndo(t));
        for (const sheets of [t.ctx.sheets, peer.ctx.sheets]) {
            expect(at(sheets, 's1', 0, 1)?.v).toBe(0);
            expect(at(sheets, 's2', 0, 0)?.v).toBe(0);
        }
    });
});

describe('an operator over a range', () => {
    const start = () =>
        book({
            cells: [
                [n(1), n(10), f('=SUMPRODUCT(A1:A3*B1:B3)', 777), f('=C1+1', 778), f('=SUM(A1:A3)', 6)],
                [n(2), n(20), null, null, null],
                [n(3), n(30), null, null, null],
            ],
        });

    test('keeps its stored number on a row insert, and a reader reads that', () => {
        const op = insertRow(1);
        const t = tab(start());
        tabEdit(t, (d) => insertRowCol(d, op), { insertRowColOp: op });
        expect(at(t.ctx.sheets, 's1', 0, 2)?.f).toBe('=SUMPRODUCT(A1:A4*B1:B4)');
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(777);
        expect(at(t.ctx.sheets, 's1', 0, 3)?.v).toBe(778);
        expect(at(t.ctx.sheets, 's1', 0, 4)?.f).toBe('=SUM(A1:A4)');
        const replayed = replaySheetsOps(
            [{ id: 's1', name: 'One', order: 0, data: start().sheets[0].data }],
            [[{ op: 'insertRowCol', id: 's1', path: [], value: op }]],
        );
        expect(at(replayed, 's1', 0, 2)?.v).toBe(777);
    });

    test('keeps its stored number on an edit of what it reads', () => {
        const t = tab(start());
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 5);
        });
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(777);
        expect(at(t.ctx.sheets, 's1', 0, 3)?.v).toBe(778);
        expect(at(t.ctx.sheets, 's1', 0, 4)?.v).toBe(10);
    });

    test('typed, with no number to keep, it shows #CALC!', () => {
        const t = tab(start());
        tabEdit(t, (d) => {
            updateCell(d, 1, 3, null, '=SUMPRODUCT(A1:A3*B1:B3)');
        });
        const cell = at(t.ctx.sheets, 's1', 1, 3);
        expect(cell?.v).toBe('#CALC!');
        expect(cell?.m).toBe('#CALC!');
        expect(cell?.ct?.t).toBe('e');
    });
});

describe('what a recompute keeps', () => {
    test('an AVERAGEIF over the blank row an insert opened ignores it, on the replay', () => {
        const sheets: Sheet[] = [
            {
                id: 's1',
                name: 'One',
                order: 0,
                data: [[n(1), f('=AVERAGEIF(A1:A3,">1")', 2.5)], [n(2)], [n(3)]],
            },
        ];
        const op: Op = { op: 'insertRowCol', id: 's1', path: [], value: insertRow(1) };
        const [one] = replaySheetsOps(sheets, [[op]]);
        expect(at([one], 's1', 0, 1)?.f).toBe('=AVERAGEIF(A1:A4,">1")');
        expect(at([one], 's1', 0, 1)?.v).toBe(2.5);
    });

    test('a formula this build cannot evaluate keeps its stored number, on a row op and on an edit', () => {
        const base = book({
            cells: [
                [n(1), f('=FILTER(A1:A2,A1:A2>0)', 77), f('=B1+1', 78), f('=OFFSET(A1,0,0)', 5), f('=ROW(A1)', 1)],
                [n(2), f('=SUM(Tbl[Amount],A1:A2)', 88), f('=UNDEFINEDNAME+A2', 9), f('=ROWS(A1:A2)', 2), null],
            ],
        });
        const t = tab(base);
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 5);
        });
        const read = (r: number, c: number) => at(t.ctx.sheets, 's1', r, c)?.v;
        expect(read(0, 1)).toBe(77);
        expect(read(0, 2)).toBe(78);
        expect(read(0, 3)).toBe(5);
        expect(read(0, 4)).toBe(1);
        expect(read(1, 1)).toBe(88);

        const op = insertRow(1);
        tabEdit(t, (d) => insertRowCol(d, op, false), { insertRowColOp: op });
        expect(read(0, 1)).toBe(77);
        expect(read(0, 2)).toBe(78);
        expect(read(0, 3)).toBe(5);
        expect(read(0, 4)).toBe(1);
        expect(read(2, 1)).toBe(88);
        expect(read(2, 2)).toBe(9);
        expect(read(2, 3)).toBe(3);
    });

    test('a formula reading a typo computes the #NAME? the typo shows', () => {
        const t = tab(book({ cells: [[f('=5', 5), f('=A1', 5), f('=IF(A1>0,A1+1,FILTER(A1:A1,1))', 6)]] }));
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, '=FILTRE(1)');
        });
        expect(at(t.ctx.sheets, 's1', 0, 0)?.v).toBe('#NAME?');
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe('#NAME?');
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(6);
    });

    test('a function only Google or a stub answers is one this build lacks, typed or read', () => {
        const engine = tab(book({ cells: [[n(1)]] })).ctx.formulaCache.engine;
        const resolver = createArrayResolver([]);
        for (const formula of ['=ROW()', '=ROW(A1)', '=COLUMN(A1)', '=CELL("row",A1)', '=IFERROR(ROW(),1)']) {
            expect(engine.evaluate(formula, 's1', resolver).value).toBe('#NAME?');
        }
    });

    test('a branch this build can compute recalculates beside one it lacks', () => {
        const t = tab(book({ cells: [[n(1), f('=IF(A1>0,A1+1,FILTER(A1:A1,1))', 2)]] }));
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 4);
        });
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(5);
    });

    test('an error the formula really computes replaces its number', () => {
        const t = tab(
            book({
                cells: [
                    [n(2), f('=1/SUM(A2:A3)', 0.1)],
                    [n(10), null],
                    [n(0), null],
                ],
            }),
        );
        removeRow(t, 1);
        expect(at(t.ctx.sheets, 's1', 0, 1)?.f).toBe('=1/SUM(A2)');
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe('#DIV/0!');
    });

    test('a volatile cell keeps its stored value through a structural op, and a reader reads that', () => {
        const base = book({
            cells: [
                [n(1), f('=RAND()+SUM(A1:A2)', 0.5), f('=B1*2', 1), f('=SUM(A1:A2)', 3)],
                [n(2), null, null, null],
            ],
        });
        const t = tab(base);
        const batch = removeRow(t, 1);
        for (const sheets of [t.ctx.sheets, join(base, [batch])]) {
            expect(at(sheets, 's1', 0, 1)?.v).toBe(0.5);
            expect(at(sheets, 's1', 0, 2)?.v).toBe(1);
            expect(at(sheets, 's1', 0, 3)?.v).toBe(1);
        }
    });

    test('past a budget the values stay, the op stands and the recompute is reported', () => {
        const base = book({
            cells: [
                [n(10), f('=SUM(A1:A3)', 60)],
                [n(20), null],
                [n(30), null],
            ],
        });
        const dropped: unknown[] = [];
        const [sheet] = replaySheetsOps(
            base.sheets,
            [[{ op: 'deleteRowCol', id: 's1', path: [], value: deleteRow(1) }]],
            (e) => dropped.push(e),
            { maxCellsRead: 1 },
        );
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toBeInstanceOf(SkippedRecompute);
        expect(sheet.data?.length).toBe(2);
        expect(sheet.data?.[0][1]?.f).toBe('=SUM(A1:A2)');
        expect(sheet.data?.[0][1]?.v).toBe(60);
    });
});

describe('the log alone decides the values', () => {
    const start = () =>
        book({
            cells: [
                [n(1), f('=SUM(A2:A3)', 50), f('=ROWS(A1:A4)', 4)],
                [n(20), null, null],
                [n(30), null, null],
                [n(40), null, null],
            ],
        });

    test('a tab that applied its op first and takes a peer`s the log puts before it ends as a joiner does', () => {
        const base = start();
        const mine = tab(base);
        const theirs = tab(base);
        const myBatch = removeRow(mine, 1);
        const theirBatch = removeRow(theirs, 0);
        const log = [theirBatch, myBatch];

        let next = mine.ctx;
        const apis = generateAPIs(
            () => next,
            (recipe: (draft: Context) => void) => {
                next = produce(next, recipe);
            },
            () => {},
            () => {},
            mine.history,
        );
        apis.replayOps(base.sheets, log, new Set([theirBatch]));

        tabReceive(theirs, myBatch);
        const joiner = join(base, log);
        expect(values(next.sheets)).toEqual(values(joiner));
        expect(values(theirs.ctx.sheets)).toEqual(values(joiner));
    });
});

// On random workbooks, what the seeds reach lands on what evaluating every formula lands on.
describe('the seeds are enough', () => {
    const rng = (seed: number) => {
        let x = seed;
        return (max: number) => {
            x = (x * 1664525 + 1013904223) % 4294967296;
            return Math.floor((x / 4294967296) * max);
        };
    };
    const ROWS = 12;
    const COLUMNS = 6;
    const col = (c: number) => String.fromCharCode(65 + c);
    // A formula reads only columns left of its own, and Two may read One but not the reverse, so nothing is a cycle.
    function randomFormula(pick: (m: number) => number, sheet: number, column: number) {
        const own = () => col(pick(column));
        const any = () => col(pick(COLUMNS));
        const cell = () => `${own()}${pick(ROWS) + 1}`;
        const span = (c: string) => {
            const a = pick(ROWS - 1) + 1;
            return `${c}${a}:${c}${a + 1 + pick(ROWS - a)}`;
        };
        const range = () => span(own());
        const whole = () => {
            const c = own();
            return `${c}:${c}`;
        };
        switch (pick(sheet === 1 ? 14 : 11)) {
            case 0:
                return `=${cell()}`;
            case 1:
                return `=SUM(${range()})`;
            case 2:
                return `=ROWS(${range()})`;
            case 3:
                return `=INDEX(${range()},2)`;
            case 4:
                return `=COUNTBLANK(${range()})`;
            case 5:
                return `=SUM(${whole()})`;
            case 6:
                return `=${cell()}+${cell()}`;
            case 7:
                return `=MATCH(1,${range()},0)`;
            case 8:
                return `=COUNT(${whole()})`;
            case 9:
                return `=AVERAGE(${range()})`;
            case 10:
                return `=IFERROR(${cell()},1)`;
            case 11:
                return `=One!${any()}${pick(ROWS) + 1}`;
            case 12:
                return `=SUM(One!${span(any())})`;
            default:
                return `=INDEX(One!${span(any())},3)`;
        }
    }
    function randomBook(seed: number) {
        const pick = rng(seed);
        const sheet = (name: string, id: string, order: number, index: number): Sheet =>
            ({
                name,
                id,
                order,
                row: ROWS,
                column: COLUMNS,
                data: Array.from({ length: ROWS }, () =>
                    Array.from({ length: COLUMNS }, (_, c) => {
                        const k = pick(10);
                        if (k < 4 || c === 0) return k < 8 ? n(pick(9) + 1) : null;
                        return k < 7 ? f(randomFormula(pick, index, c), 0) : null;
                    }),
                ),
            }) as never;
        return { pick, sheets: [sheet('One', 's1', 0, 0), sheet('Two', 's2', 1, 1)] };
    }
    const everyFormula = { cells: [], lines: [], reads: () => true };
    const recomputeAll = (sheets: Sheet[]) =>
        recomputeAfter(sheets, everyFormula, new FormulaGraph(sheets), new FormulaEngine());

    test('300 random workbooks and row or column ops', () => {
        let wrong = 0;
        let changed = 0;
        for (let seed = 1; seed <= 300; seed += 1) {
            const { sheets, pick } = randomBook(seed * 7919);
            const settled = recomputeAll(recomputeAll(sheets));
            const type = pick(2) === 0 ? ('row' as const) : ('column' as const);
            const line = pick(type === 'row' ? ROWS : COLUMNS);
            const id = pick(2) === 0 ? 's1' : 's2';
            const op: Op =
                pick(2) === 0
                    ? { op: 'insertRowCol', id, path: [], value: { type, index: line, count: 1, direction: 'lefttop' } }
                    : { op: 'deleteRowCol', id, path: [], value: { type, start: line, end: line } };
            const seeded = replaySheetsOps(settled, [[op]]);
            const moved =
                op.op === 'insertRowCol'
                    ? applySheetsInsertRowCol(settled, { ...op.value, id })
                    : applySheetsDeleteRowCol(settled, { ...op.value, id });
            const all = recomputeAll(recomputeAll(moved));
            if (JSON.stringify(values(moved)) !== JSON.stringify(values(all))) changed += 1;
            if (JSON.stringify(values(seeded)) !== JSON.stringify(values(all))) wrong += 1;
        }
        expect(wrong).toBe(0);
        expect(changed).toBeGreaterThan(100);
    }, 60_000);
});

describe('an added tab ships no values', () => {
    // Two is first so a typed edit lands on it. The add brings a broken name to life, so the author's recompute writes.
    const start = () => book({ name: 'Two', cells: [[f('=Three!A1', '#REF!'), n(1), null]] });
    const addThree = (t: ReturnType<typeof tab>) => {
        const value = { name: 'Three', id: 's3', order: 1, data: [[n(7)]], row: 1, column: 1 } as never;
        return tabEdit(t, (d) => addSheet(d, 's3', undefined, value), { addSheetOp: true });
    };

    test('its batch is the sheet alone, whatever the recompute wrote', () => {
        const t = tab(start());
        const batch = addThree(t);
        expect(at(t.ctx.sheets, 's1', 0, 0)?.v).toBe(7);
        expect(batch.map((op) => op.op)).toEqual(['addSheet']);
    });

    test('a peer`s edit the log puts before it survives on the author, the peer and a joiner', () => {
        const base = start();
        const author = tab(base);
        const peer = tab(base);
        const add = addThree(author);
        const typed = tabEdit(peer, (d) => {
            updateCell(d, 0, 2, null, 123);
        });
        tabReceive(author, typed);
        tabReceive(peer, add);
        const joiner = join(base, [typed, add]);
        for (const sheets of [author.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(at(sheets, 's1', 0, 2)?.v).toBe(123);
            expect(at(sheets, 's1', 0, 0)?.v).toBe(7);
        }
    });

    test('a peer`s row insert the log puts before it survives on the author, the peer and a joiner', () => {
        const base = start();
        const author = tab(base);
        const peer = tab(base);
        const add = addThree(author);
        const op = insertRow(0);
        const inserted = tabEdit(peer, (d) => insertRowCol(d, op, false), { insertRowColOp: op });
        tabReceive(author, inserted);
        tabReceive(peer, add);
        const joiner = join(base, [inserted, add]);
        for (const sheets of [author.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(sheets[0].data?.length).toBe(2);
            expect(at(sheets, 's1', 1, 0)?.f).toBe('=Three!A1');
            expect(at(sheets, 's1', 1, 0)?.v).toBe(7);
            expect(at(sheets, 's1', 1, 1)?.v).toBe(1);
        }
    });

    test('a copy of a tab ships its add and the orders it moved', () => {
        const t = tab(book({ cells: [[n(1)]] }, { cells: [[n(2)]] }));
        const batch = tabEdit(t, (d) => copySheet(d, 's1'), { addSheetOp: true });
        expect(batch.map((op) => [op.op, op.path.join('.')])).toEqual([
            ['addSheet', ''],
            ['replace', 'order'],
        ]);
    });
});

describe('an error typed into a formula', () => {
    const LITERALS = ['#N/A', '#DIV/0!', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!'];

    test.each(LITERALS)('%s is a token, so a formula holding it computes on an edit', (literal) => {
        const t = tab(book({ cells: [[n(2), f(`=IF(A1=1,${literal},A1*2)`, 4)]] }));
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 5);
        });
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(10);
    });

    test.each(LITERALS)('%s stays as it is through a walk, and names no ref', (literal) => {
        const refs: string[] = [];
        const names: string[] = [];
        const text = walkFormulaRefs(
            `=A1+${literal}+B2`,
            (ref) => {
                refs.push(ref);
                return ref;
            },
            (name) => {
                names.push(name);
                return name;
            },
        );
        expect(text).toBe(`A1+${literal}+B2`);
        expect(refs).toEqual(['A1', 'B2']);
        expect(names.filter(Boolean)).toEqual([]);
    });

    test('a sheet named in front of #REF! stays one leaf, as Excel writes it', () => {
        const refs: string[] = [];
        const text = walkFormulaRefs('=Sheet1!#REF!+B2', (ref) => {
            refs.push(ref);
            return ref;
        });
        expect(text).toBe('Sheet1!#REF!+B2');
        expect(refs).toEqual(['B2']);
    });
});

describe('a long formula', () => {
    test('a forged long name costs what its length does when the engine asks what it lacks', () => {
        const engine = tab(book({ cells: [[n(1)]] })).ctx.formulaCache.engine;
        const formula = `=${'a'.repeat(400_000)}&FILTRE(1)&"#REF!"`;
        const started = performance.now();
        expect(engine.cantEvaluate(formula, { value: '#NAME?' })).toBe(true);
        // Quadratic takes minutes at this size and linear a few milliseconds, so no load makes this flake.
        expect(performance.now() - started).toBeLessThan(10_000);
    });
});

describe('a long forged formula', () => {
    const size = 100_000;
    const costs = (formula: string) => {
        const t = tab(book({ cells: [[n(1), f(formula, 9)]] }));
        const started = performance.now();
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 5);
        });
        removeRow(t, 0);
        // Quadratic takes minutes at this size and linear milliseconds.
        expect(performance.now() - started).toBeLessThan(20_000);
    };

    test.each([
        ['a name of dots', `=${'a.'.repeat(size)}`],
        ['dots', `=${'.'.repeat(size)}`],
        ['open quotes', `=${"'".repeat(size + 1)}`],
        ['a sheet name before a chain of ranges', `='${'a'.repeat(size)}'!${'A1:'.repeat(size / 3)}A1`],
    ])('%s costs what its length does', (_, formula) => {
        costs(formula);
    });

    test('one past Excel`s limit keeps its number', () => {
        const t = tab(book({ cells: [[n(1), f(`=A1+${'1+'.repeat(5000)}1`, 9)]] }));
        warmFormulaGraph(t.ctx);
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 5);
        });
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(9);
    });
});

describe('a formula holding #REF!', () => {
    const removed = (formula: string, stored: number) => {
        const t = tab(
            book({
                cells: [
                    [n(1), f(formula, stored)],
                    [n(42), null],
                ],
            }),
        );
        removeRow(t, 1);
        return at(t.ctx.sheets, 's1', 0, 1);
    };

    test('=A2% with row 2 deleted shows #REF!', () => {
        const cell = removed('=A2%', 0.42);
        expect(cell?.f).toBe('=#REF!%');
        expect(cell?.v).toBe('#REF!');
    });

    test('a range ending at a function, whose first leg broke, shows #REF!', () => {
        const cell = removed('=SUM(A2:INDEX(A1:A2,1))', 43);
        expect(cell?.f).toBe('=SUM(#REF!:INDEX(A1,1))');
        expect(cell?.v).toBe('#REF!');
    });

    test('beside a name this build cannot read it still shows #REF!', () => {
        expect(removed('=A2+UNKNOWNNAME', 5)?.v).toBe('#REF!');
    });

    test('inside a function this build lacks it shows #REF!, as Excel does', () => {
        expect(removed('=_xlfn.NEWFN(A2)', 5)?.v).toBe('#REF!');
        expect(removed('=FILTER(A2,1)', 5)?.v).toBe('#REF!');
        expect(removed('=SUM(FILTER(A2,1))', 5)?.v).toBe('#REF!');
        expect(removed('=IFERROR(FILTER(A2,1),7)', 5)?.v).toBe(7);
        expect(removed('=IF(TRUE,1,FILTER(A2,1))', 5)?.v).toBe(1);
    });

    test('a function this build lacks with no #REF! in hand keeps the number', () => {
        expect(removed('=FILTER(A1,1)', 5)?.v).toBe(5);
    });
});

describe('a percent sign', () => {
    const value = (formula: string) => {
        const resolver = createArrayResolver([
            { id: 's1', name: 'One', data: [[n(50), { v: 'a', m: 'a', ct: { fa: 'General', t: 's' } }, null]] },
        ]);
        return tab(book({ cells: [[n(1)]] })).ctx.formulaCache.engine.evaluate(formula, 's1', resolver).value;
    };

    test.each([
        ['=50%', 0.5],
        ['=A1%', 0.5],
        ['=(A1+50)%', 1],
        ['=SUM(A1,50)%', 1],
        ['=A1%*2', 1],
        ['=2*A1%', 1],
        ['=1+A1%', 1.5],
        ['=-A1%', -0.5],
        ['=A1%%', 0.005],
        ['=2^A1%', Math.SQRT2],
        ['=A1%&"x"', '0.5x'],
        ['=SUM(A1%,1%)', 0.51],
        ['=C1%', 0],
        ['=57%', 0.57],
        ['=B1%', '#VALUE!'],
        ['=#N/A%', '#N/A'],
    ])('%s', (formula, expected) => {
        const result = value(formula);
        if (typeof expected === 'number') expect(result).toBeCloseTo(expected, 10);
        else expect(result).toBe(expected);
    });
});

describe('an undo over a function this build lacks', () => {
    test('keeps the recorded number, on the author, a peer and a joiner', () => {
        const base = book({ cells: [[n(1), f('=FILTER(A1:A1,1)', 77), f('=B1+1', 78)]] });
        const t = tab(base);
        const peer = tab(base);
        const typed = tabEdit(t, (d) => {
            updateCell(d, 0, 1, null, 5);
        });
        tabReceive(peer, typed);
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(5);
        const undo = tabUndo(t);
        tabReceive(peer, undo);
        const joiner = join(base, [typed, undo]);
        for (const sheets of [t.ctx.sheets, peer.ctx.sheets, joiner]) {
            expect(at(sheets, 's1', 0, 1)?.f).toBe('=FILTER(A1:A1,1)');
            expect(at(sheets, 's1', 0, 1)?.v).toBe(77);
            expect(at(sheets, 's1', 0, 2)?.v).toBe(78);
        }
    });

    test('a formula this build can compute takes today`s inputs, not the recorded number', () => {
        const t = tab(book({ cells: [[n(1), f('=A1*2', 2)]] }));
        tabEdit(t, (d) => {
            updateCell(d, 0, 1, null, 5);
        });
        const [typed] = t.history.undoList;
        tabEdit(t, (d) => {
            updateCell(d, 0, 0, null, 10);
        });
        t.history.undoList = [typed];
        tabUndo(t);
        expect(at(t.ctx.sheets, 's1', 0, 1)?.f).toBe('=A1*2');
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(20);
    });
});

describe('one cell where a range was', () => {
    const value = (formula: string) => {
        const resolver = createArrayResolver([
            {
                id: 's1',
                name: 'One',
                data: [
                    [n(1), n(2)],
                    [n(3), n(4)],
                ],
            },
        ]);
        return tab(book({ cells: [[n(1)]] })).ctx.formulaCache.engine.evaluate(formula, 's1', resolver).value;
    };

    test.each([
        ['=ROWS(A1)', 1],
        ['=COLUMNS(A1)', 1],
        ['=ROWS(A1:A2)', 2],
        ['=COLUMNS(A1:B1)', 2],
        ['=ROWS(A1:B2)', 2],
        ['=COLUMNS(A1:B2)', 2],
        ['=ROWS(5)', 1],
        ['=ROWS(#REF!)', '#REF!'],
    ])('%s is %p', (formula, expected) => {
        expect(value(formula)).toBe(expected);
    });

    test('a range the shift cut to one cell answers 1', () => {
        const t = tab(
            book({
                cells: [
                    [n(1), f('=ROWS(A1:A2)', 2), f('=COLUMNS(A1:A2)', 1)],
                    [n(2), null, null],
                ],
            }),
        );
        removeRow(t, 1);
        expect(at(t.ctx.sheets, 's1', 0, 1)?.v).toBe(1);
        expect(at(t.ctx.sheets, 's1', 0, 2)?.v).toBe(1);
    });
});

describe('a function with a one-letter name', () => {
    const value = (formula: string) => {
        const resolver = createArrayResolver([{ id: 's1', name: 'One', data: [[n(5)]] }]);
        return tab(book({ cells: [[n(1)]] })).ctx.formulaCache.engine.evaluate(formula, 's1', resolver).value;
    };

    test.each([
        ['=N(1)', 1],
        ['=N(A1)', 5],
        ['=T("a")', 'a'],
        ['=n(A1)+1', 6],
        ['=A(1)', '#NAME?'],
        ['=A1', 5],
        ['=SUM(A:A)', 5],
    ])('%s is %p', (formula, expected) => {
        expect(value(formula)).toBe(expected);
    });
});

describe('a deleted sheet`s name', () => {
    test('a list source and a link naming it break as a formula does', () => {
        const toRange = { ...f('=One!A1', 10), link: { type: 'cellrange', address: 'One!A1:B2' } };
        const toSheet = { ...n(1), link: { type: 'sheet', address: 'One' } };
        const toPage = { ...n(2), link: { type: 'webpage', address: 'One' } };
        const base = book({ cells: [[n(10)]] }, { name: 'Two', cells: [[toRange, toSheet, toPage]] });
        const withTexts = produce(base, (d: Context) => {
            d.sheets[1].dataValidations = {
                list: {
                    ranges: [{ row: [0, 0], column: [1, 1] }],
                    rule: { type: 'dropdown', type2: '', value1: 'One!$A$1:$A$3', value2: '' },
                },
                plain: {
                    ranges: [{ row: [0, 0], column: [1, 1] }],
                    rule: { type: 'dropdown', type2: '', value1: 'One,Two', value2: '' },
                },
            } as never;
        });
        const t = tab(withTexts);
        const batch = tabEdit(t, (d) => deleteSheet(d, 's1'), { deleteSheetOp: { id: 's1' } });
        for (const [two] of [t.ctx.sheets, join(withTexts, [batch])]) {
            expect(two.dataValidations?.list.rule.value1).toBe('#REF!');
            expect(two.dataValidations?.plain.rule.value1).toBe('One,Two');
            expect(cellLinks(two)).toEqual({
                '0_0': { type: 'cellrange', address: '#REF!' },
                '0_1': { type: 'sheet', address: '#REF!' },
                '0_2': toPage.link,
            });
        }
        tabUndo(t);
        const two = t.ctx.sheets.find((sheet) => sheet.id === 's2');
        expect(two?.dataValidations?.list.rule.value1).toBe('One!$A$1:$A$3');
        expect(at(t.ctx.sheets, 's2', 0, 0)?.link).toEqual(toRange.link);
        expect(at(t.ctx.sheets, 's2', 0, 1)?.link).toEqual(toSheet.link);
    });
});

describe('a forged add', () => {
    test.each([
        ['a matrix that is no list', { data: { length: 5 } }],
        ['a row that is no list', { data: [{ length: 1 }] }],
        ['a cell list that is no list', { celldata: { length: 5 } }],
    ])('%s: the replay and a tab skip it alike', (_, forged) => {
        const base = book({ cells: [[n(1)]] });
        const op: Op = { op: 'addSheet', id: 's9', path: [], value: { name: 'Nine', id: 's9', order: 1, ...forged } };
        const applied = applyOpBatch(tab(base).ctx, [op]);
        expect(join(base, [[op]]).map((s) => s.id)).toEqual(['s1']);
        expect(applied?.ctx.sheets.map((s) => s.id)).toEqual(['s1']);
    });
});
