import { describe, expect, test } from 'bun:test';
import type { Edit } from '../../text';
import { GONE, mapIndex, mapSpan } from '../../text';

const ROWS = 1048576;
const COLUMNS = 16384;

const insert = (index: number, count: number, lines = 10): Edit => ({ insert: true, index, count, lines });
const remove = (index: number, count: number, lines = 10): Edit => ({ insert: false, index, count, lines });

type After = [number, number] | null;

function spanAfter(edit: Edit, start: number, end: number): After {
    const into = { start: -5, end: -5 };
    return mapSpan(edit, start, end, into) ? [into.start, into.end] : null;
}

// The grid's lines as a list of their old indices, edited the way the grid is: new lines spliced in and the lines
// pushed past the last one cut off, or the deleted lines spliced out.
function linesAfter(edit: Edit): (number | null)[] {
    const lines: (number | null)[] = Array.from({ length: edit.lines }, (_, i) => i);
    if (!edit.insert) lines.splice(edit.index, edit.count);
    else lines.splice(edit.index, 0, ...new Array<null>(edit.count).fill(null));
    return lines.slice(0, edit.lines);
}

function slowIndex(edit: Edit, i: number): number {
    return linesAfter(edit).indexOf(i);
}

// A new line joins the span when the lines on both sides of it belong to it.
function slowSpan(edit: Edit, start: number, end: number): After {
    const between = edit.insert && start < edit.index && edit.index <= end;
    const places = linesAfter(edit).flatMap((line, place) =>
        (line === null ? between : line >= start && line <= end) ? [place] : [],
    );
    return places.length > 0 ? [places[0], places[places.length - 1]] : null;
}

describe('an insert against the span 3 to 5 on ten lines', () => {
    test.each<[string, Edit, After]>([
        ['at the first line of the grid', insert(0, 1), [4, 6]],
        ['before the span', insert(2, 2), [5, 7]],
        ['at its first line, which moves down', insert(3, 1), [4, 6]],
        ['at its second line, which grows it', insert(4, 1), [3, 6]],
        ['at its last line, which grows it', insert(5, 2), [3, 7]],
        ['right after its last line', insert(6, 1), [3, 5]],
        ['at the last line of the grid', insert(9, 1), [3, 5]],
        ['past the last line of the grid', insert(10, 1), [3, 5]],
        ['that pushes its end onto the last line', insert(0, 4), [7, 9]],
        ['that pushes its end off the grid', insert(0, 5), [8, 9]],
        ['that pushes its start onto the last line', insert(0, 6), [9, 9]],
        ['that pushes all of it off the grid', insert(0, 7), null],
        ['inside that pushes its end off the grid', insert(4, 6), [3, 9]],
    ])('%s', (_, edit, expected) => {
        expect(spanAfter(edit, 3, 5)).toEqual(expected);
    });
});

describe('a delete against the span 3 to 5 on ten lines', () => {
    test.each<[string, Edit, After]>([
        ['of the first line of the grid', remove(0, 1), [2, 4]],
        ['right before the span', remove(1, 2), [1, 3]],
        ['over its first line', remove(2, 2), [2, 3]],
        ['of its first line', remove(3, 1), [3, 4]],
        ['of its middle line', remove(4, 1), [3, 4]],
        ['of its last line', remove(5, 1), [3, 4]],
        ['over its last line', remove(5, 3), [3, 4]],
        ['of all but its first line', remove(4, 2), [3, 3]],
        ['of all but its last line', remove(3, 2), [3, 3]],
        ['of exactly the span', remove(3, 3), null],
        ['of more than the span', remove(2, 6), null],
        ['of everything from its first line to the end of the grid', remove(3, 7), null],
        ['right after the span', remove(6, 2), [3, 5]],
        ['of the last line of the grid', remove(9, 1), [3, 5]],
        ['of every line before it', remove(0, 3), [0, 2]],
    ])('%s', (_, edit, expected) => {
        expect(spanAfter(edit, 3, 5)).toEqual(expected);
    });
});

describe('a span on the first or the last line of the grid', () => {
    test.each<[string, Edit, number, number, After]>([
        ['an insert at line 0 moves the first line', insert(0, 2), 0, 0, [2, 2]],
        ['an insert at line 1 leaves the first line', insert(1, 2), 0, 0, [0, 0]],
        ['an insert at line 1 grows a span from the first line', insert(1, 2), 0, 1, [0, 3]],
        ['an insert before the last line pushes it off', insert(4, 1), 9, 9, null],
        ['an insert at the last line pushes it off', insert(9, 1), 9, 9, null],
        ['an insert inside a span that ends on the last line keeps that end', insert(5, 2), 2, 9, [2, 9]],
        ['an insert before a span that ends on the last line shortens it', insert(0, 2), 2, 9, [4, 9]],
        ['an insert at line 0 moves the whole grid down', insert(0, 3), 0, 9, [3, 9]],
        ['an insert inside the whole grid leaves it whole', insert(4, 3), 0, 9, [0, 9]],
        ['a delete of the first line takes it', remove(0, 1), 0, 0, null],
        ['a delete of the first line shortens a span from it', remove(0, 1), 0, 4, [0, 3]],
        ['a delete of the last line takes it', remove(9, 1), 9, 9, null],
        ['a delete of the last line shortens a span to it', remove(9, 1), 2, 9, [2, 8]],
        ['a delete of the last lines shortens a span that ends in them', remove(6, 4), 2, 7, [2, 5]],
        ['a delete inside the whole grid shortens it', remove(4, 2), 0, 9, [0, 7]],
        ['a delete of the whole grid takes it', remove(0, 10), 0, 9, null],
    ])('%s', (_, edit, start, end, expected) => {
        expect(spanAfter(edit, start, end)).toEqual(expected);
    });
});

// Lines counted from 0, so row 5 of a sheet is line 4 and column C is line 2.
describe('the cases other spreadsheets pin, on a grid of Excel size', () => {
    test.each<[string, Edit, number, number, After]>([
        ['A1:A3 with a row inserted at 2 grows', insert(1, 1, ROWS), 0, 2, [0, 3]],
        ['A1:A3 with a row inserted at 1 moves', insert(0, 1, ROWS), 0, 2, [1, 3]],
        ['A1:A3 with a row inserted at 3 grows', insert(2, 1, ROWS), 0, 2, [0, 3]],
        ['A1:A3 with a row inserted at 4 stays', insert(3, 1, ROWS), 0, 2, [0, 2]],
        ['A1:A10 with a row inserted at 5 grows', insert(4, 1, ROWS), 0, 9, [0, 10]],
        ['A1:A10 with a row inserted at 11 stays', insert(10, 1, ROWS), 0, 9, [0, 9]],
        ['C:D with a column inserted at C moves', insert(2, 1, COLUMNS), 2, 3, [3, 4]],
        ['C:D with a column inserted at D grows', insert(3, 1, COLUMNS), 2, 3, [2, 4]],
        ['C:D with a column inserted at E stays', insert(4, 1, COLUMNS), 2, 3, [2, 3]],
        ['B:C with two columns inserted at B moves', insert(1, 2, COLUMNS), 1, 2, [3, 4]],
        ['row 1048575 alone with two rows inserted above is gone', insert(4, 2, ROWS), 1048574, 1048574, null],
        [
            'B2:B1048575 with two rows inserted inside ends on the last row',
            insert(4, 2, ROWS),
            1,
            1048574,
            [1, 1048575],
        ],
        ['a merge B2:C3 with a row inserted at 3 grows', insert(2, 1, ROWS), 1, 2, [1, 3]],
        ['a merge B2:C3 with a row inserted at 2 moves', insert(1, 1, ROWS), 1, 2, [2, 3]],
        ['B2:C5 with row 3 deleted', remove(2, 1, ROWS), 1, 4, [1, 3]],
        ['B2:C4 with its last row deleted', remove(3, 1, ROWS), 1, 3, [1, 2]],
        ['B2:C3 with its first row deleted', remove(1, 1, ROWS), 1, 2, [1, 1]],
        ['A3:A6 with rows 2 to 4 deleted', remove(1, 3, ROWS), 2, 5, [1, 2]],
        ['A2:A5 with rows 4 to 6 deleted', remove(3, 3, ROWS), 1, 4, [1, 2]],
        ['A2:A3 with rows 2 to 3 deleted is gone', remove(1, 2, ROWS), 1, 2, null],
        ['A1:A2 with rows 1 to 2 deleted is gone', remove(0, 2, ROWS), 0, 1, null],
        ['C:F with column D deleted', remove(3, 1, COLUMNS), 2, 5, [2, 4]],
        ['A:C with column B deleted', remove(1, 1, COLUMNS), 0, 2, [0, 1]],
        ['A:A with column A deleted is gone', remove(0, 1, COLUMNS), 0, 0, null],
        ['A1:A10 with the last rows of the sheet from row 10 deleted', remove(9, ROWS - 9, ROWS), 0, 9, [0, 8]],
        ['every row as a plain span with row 1 deleted loses a line', remove(0, 1, ROWS), 0, ROWS - 1, [0, ROWS - 2]],
        ['A2:A10 with rows 2 to 10 deleted is gone', remove(1, 9, ROWS), 1, 9, null],
    ])('%s', (_, edit, start, end, expected) => {
        expect(spanAfter(edit, start, end)).toEqual(expected);
    });

    test.each<[string, Edit, number, number]>([
        ['A5 with a row inserted above row 5', insert(1, 1, ROWS), 4, 5],
        ['A5 with a row inserted at row 5', insert(4, 1, ROWS), 4, 5],
        ['A2 with a row inserted at row 3', insert(2, 1, ROWS), 1, 1],
        ['A4 with rows 2 to 3 deleted', remove(1, 2, ROWS), 3, 1],
        ['A3 with rows 2 to 3 deleted', remove(1, 2, ROWS), 2, GONE],
        ['A1 with rows 2 to 3 deleted', remove(1, 2, ROWS), 0, 0],
        ['the last row with a row inserted above it', insert(0, 1, ROWS), ROWS - 1, GONE],
        ['the row before the last with a row inserted above it', insert(0, 1, ROWS), ROWS - 2, ROWS - 1],
        ['the last column with a column deleted before it', remove(0, 1, COLUMNS), COLUMNS - 1, COLUMNS - 2],
    ])('%s', (_, edit, line, expected) => {
        expect(mapIndex(edit, line)).toBe(expected);
    });
});

describe('every edit on a grid of up to seven lines agrees with moving the lines themselves', () => {
    const edits: Edit[] = [];
    for (let lines = 1; lines <= 7; lines += 1) {
        for (let index = 0; index <= lines; index += 1) {
            for (let count = 1; count <= lines + 1; count += 1) {
                edits.push(insert(index, count, lines));
                if (index + count <= lines) edits.push(remove(index, count, lines));
            }
        }
    }

    test('for every line', () => {
        for (const edit of edits) {
            for (let i = 0; i < edit.lines; i += 1) {
                expect([edit, i, mapIndex(edit, i)]).toEqual([edit, i, slowIndex(edit, i)]);
            }
        }
    });

    test('for every span', () => {
        for (const edit of edits) {
            for (let start = 0; start < edit.lines; start += 1) {
                for (let end = start; end < edit.lines; end += 1) {
                    expect([edit, start, end, spanAfter(edit, start, end)]).toEqual([
                        edit,
                        start,
                        end,
                        slowSpan(edit, start, end),
                    ]);
                }
            }
        }
    });

    test('a span of one line goes where its line goes', () => {
        for (const edit of edits) {
            for (let i = 0; i < edit.lines; i += 1) {
                const to = mapIndex(edit, i);
                expect(spanAfter(edit, i, i)).toEqual(to === GONE ? null : [to, to]);
            }
        }
    });
});

test('a span that is gone leaves the caller’s span as it was', () => {
    const into = { start: 3, end: 5 };
    expect(mapSpan(remove(3, 3), into.start, into.end, into)).toBe(false);
    expect(into).toEqual({ start: 3, end: 5 });
});
