import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { EditRefusal, Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS, MAX_STORED_LENGTH, sheetFinder, storedText } from '../../text';
import { at } from './support';

// A formula that works a reference out at run time, as OFFSET and INDIRECT do, is computed again when a cell of
// the areas it last resolved is written, and not when another cell is. Two things are pinned for every way such an
// area comes or changes: the values equal a fresh load of the same cells, fully recalculated, and a write to a
// cell that no area of a formula holds leaves the formula alone.

const NO_CAP = Number.POSITIVE_INFINITY;

// What is typed into a cell: a text that starts with = is a formula.
type Typed = number | string | boolean | null;
type Tab = { readonly id: string; readonly name: string };

// The first sheet of every book: its formula is the first a pass computes, and `poke` writes the cell it reads.
const FIRST = { A1: '=B1' };

class Book {
    public tabs: Tab[];
    public engine: Engine;
    private now = 45000;
    private seed = 1;
    private pokes = 0;

    // Sheets by name, each with the id of its name in lower case, behind the sheet `first`. Never computed.
    public constructor(sheets: Readonly<Record<string, Readonly<Record<string, Typed>>>>) {
        const all = { First: FIRST, ...sheets };
        this.tabs = Object.keys(all).map((name) => ({ id: name.toLowerCase(), name }));
        this.engine = new Engine(
            Object.entries(all).map(([name, cells]) => this.source(name, cells)),
            this.now,
            this.seed,
            false,
        );
        this.engine.recalc(NO_CAP);
    }

    public source(name: string, cells: Readonly<Record<string, Typed>>): SheetSource {
        return {
            id: name.toLowerCase(),
            name,
            cells: (cell) => {
                for (const [label, typed] of Object.entries(cells)) {
                    const [row, column] = at(label);
                    if (typeof typed === 'string' && typed.startsWith('=')) {
                        cell(row, column, null, this.stored(typed, row, column));
                    } else cell(row, column, typed, null);
                }
            },
        };
    }

    public set(sheet: string, label: string, typed: Typed): void {
        const [row, column] = at(label);
        if (typed === null) this.engine.clear(sheet, row, column);
        else if (typeof typed === 'string' && typed.startsWith('=')) {
            this.engine.setFormula(sheet, row, column, this.stored(typed, row, column));
        } else this.engine.setValue(sheet, row, column, typed);
    }

    public value(sheet: string, label: string): unknown {
        const value = this.engine.valueOf(sheet, ...at(label));
        return typeof value === 'object' && value !== null ? value.text : value;
    }

    // Loads what the engine holds again, with its values, as a full pass computed them.
    public reload(): void {
        expect(this.engine.settled()).toBe(true);
        this.engine = new Engine(this.walk(this.engine, true), this.now, this.seed, true);
    }

    public clock(): void {
        this.now += 0.25;
        this.seed += 1;
        this.engine.setClock(this.now, this.seed);
    }

    // The cells that differ from a fresh load of the same cells, once both are computed to the end.
    public stale(): string[] {
        while (this.engine.recalc(NO_CAP).stopped);
        const fresh = new Engine(this.walk(this.engine, false), this.now, this.seed, false);
        fresh.recalc(NO_CAP);
        const differ: string[] = [];
        for (const { id, name } of this.tabs) {
            for (let column = 0; column <= fresh.lastColumn(id); column += 1) {
                for (let row = 0; row <= fresh.lastRow(id); row += 1) {
                    const held = shown(this.engine.valueOf(id, row, column));
                    const expected = shown(fresh.valueOf(id, row, column));
                    if (held !== expected) differ.push(`${name} ${row},${column} holds ${held}, fresh ${expected}`);
                }
            }
        }
        return differ;
    }

    // Which of some cells of a sheet the next marking flags, after `write`. A pass capped at 0 marks, computes the
    // first formula, which the poke makes the one on the first sheet, and stops before any other.
    public flagged(sheet: string, labels: readonly string[], write: () => void): string[] {
        expect(this.stale()).toEqual([]);
        write();
        this.pokes += 1;
        this.engine.setValue('first', 0, 1, this.pokes);
        this.engine.recalc(0);
        const found = labels.filter((label) => this.engine.isPending(sheet, ...at(label)));
        expect(this.stale()).toEqual([]);
        return found;
    }

    private stored(typed: string, row: number, column: number): string {
        return storedText(typed, row, column, sheetFinder(this.tabs));
    }

    private walk(engine: Engine, values: boolean): SheetSource[] {
        return this.tabs.map(({ id, name }) => ({
            id,
            name,
            cells: (cell) =>
                engine.cells(id, (row, column, value, formula) =>
                    cell(row, column, formula !== null && !values ? null : value, formula),
                ),
        }));
    }
}

function shown(value: Literal | null): string {
    return typeof value === 'object' && value !== null ? value.text : `${typeof value} ${String(value)}`;
}

// The values after a step, by its name: none differs from a fresh load.
function holds(book: Book, step: string): void {
    expect({ step, stale: book.stale() }).toEqual({ step, stale: [] });
}

describe('the values of formulas that resolve a reference equal a fresh load', () => {
    test('after a computed load, which ran no formula and so recorded no area', () => {
        const book = new Book({
            S: { A1: 1, A2: 2, A3: 3, B1: 1, C1: '=OFFSET(A1,B1,0)', C2: '=SUM(INDIRECT("A1:A3"))', C3: '=C1+C2' },
        });
        book.reload();
        book.set('s', 'A2', 20);
        holds(book, 'a write into the area OFFSET and INDIRECT resolved');
        expect([book.value('s', 'C1'), book.value('s', 'C2'), book.value('s', 'C3')]).toEqual([20, 24, 44]);
        book.reload();
        book.engine.recalc(2);
        book.set('s', 'A3', 30);
        book.engine.recalc(1);
        book.set('s', 'A2', 21);
        holds(book, 'capped passes between writes');
    });

    test('when a sheet is renamed, added, removed or moved, with no cell written', () => {
        const book = new Book({
            S: { A1: '=INDIRECT("Data!A1")', A2: '=SUM(INDIRECT("Later!A1:A2"))', A3: '=INDIRECT("R1C1",FALSE)' },
            Data: { A1: 5 },
        });
        expect(book.value('s', 'A1')).toBe(5);
        book.engine.renameSheet('data', 'Other');
        book.tabs = book.tabs.map((tab) => (tab.id === 'data' ? { id: 'data', name: 'Other' } : tab));
        holds(book, 'INDIRECT by a name no sheet has any more');
        expect(book.value('s', 'A1')).toBe('#REF!');
        book.engine.renameSheet('data', 'Data');
        book.tabs = book.tabs.map((tab) => (tab.id === 'data' ? { id: 'data', name: 'Data' } : tab));
        holds(book, 'the name comes back');
        expect(book.value('s', 'A1')).toBe(5);
        book.tabs = [...book.tabs, { id: 'later', name: 'Later' }];
        book.engine.addSheet(book.source('Later', { A1: 4, A2: 6 }), 3);
        holds(book, 'a sheet added under the name an INDIRECT text spells');
        expect(book.value('s', 'A2')).toBe(10);
        book.set('later', 'A2', 60);
        holds(book, 'then a write on that sheet');
        expect(book.value('s', 'A2')).toBe(64);
        book.engine.removeSheet('later');
        book.tabs = book.tabs.slice(0, 3);
        holds(book, 'the sheet removed');
        expect(book.value('s', 'A2')).toBe('#REF!');
        book.engine.moveSheet('data', 0);
        book.tabs = [book.tabs[2], book.tabs[0], book.tabs[1]];
        holds(book, 'sheets reordered');
        book.set('data', 'A1', 9);
        holds(book, 'a write after the reorder');
        expect(book.value('s', 'A1')).toBe(9);
    });

    test('when rows or columns come or go and cells move, under the areas and under the formulas', () => {
        const book = new Book({
            S: {
                A1: 1,
                A2: 2,
                A3: 3,
                A4: 4,
                C1: 2,
                D1: '=OFFSET(A1,C1,0)',
                D5: '=SUM(OFFSET(A1,0,0,C1,1))',
                E1: '=INDIRECT("A"&C1)',
            },
        });
        book.engine.editLines({ insert: true, index: 1, count: 1, sheet: 's', rows: true });
        holds(book, 'a row inserted inside the area and above a formula');
        book.set('s', 'A2', 50);
        book.set('s', 'A4', 70);
        holds(book, 'writes to the moved area and the new row');
        book.engine.moveCells({
            fromSheet: 's',
            row: 0,
            column: 3,
            rows: 1,
            columns: 2,
            toSheet: 's',
            toRow: 8,
            toColumn: 6,
        });
        book.set('s', 'A3', 51);
        holds(book, 'the formulas moved, then a write to their area');
        book.engine.editLines({ insert: false, index: 0, count: 1, sheet: 's', rows: false });
        book.set('s', 'A3', 52);
        holds(book, 'the column under the area deleted');
    });

    test('through the clock, an error in an argument and a loop', () => {
        const book = new Book({
            S: {
                A1: 1,
                A2: 2,
                A3: 3,
                B1: '=OFFSET(A1,RANDBETWEEN(0,2),0)',
                B2: '=NOW()',
                B3: '=OFFSET(B1,1,0)',
                B4: '=SUM(OFFSET(A1,B5,0))',
                B5: '=1/0',
                C1: '=OFFSET(C2,0,0)+0',
                C2: '=OFFSET(C1,D1,0)',
                D1: -1,
            },
        });
        const before = book.value('s', 'B3');
        book.clock();
        holds(book, 'a batch that writes nothing: a clock cell read through OFFSET, and a draw as an argument');
        expect(book.value('s', 'B3')).not.toBe(before);
        book.set('s', 'B5', 1);
        holds(book, 'an error in an argument, then mended');
        expect(book.value('s', 'B4')).toBe(2);
        holds(book, 'a loop through two resolved references');
        expect(book.value('s', 'C1')).toBe('#REF!');
        book.set('s', 'D1', 3);
        holds(book, 'the loop broken by an argument');
        expect(book.value('s', 'C1')).toBe(0);
        book.set('s', 'D1', -1);
        holds(book, 'the loop closed again');
        expect(book.value('s', 'C1')).toBe('#REF!');
        book.set('s', 'C2', 8);
        holds(book, 'a formula on the loop replaced by a value');
        expect(book.value('s', 'C1')).toBe(8);
    });

    test('when a pass stops at its cap inside a formula, with writes to both its areas between the passes', () => {
        const cells: Record<string, Typed> = {
            A1: 1,
            B1: '=SUM(OFFSET(A1,0,0,3,1))+E20+F1+SUM(OFFSET(C1,0,0,2,1))',
            C1: 5,
            C2: 6,
            E1: 1,
            F1: '=E1*2',
        };
        for (let row = 2; row <= 20; row += 1) cells[`E${row}`] = `=E${row - 1}+1`;
        const book = new Book({ S: cells });
        book.set('s', 'E1', 2);
        book.set('s', 'A2', 3);
        expect(book.engine.recalc(3).stopped).toBe(true);
        expect(book.engine.isPending('s', 0, 1)).toBe(true);
        book.set('s', 'C2', 60);
        book.engine.recalc(2);
        book.set('s', 'A3', 4);
        holds(book, 'the passes run to the end');
        expect(book.value('s', 'B1')).toBe(8 + 21 + 4 + 65);
    });

    test('when the formula is replaced by a value, cleared or replaced by one that resolves nothing', () => {
        const book = new Book({
            S: { A1: 1, A2: 2, B1: '=OFFSET(A1,1,0)', B2: '=SUM(INDIRECT("A1:A2"))', B3: '=OFFSET(A1,0,0)' },
        });
        book.set('s', 'B1', 7);
        book.set('s', 'B2', null);
        book.set('s', 'B3', '=A1+1');
        book.set('s', 'A2', 20);
        book.set('s', 'A1', 10);
        holds(book, 'their old areas written');
        expect([book.value('s', 'B1'), book.value('s', 'B2'), book.value('s', 'B3')]).toEqual([7, null, 11]);
    });

    test('for a colon between calls, a range sized by another, and a row that asks the workbook', () => {
        const book = new Book({
            S: {
                A1: 1,
                A2: 2,
                A3: 3,
                B1: 10,
                B2: 20,
                B3: 30,
                C1: 1,
                D1: '=SUM(INDEX(A1:A3,C1):INDEX(B1:B3,3))',
                D2: '=SUMIF(A1:A3,">0",B1)',
                D3: '=SUM(A1:OFFSET(A1,C1,1))',
                D4: '=ISFORMULA(OFFSET(A1,C1,0))',
                D5: '=FORMULATEXT(INDIRECT("A"&C1))',
                D6: '=CELL("contents",OFFSET(A1,C1,0))',
            },
        });
        book.reload();
        book.set('s', 'B2', 21);
        holds(book, 'a write to a cell only the box or the resized range holds');
        expect([book.value('s', 'D1'), book.value('s', 'D2'), book.value('s', 'D3')]).toEqual([67, 61, 34]);
        book.set('s', 'A2', '=A1');
        holds(book, 'a formula comes to the resolved cell');
        expect(book.value('s', 'D4')).toBe(true);
        book.set('s', 'C1', 2);
        holds(book, 'their argument changes');
        expect([book.value('s', 'D5'), book.value('s', 'D6')]).toEqual(['=A1', 3]);
    });
});

describe('each place a reference is worked out records it', () => {
    test('a call that answers a reference anywhere', () => {
        const book = new Book({ S: { A1: 1, A2: 2, B1: 1, C1: '=OFFSET(A1,B1,0)', C2: '=INDIRECT("A"&(B1+1))' } });
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'A2', 5))).toEqual(['C1', 'C2']);
        expect([book.value('s', 'C1'), book.value('s', 'C2')]).toEqual([5, 5]);
    });

    test('a colon between two calls, for the cells of the box that neither names', () => {
        const book = new Book({
            S: { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30, D1: '=SUM(INDEX(A1:A3,1):INDEX(C1:C3,3))' },
        });
        expect(book.flagged('s', ['D1'], () => book.set('s', 'B2', 21))).toEqual(['D1']);
        expect(book.value('s', 'D1')).toBe(67);
    });

    test('a range that takes its size from the criteria range', () => {
        const book = new Book({ S: { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30, D1: '=SUMIF(A1:A3,">0",B1)' } });
        expect(book.flagged('s', ['D1'], () => book.set('s', 'B3', 31))).toEqual(['D1']);
        expect(book.value('s', 'D1')).toBe(61);
    });

    test('a range sized past the last row and the last column of the grid', () => {
        const book = new Book({ S: { A1: 1, B1: 2, A2: 3 } });
        book.engine.setValue('s', GRID_ROWS - 1, GRID_COLUMNS - 1, 7);
        book.engine.setFormula('s', 2, 0, `=SUMIF(R1C1:R2C2,">0",R${GRID_ROWS}C${GRID_COLUMNS})`);
        book.engine.recalc(NO_CAP);
        expect(book.value('s', 'A3')).toBe(7);
        book.set('s', 'D9', 1);
        book.engine.setValue('s', GRID_ROWS - 1, GRID_COLUMNS - 1, 8);
        book.engine.recalc(NO_CAP);
        expect(book.value('s', 'A3')).toBe(8);
    });

    test('an element at a time, when the call is lifted over an array', () => {
        const book = new Book({ S: { A1: 1, A2: 2, A3: 3, C1: '=SUM(OFFSET(A1,{0,2},0))' } });
        expect(book.flagged('s', ['C1'], () => book.set('s', 'A3', 30))).toEqual(['C1']);
        expect(book.flagged('s', ['C1'], () => book.set('s', 'A2', 20))).toEqual([]);
        expect(book.value('s', 'C1')).toBe(31);
    });
});

describe('a write to a cell that no area holds leaves the formula alone', () => {
    const HOSTS = { A1: 1, A2: 2, A3: 3, A4: 4, B1: 1, C1: '=OFFSET(A1,B1,0)', C2: '=SUM(INDIRECT("A3:A4"))' };

    test('a write beside the areas, and a batch that writes nothing', () => {
        const book = new Book({ S: { ...HOSTS, C3: '=A1+1' } });
        expect(book.flagged('s', ['C1', 'C2', 'C3'], () => book.set('s', 'A1', 9))).toEqual(['C1', 'C3']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'F9', 9))).toEqual([]);
        expect(book.flagged('s', ['C1', 'C2'], () => book.clock())).toEqual([]);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'A4', 9))).toEqual(['C2']);
    });

    test('the first marking after a computed load flags every one, and the next does not', () => {
        const book = new Book({ S: HOSTS });
        book.reload();
        expect(book.engine.settled()).toBe(true);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'F9', 9))).toEqual(['C1', 'C2']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'F9', 8))).toEqual([]);
    });

    test('a structural edit flags every one, and the next marking does not', () => {
        const book = new Book({ S: HOSTS });
        book.engine.editLines({ insert: true, index: 30, count: 1, sheet: 's', rows: true });
        expect(book.engine.isPending('s', 0, 2) && book.engine.isPending('s', 1, 2)).toBe(true);
        holds(book, 'the edit');
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'F9', 9))).toEqual([]);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'A2', 9))).toEqual(['C1']);
    });

    test('an edit that is refused flags every one at the next marking, once', () => {
        // As long as a cell stores, so the digit a row inserted above row 9 adds is one too many.
        const start = MAX_STORED_LENGTH % 2 === 0 ? '=R9C1+22' : '=R9C1';
        const long = `${start}${'+1'.repeat((MAX_STORED_LENGTH - start.length) / 2)}`;
        const book = new Book({ S: HOSTS });
        book.engine.setFormula('s', 0, 6, long);
        holds(book, 'the long formula');
        expect(() => book.engine.editLines({ insert: true, index: 5, count: 1, sheet: 's', rows: true })).toThrow(
            EditRefusal,
        );
        expect(book.engine.isPending('s', 0, 2)).toBe(false);
        book.set('s', 'A2', 9);
        holds(book, 'a write into an area after the refusal');
        expect(book.value('s', 'C1')).toBe(9);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'F9', 9))).toEqual([]);
    });

    test('an area the formula resolves no more: the record is changed in place', () => {
        const book = new Book({ S: HOSTS });
        expect(book.flagged('s', ['C1'], () => book.set('s', 'B1', 2))).toEqual(['C1']);
        expect(book.flagged('s', ['C1'], () => book.set('s', 'A2', 9))).toEqual([]);
        expect(book.flagged('s', ['C1'], () => book.set('s', 'A3', 9))).toEqual(['C1']);
        expect(book.value('s', 'C1')).toBe(9);
    });

    test('an area past the last the formula resolved this time: the record is cut', () => {
        const book = new Book({
            S: {
                B1: true,
                C1: '=IF(B1,OFFSET(D1,0,1)+OFFSET(D1,1,1),OFFSET(D1,0,1))',
                C2: '=IF(B1,OFFSET(D1,1,1),5)',
                E1: 1,
                E2: 2,
            },
        });
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'E2', 7))).toEqual(['C1', 'C2']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'B1', false))).toEqual(['C1', 'C2']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'E2', 8))).toEqual([]);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'E1', 8))).toEqual(['C1']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'B1', true))).toEqual(['C1', 'C2']);
        expect(book.flagged('s', ['C1', 'C2'], () => book.set('s', 'E2', 9))).toEqual(['C1', 'C2']);
        expect([book.value('s', 'C1'), book.value('s', 'C2')]).toEqual([17, 9]);
    });

    test('a formula that reads another one halfway: each keeps its own record', () => {
        const book = new Book({
            S: {
                B1: '=OFFSET(D1,0,1)+B5+OFFSET(D1,1,1)',
                B5: '=OFFSET(D1,2,1)+OFFSET(D1,3,1)',
                E1: 1,
                E2: 2,
                E3: 3,
                E4: 4,
                E5: 5,
            },
        });
        // Both are flagged, and the first reads the second between its two references.
        expect(book.flagged('s', ['B1', 'B5'], () => book.set('s', 'E3', 30))).toEqual(['B1', 'B5']);
        expect(book.flagged('s', ['B1', 'B5'], () => book.set('s', 'E2', 20))).toEqual(['B1']);
        expect(book.flagged('s', ['B1', 'B5'], () => book.set('s', 'E1', 10))).toEqual(['B1']);
        expect(book.flagged('s', ['B1', 'B5'], () => book.set('s', 'E4', 40))).toEqual(['B1', 'B5']);
        expect(book.flagged('s', ['B1', 'B5'], () => book.set('s', 'E5', 50))).toEqual([]);
        expect(book.value('s', 'B1')).toBe(100);
    });

    test('a formula a stopped pass left half computed starts its record again', () => {
        const cells: Record<string, Typed> = {
            B1: 0,
            C1: '=OFFSET(G1,B1,1)+E20+F1+OFFSET(G1,2,1)',
            E1: 1,
            F1: '=E1*2',
            H1: 1,
            H2: 2,
            H3: 3,
        };
        for (let row = 2; row <= 20; row += 1) cells[`E${row}`] = `=E${row - 1}+1`;
        const book = new Book({ S: cells });
        book.set('s', 'E1', 2);
        expect(book.engine.recalc(3).stopped).toBe(true);
        expect(book.engine.isPending('s', 0, 2)).toBe(true);
        book.set('s', 'B1', 1);
        holds(book, 'the argument changed before the pass went on');
        expect(book.flagged('s', ['C1'], () => book.set('s', 'H1', 9))).toEqual([]);
        expect(book.flagged('s', ['C1'], () => book.set('s', 'H2', 9))).toEqual(['C1']);
        expect(book.flagged('s', ['C1'], () => book.set('s', 'H3', 9))).toEqual(['C1']);
        expect(book.value('s', 'C1')).toBe(9 + 21 + 4 + 9);
    });

    test('a formula this build cannot evaluate that took the place of one that resolved', () => {
        const book = new Book({ S: { C1: '=OFFSET(D1,0,1)', E1: 1 } });
        book.engine.setFormula('s', 0, 2, "='[1]Book'!R1C1+OFFSET(R1C4,0,1)", 7);
        book.engine.recalc(NO_CAP);
        book.set('s', 'E1', 2);
        book.set('first', 'B1', 1);
        expect(book.engine.recalc(0).stopped).toBe(false);
        expect(book.value('s', 'C1')).toBe(7);
    });
});
