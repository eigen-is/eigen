// deriveView, which the Workbook runs on every context it commits: it reworks the geometry, the selection's box and the
// filter's rects when what they read changed, and it writes nothing a peer or the undo stack would see.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Cell } from '../../../engine/types';
import type { Context, Sheet } from '../../../state';
import { handlePaste } from '../../../state/events/paste';
import { deleteRowCol } from '../../../state/modules/rowcol';
import { changeSheet, deriveView } from '../../../state/modules/sheet';
import { workbookContextFactory } from '../factories/context';

const ROWS = 6;
const COLUMNS = 4;
const HEIGHT = 20;

function makeSheet(id: string, fields: Partial<Sheet> = {}): Sheet {
    const data = Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, (): Cell | null => null));
    return { id, name: id, order: 0, data, config: {}, ...fields };
}

function workbook(fields: Partial<Sheet> = {}): Context {
    return workbookContextFactory({
        currentSheetId: 'one',
        defaultrowlen: HEIGHT,
        defaultcollen: 70,
        sheets: [makeSheet('one', fields), makeSheet('two')],
        visibledatarow: Array.from({ length: ROWS }, (_, r) => (r + 1) * HEIGHT),
        visibledatacolumn: Array.from({ length: COLUMNS }, (_, c) => (c + 1) * 70),
        selections: [{ row: [3, 3], column: [0, 0], row_focus: 3, column_focus: 0, top: 3 * HEIGHT }],
    });
}

function cells(draft: Context) {
    return draft.sheets[0].data ?? [];
}

function commit(base: Context, recipe: (draft: Context) => void) {
    return deriveView(base, produce(base, recipe));
}

describe('deriveView', () => {
    const skipped: [string, (draft: Context) => void][] = [
        [
            'a selection drag frame',
            (draft) => {
                draft.cellSelectMoving = true;
            },
        ],
        [
            'a cell edit below the first row',
            (draft) => {
                cells(draft)[2][1] = { v: 1 };
            },
        ],
        [
            'a freeze',
            (draft) => {
                draft.sheets[0].frozen = { type: 'row' };
            },
        ],
        [
            'a row height on another sheet',
            (draft) => {
                draft.sheets[1].config = { rowlen: { 0: 99 } };
            },
        ],
    ];
    for (const [name, recipe] of skipped) {
        test(`${name} reworks nothing`, () => {
            const base = workbook();
            const next = produce(base, recipe);
            expect(deriveView(base, next)).toBe(next);
        });
    }

    test('a row height moves the geometry and the box of a selection below it', () => {
        const next = commit(workbook(), (draft) => {
            draft.sheets[0].config = { rowlen: { 1: HEIGHT + 30 } };
        });
        expect(next.visibledatarow[1]).toBe(2 * HEIGHT + 30);
        expect(next.selections?.[0].top).toBe(3 * HEIGHT + 30);
    });

    test('a hidden row, a hidden column and a column width each move the geometry', () => {
        const hidden = commit(workbook(), (draft) => {
            draft.sheets[0].config = { rowhidden: { 0: 0 }, colhidden: { 0: 0 }, columnlen: { 1: 100 } };
        });
        expect(hidden.visibledatarow[0]).toBe(0);
        expect(hidden.visibledatacolumn).toEqual([0, 100, 170, 240]);
    });

    test('a grid that grew by a row or a column gets its tracks', () => {
        const next = commit(workbook(), (draft) => {
            const data = cells(draft);
            data.push(data[0].slice());
            for (const row of data) row.push(null);
        });
        expect(next.visibledatarow).toHaveLength(ROWS + 1);
        expect(next.visibledatacolumn).toHaveLength(COLUMNS + 1);
    });

    test('a value set in the first row clamps a wide default column', () => {
        const base = produce(workbook(), (draft) => {
            draft.defaultcollen = 400;
        });
        const next = commit(base, (draft) => {
            cells(draft)[0][1] = { v: 1 };
        });
        expect(next.visibledatacolumn.slice(0, 2)).toEqual([400, 700]);
    });

    test('a new filter range gets its rects, and a cleared one loses them', () => {
        const filtered = commit(workbook(), (draft) => {
            draft.sheets[0].filterRange = { row: [0, 2], column: [0, 1] };
        });
        expect(filtered.filterOptions?.items).toHaveLength(2);
        const cleared = commit(filtered, (draft) => {
            draft.sheets[0].filterRange = undefined;
        });
        expect(cleared.filterOptions).toBeUndefined();
    });

    test('losing edit rights clears the filter buttons', () => {
        const filtered = commit(workbook(), (draft) => {
            draft.sheets[0].filterRange = { row: [0, 2], column: [0, 1] };
        });
        const viewer = commit(filtered, (draft) => {
            draft.allowEdit = false;
        });
        expect(viewer.filterOptions).toBeUndefined();
    });

    test('a switch keeps what its recipe derived, and a jump in that recipe read the new geometry', () => {
        const base = workbook();
        let readInRecipe: number | undefined;
        const next = commit(base, (draft) => {
            draft.sheets[1].config = { rowlen: { 0: 50 } };
            changeSheet(draft, 'two');
            readInRecipe = draft.visibledatarow[0];
        });
        expect(readInRecipe).toBe(50);
        expect(next.currentSheetId).toBe('two');
        expect(next.visibledatarow[0]).toBe(50);
    });

    test('the view it writes leaves the sheets as the commit made them', () => {
        const base = workbook();
        const next = produce(base, (draft) => {
            draft.sheets[0].config = { rowlen: { 1: 50 } };
        });
        const viewed = deriveView(base, next);
        expect(viewed).not.toBe(next);
        expect(viewed.sheets).toBe(next.sheets);
    });

    test("a tab's own delete of the selected row draws its box on the row that took its place", () => {
        const next = commit(workbook(), (draft) => deleteRowCol(draft, { type: 'row', start: 3, end: 3, id: 'one' }));
        expect(next.selections?.[0]).toMatchObject({ row: [3, 3], top: 3 * HEIGHT });
    });

    test('no selection comes back after a row delete dropped it', () => {
        const next = commit(workbook(), (draft) => {
            draft.selections = undefined;
            cells(draft).pop();
        });
        expect(next.selections).toBeUndefined();
    });
});

describe('a paste', () => {
    test('leaves its selection with a box when the grid stays as it was', () => {
        const clipboard = { getData: (type: string) => (type === 'text/plain' ? 'a\tb\nc\td' : ''), files: [] };
        const next = commit(workbook(), (draft) => handlePaste(draft, clipboard));
        const [selection] = next.selections ?? [];
        expect(selection.row).toEqual([3, 4]);
        expect(selection.height_move).toBe(2 * HEIGHT - 1);
    });
});
