import { expect, test } from 'bun:test';
import type { FormulaNode, LineEdit, Move } from '../../text';
import { GONE, parseA1, parseStored, printA1, printStored, toA1, transformLines, transformMove } from '../../text';
import { findSheet, sheetName, showsAsAnother } from '../text/support';
import { lineAfter, random, shapes } from './support';

const SHEET_IDS = ['s1', 's2', 'my'];

type Host = { sheet: string; row: number; column: number };

// What a transform returns is a tree its own text gives back: the stored text to the node, and the text the formula
// bar shows at the host to the same shape, but for what shows as another there, as a range with its corners swapped.
function reads(tree: FormulaNode, host: Host, where: string): void {
    const stored = printStored(tree);
    const back = parseStored(stored);
    if (JSON.stringify(back) !== JSON.stringify(tree)) {
        throw new Error(`${where}: ${stored} reads back as ${'reason' in back ? back.reason : printStored(back)}`);
    }
    const a1 = printA1(tree, host.row, host.column, sheetName);
    const again = parseA1(a1, host.row, host.column, findSheet);
    if ('reason' in again) throw new Error(`${where}: ${a1} does not parse at its host`);
    const offGrid = a1.split('#REF!').length !== stored.split('#REF!').length;
    if (offGrid || showsAsAnother(tree, host.row, host.column)) return;
    if (printStored(again) !== stored) throw new Error(`${where}: ${a1} reads back as ${printStored(again)}`);
}

test('a formula taken through line edits and moves is, after each, text that reads back as its tree', () => {
    const pick = random(11);
    const next = shapes(pick);
    // `sheets` counts the steps that left a reference with a sheet it did not have.
    const seen = { parsed: 0, lines: 0, within: 0, across: 0, overlapping: 0, carried: 0, changed: 0, sheets: 0 };
    for (let run = 0; run < 20000; run += 1) {
        const text = next();
        let host: Host = { sheet: SHEET_IDS[pick(3)], row: pick(9), column: pick(7) };
        const parsed = parseA1(text, host.row, host.column, findSheet);
        if ('reason' in parsed) continue;
        seen.parsed += 1;
        let tree = parsed;
        let where = `${text} on ${host.sheet} at ${toA1(host.row, host.column)}`;
        reads(tree, host, where);
        for (let step = 1 + pick(3); step > 0; step -= 1) {
            const before = tree;
            if (pick(3) === 0) {
                const rows = pick(2) === 0;
                const insert = pick(2) === 0;
                const edit: LineEdit = {
                    insert,
                    index: pick(9),
                    count: 1 + pick(3),
                    sheet: SHEET_IDS[pick(3)],
                    rows,
                };
                const line = rows ? host.row : host.column;
                const after = host.sheet === edit.sheet ? lineAfter(edit, line) : line;
                if (after === GONE) break;
                where += `, ${JSON.stringify(edit)}`;
                tree = transformLines(tree, edit, host.sheet, line).tree;
                host = rows ? { ...host, row: after } : { ...host, column: after };
                seen.lines += 1;
            } else {
                const fromSheet = SHEET_IDS[pick(3)];
                const move: Move = {
                    fromSheet,
                    row: pick(7),
                    column: pick(5),
                    rows: 1 + pick(4),
                    columns: 1 + pick(3),
                    toSheet: pick(2) === 0 ? fromSheet : SHEET_IDS[pick(3)],
                    toRow: pick(8),
                    toColumn: pick(6),
                };
                const inside = (sheet: string, top: number, left: number) =>
                    host.sheet === sheet &&
                    host.row >= top &&
                    host.row < top + move.rows &&
                    host.column >= left &&
                    host.column < left + move.columns;
                const carried = inside(move.fromSheet, move.row, move.column);
                // A formula the block lands on is overwritten and has no afterwards.
                if (!carried && inside(move.toSheet, move.toRow, move.toColumn)) break;
                where += `, ${JSON.stringify(move)}`;
                tree = transformMove(tree, move, host.sheet, host.row, host.column).tree;
                if (carried) {
                    host = {
                        sheet: move.toSheet,
                        row: host.row + move.toRow - move.row,
                        column: host.column + move.toColumn - move.column,
                    };
                    seen.carried += 1;
                }
                const overlaps =
                    move.fromSheet === move.toSheet &&
                    Math.abs(move.toRow - move.row) < move.rows &&
                    Math.abs(move.toColumn - move.column) < move.columns;
                if (overlaps) seen.overlapping += 1;
                else if (move.fromSheet === move.toSheet) seen.within += 1;
                else seen.across += 1;
            }
            reads(tree, host, where);
            if (tree !== before) seen.changed += 1;
            if (printStored(tree).split('!').length > printStored(before).split('!').length) seen.sheets += 1;
        }
    }
    expect(seen.parsed).toBeGreaterThan(17000);
    expect(seen.lines).toBeGreaterThan(10000);
    expect(seen.within).toBeGreaterThan(10000);
    expect(seen.across).toBeGreaterThan(7000);
    expect(seen.overlapping).toBeGreaterThan(2500);
    expect(seen.carried).toBeGreaterThan(500);
    expect(seen.changed).toBeGreaterThan(4000);
    expect(seen.sheets).toBeGreaterThan(1400);
});
