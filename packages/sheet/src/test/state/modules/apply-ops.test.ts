import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import { isRecord } from '@workspace/lib/guards';
import { decodeSheetsWorkbook, encodeSheetsSnapshot, sheetsBatchOf } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { dataToCelldata } from '../../../engine/celldata';
import { decodeOrDefault } from '../../../engine/defaults';
import { replaySheetsOps, replaySheetsSteps, withMaterializedData } from '../../../engine/replay-ops';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import { copySheet } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { tryDeleteRowCol, tryInsertRowCol } from '../../../state/events/rowcol';
import { addSheet, changeSheet, deleteSheet, renameSheet } from '../../../state/modules/sheet';
import type { Op, Sheet } from '../../../state/types';
import type { Tab } from '../factories/collab';
import { tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { selectionFactory, workbookContextFactory } from '../factories/context';
import { typed } from '../factories/edit-cycle';
import { formatsOf } from '../factories/validations';
import type { Random } from '../factories/workbook-fuzz';
import {
    fresh,
    nextBatch,
    nextLoopBatch,
    random,
    sizeOf,
    withAuthorValues,
    workbook,
} from '../factories/workbook-fuzz';

// Seed 51 once left a #REF! cell typed as a number after an undo and a redo.
const SEEDS = [...Array.from({ length: 24 }, (_, i) => i + 1), 51];
const STEPS = 60;
// The places each seed's log is folded at, one at a time.
const FOLDS = 3;
// The seeds of the logs with formulas that read themselves.
const LOOP_SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
// The engine in engine/ evaluates a loop's cells and their readers in the order its graph listed them, which a graph
// built from a snapshot lists otherwise, so these seeds part. They run as failing until the engine is replaced.
const PARTED_LOOP_SEEDS = [2, 5, 7, 10, 13, 14, 16];
const LOOP_STEPS = 20;

afterEach(() => {
    mock.restore();
});

const chart = (id: string, sheetId: string) => ({
    ...newChartSpecParts({
        ...sampleChartSpec('column'),
        series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
        data: {
            source: 'range',
            categories: null,
            series: [{ id: 's-1', name: 'Points', values: { sheetId, row: [1, 4], column: [1, 1] } }],
        },
    }),
    id,
    index: 'a0',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
});

const rule = { type: 'number', type2: 'between', value1: '1', value2: '9' };

const number = (v: number) => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });

// The fuzz workbook with what a sheet carries beside its cells: a chart reading another sheet, a merge, a row height,
// a validation rule and a conditional format.
function start(rnd: Random): Sheet[] {
    const [one, two, three] = fresh(workbook(rnd));
    const sheets: Sheet[] = [
        {
            ...one,
            charts: { c1: chart('c1', 's2') },
            config: { rowlen: { 2: 30 } },
            conditionalFormats: formatsOf([
                {
                    type: 'default',
                    conditionName: 'formula',
                    conditionValue: ['=A2>10'],
                    ranges: [{ row: [1, 4], column: [0, 1] }],
                    format: {},
                },
            ]),
        },
        { ...two, dataValidations: { v1: { ranges: [{ row: [0, 3], column: [0, 0] }], order: 'a0', rule } } },
        { ...three, config: { merge: { '4_0': { r: 4, c: 0, rs: 2, cs: 2 } } } },
    ];
    for (const sheet of sheets) normalizeSheetConfig(sheet);
    return sheets;
}

function editor(sheets: Sheet[]): Tab {
    return tab(
        produce(
            workbookContextFactory({
                currentSheetId: 's1',
                selections: selectionFactory([0, 0], [0, 0], 0, 0),
                sheets: sheets.map(withMaterializedData),
            }),
            () => {},
        ),
    );
}

// A peer's write beside the cells: a chart added, moved or taken away, a merge, a row height, a rule, a hidden sheet.
function extrasBatch(rnd: Random, sheets: Sheet[], step: number): Op[] {
    const sheet = rnd.pick(sheets);
    const { id } = sheet;
    const charts = Object.keys(sheet.charts ?? {});
    const roll = rnd.int(8);
    if (roll === 0)
        return [{ op: 'add', id, path: ['charts', `p${step}`], value: chart(`p${step}`, rnd.pick(sheets).id) }];
    if (roll === 1 && charts.length > 0) return [{ op: 'remove', id, path: ['charts', rnd.pick(charts)] }];
    if (roll === 2 && charts.length > 0)
        return [{ op: 'replace', id, path: ['charts', rnd.pick(charts), 'y'], value: step }];
    if (roll === 3) {
        const r = rnd.int(6);
        return [{ op: 'add', id, path: ['config', 'merge', `${r}_3`], value: { r, c: 3, rs: 2, cs: 1 } }];
    }
    if (roll === 4) return [{ op: 'add', id, path: ['config', 'rowlen', `${rnd.int(8)}`], value: 20 + step }];
    if (roll === 5) {
        const ranges = [{ row: [rnd.int(4), 5], column: [1, 1] }];
        return [{ op: 'add', id, path: ['dataValidations', `w${step}`], value: { ranges, order: 'a0', rule } }];
    }
    if (roll === 6) return [{ op: 'replace', id, path: ['hide'], value: rnd.chance(0.5) ? 1 : undefined }];
    return [{ op: 'remove', id, path: ['config', 'rowlen', '2'] }];
}

// The tab's own edit of one kind, recorded as the Workbook records it.
function authorEdit(rnd: Random, t: Tab, step: number): Op[] {
    const { sheets } = t.ctx;
    const sheet = rnd.pick(sheets);
    const roll = rnd.int(10);
    if (roll < 5) {
        const type: 'row' | 'column' = rnd.chance(0.7) ? 'row' : 'column';
        const { rows, columns } = sizeOf(sheet);
        const size = type === 'row' ? rows : columns;
        if (size > 2 && rnd.chance(0.5)) {
            const start = rnd.int(size - 1);
            const remove = { type, start, end: start + rnd.int(2), id: sheet.id };
            return tabEdit(t, (ctx) => tryDeleteRowCol(ctx, remove), { deleteRowColOp: remove });
        }
        const direction = rnd.pick(['lefttop', 'rightbottom'] as const);
        const insert = { type, index: rnd.int(size), count: 1 + rnd.int(2), direction, id: sheet.id };
        return tabEdit(t, (ctx) => tryInsertRowCol(ctx, insert, rnd.chance(0.5)), { insertRowColOp: insert });
    }
    if (roll === 5) return tabEdit(t, (ctx) => addSheet(ctx), { addSheetOp: true });
    if (roll === 6) return tabEdit(t, (ctx) => copySheet(ctx, sheet.id), { addSheetOp: true });
    if (roll === 7 && sheets.filter((s) => s.hide !== 1).length > 1) {
        return tabEdit(t, (ctx) => deleteSheet(ctx, sheet.id), { deleteSheetOp: { id: sheet.id } });
    }
    if (roll === 8) {
        const op = { id: sheet.id, name: `Tab ${step}` };
        return tabEdit(t, (ctx) => renameSheet(ctx, op), { renameSheetOp: { id: sheet.id } });
    }
    const { rows, columns } = sizeOf(sheet);
    const value = rnd.chance(0.5) ? `${rnd.int(50)}` : `=A${1 + rnd.int(rows)}+${rnd.int(9)}`;
    if (sheet.hide === 1) return [];
    return tabEdit(
        t,
        (ctx) => {
            changeSheet(ctx, sheet.id);
            typed(rnd.int(rows), 1 + rnd.int(Math.max(1, columns - 1)), value)(ctx);
        },
        {},
    );
}

// The Workbook's replay of the log from the tab's first sheets, as a late peer batch makes it.
function replay(t: Tab, base: Sheet[], log: Op[][]) {
    const history = t.history;
    generateAPIs(
        () => t.ctx,
        (recipe) => {
            t.ctx = produce(t.ctx, recipe);
        },
        () => {},
        () => {},
        history,
    ).replayOps(base.map(withMaterializedData), log, new Set());
}

// A value with its keys sorted and nothing undefined, so two equal states print alike.
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return Array.from(value, canonical);
    if (!isRecord(value)) return value;
    const keys = Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== 'function');
    return Object.fromEntries(keys.sort().map((key) => [key, canonical(value[key])]));
}

const printed = (value: unknown) => JSON.stringify(canonical(value));

// The sheets as a reader holds them, the matrix as stored cells, so the editor and a joiner compare.
const stored = (sheets: Sheet[]) =>
    printed(
        sheets.map(({ data, celldata, ...sheet }) => ({ ...sheet, cells: data ? dataToCelldata(data) : celldata })),
    );

// The sheets in tab order: an undone delete puts its sheet back last in the list.
const inOrder = (sheets: Sheet[]) => printed(sheets.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)));

// What a browser opening the workbook holds once the server folded the first `at` batches of `log`. The fold is
// compactSheetsSnapshot's in apps/api, which this package can't import: the snapshot and the log go to it as JSON text,
// it replays a batch at a time and stores the result with the flag it read.
function joined(base: Sheet[], log: Op[][], at: number): Sheet[] {
    const { sheets, computed } = decodeOrDefault(encodeSheetsSnapshot(base, { computed: true }));
    const entries: unknown[] = JSON.parse(JSON.stringify(log.slice(0, at)));
    let folded = sheets;
    for (const step of replaySheetsSteps(sheets, entries.map(sheetsBatchOf))) folded = step.sheets;
    const snapshot = encodeSheetsSnapshot(folded, { computed });
    return replaySheetsOps(decodeSheetsWorkbook(snapshot).sheets, log.slice(at), () => {});
}

function run(seed: number) {
    let uuid = 0;
    spyOn(crypto, 'randomUUID').mockImplementation(
        (): `${string}-${string}-${string}-${string}-${string}` =>
            `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, '0')}`,
    );
    const rnd = random(seed);
    const base = start(rnd);
    const t = editor(base);
    const log: Op[][] = [];
    const logged = (ops: Op[]) => {
        if (ops.length > 0) log.push(ops);
        return ops;
    };
    let whole = '';
    for (let step = 0; step < STEPS; step += 1) {
        const roll = rnd.int(40);
        if (roll < 8) {
            tabReceive(t, logged(nextBatch(rnd, t.ctx.sheets, step)));
        } else if (roll < 11) {
            tabReceive(t, logged(extrasBatch(rnd, t.ctx.sheets, step)));
        } else if (roll < 24) {
            logged(authorEdit(rnd, t, step));
        } else if (roll < 32) {
            logged(tabUndo(t));
        } else if (roll < 37) {
            logged(tabRedo(t));
        } else if (roll < 39) {
            const visible = t.ctx.sheets.filter((s) => s.hide !== 1);
            const id = rnd.pick(visible).id;
            t.ctx = produce(t.ctx, (ctx: Context) => changeSheet(ctx, id));
        } else {
            replay(t, base, log);
        }
        const held = inOrder(t.ctx.sheets);
        if (logged(tabUndo(t)).length > 0) {
            expect(logged(tabRedo(t)).length, `seed ${seed}, step ${step}: the redo`).toBeGreaterThan(0);
            expect(inOrder(t.ctx.sheets), `seed ${seed}, step ${step}: an undo and a redo`).toBe(held);
        }
        whole = stored(replaySheetsOps(base, log));
        expect(stored(t.ctx.sheets), `seed ${seed}, step ${step}: the replay`).toBe(whole);
    }
    for (let fold = 0; fold < FOLDS; fold += 1) {
        const at = rnd.int(log.length + 1);
        expect(stored(joined(base, log, at)), `seed ${seed}: a join after a fold of ${at} batches`).toBe(whole);
    }
}

describe("one tab's run of its own edits and a peer's batches", () => {
    test.each(SEEDS)(
        'seed %i: the tab and a joiner after a fold hold the replay of its log, and an undo and a redo cancel',
        run,
    );
});

// A log alone, no tab, with formulas that read themselves among its batches: after every batch a joiner after a fold
// at a random place must hold the replay.
function loops(seed: number) {
    const rnd = random(seed);
    const base = start(rnd);
    const log: Op[][] = [];
    let sheets = base;
    for (let step = 0; step < LOOP_STEPS; step += 1) {
        const roll = rnd.int(10);
        log.push(
            roll < 6
                ? nextLoopBatch(rnd, sheets)
                : roll < 9
                  ? nextBatch(rnd, sheets, step)
                  : extrasBatch(rnd, sheets, step),
        );
        sheets = replaySheetsOps(base, log, () => {});
        const at = rnd.int(log.length + 1);
        expect(
            stored(joined(base, log, at)),
            `seed ${seed}: a join after a fold of ${at} of ${log.length} batches`,
        ).toBe(stored(sheets));
    }
}

describe('a log with formulas that read themselves', () => {
    test.each(LOOP_SEEDS.filter((seed) => !PARTED_LOOP_SEEDS.includes(seed)))(
        'seed %i: a joiner after a fold holds the replay of the log',
        loops,
    );
    test.failing.each(PARTED_LOOP_SEEDS)('seed %i: a joiner after a fold holds the replay of the log', loops);
});

// What a peer's batch does to the view of a tab on s1.
describe("a peer's batch and the view", () => {
    test('each row op of a batch moves the selection on the grid that op left', () => {
        const t = editor(start(random(5)));
        t.ctx = produce(t.ctx, (ctx: Context) => {
            ctx.selections = selectionFactory([8, 8], [1, 1], 8, 1);
        });
        tabReceive(t, [
            { op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 8, end: 8 } },
            {
                op: 'insertRowCol',
                id: 's1',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ]);
        expect(t.ctx.selections).toEqual(selectionFactory([8, 8], [1, 1], 8, 1));
    });

    test('a delete of the current sheet moves the tab to the first visible one', () => {
        const t = editor(start(random(5)));
        tabReceive(t, [{ op: 'deleteSheet', id: 's1', path: [], value: { id: 's1' } }]);
        expect(t.ctx.currentSheetId).toBe('s2');
    });

    test('a hide of the current sheet moves the tab to the first visible one', () => {
        const t = editor(start(random(5)));
        tabReceive(t, [{ op: 'replace', id: 's1', path: ['hide'], value: 1 }]);
        expect(t.ctx.currentSheetId).toBe('s2');
    });

    test('a sheet deleted and added back by id in one batch is the added one, where the replay puts it', () => {
        const base = start(random(5));
        const t = editor(base);
        const again: Sheet = {
            id: 's2',
            name: 'Again',
            order: 1,
            celldata: [{ r: 0, c: 0, v: number(1) }],
            config: {},
        };
        const batch: Op[] = [
            { op: 'deleteSheet', id: 's2', path: [], value: { id: 's2' } },
            { op: 'addSheet', id: 's2', path: [], value: again },
        ];
        tabReceive(t, batch);
        expect(t.ctx.sheets.map(({ id, name }) => [id, name])).toEqual([
            ['s1', 'One'],
            ['s3', 'Three'],
            ['s2', 'Again'],
        ]);
        expect(stored(t.ctx.sheets)).toBe(stored(replaySheetsOps(base, [batch])));
    });
});

// The author's structural edits as their menus run them, on a sheet a chart on another sheet reads.
const insert = (type: 'row' | 'column') => {
    const op = { type, index: 2, count: 2, direction: 'lefttop', id: 's2' } as const;
    return [(ctx: Context) => tryInsertRowCol(ctx, op), { insertRowColOp: op }] as const;
};
const remove = (type: 'row' | 'column', id = 's2') => {
    const op = { type, start: 1, end: 2, id } as const;
    return [(ctx: Context) => tryDeleteRowCol(ctx, op), { deleteRowColOp: op }] as const;
};
const STRUCTURAL = [
    ['a row insert', insert('row')],
    ['a column insert', insert('column')],
    ['a row delete', remove('row')],
    ['a column delete', remove('column')],
    ['a row delete through a merge', remove('row', 's3')],
    ['a sheet add', [(ctx: Context) => addSheet(ctx), { addSheetOp: true }]],
    ['a sheet copy', [(ctx: Context) => copySheet(ctx, 's1'), { addSheetOp: true }]],
    ['a sheet delete', [(ctx: Context) => deleteSheet(ctx, 's2'), { deleteSheetOp: { id: 's2' } }]],
    [
        'a sheet rename',
        [(ctx: Context) => renameSheet(ctx, { id: 's2', name: 'Renamed' }), { renameSheetOp: { id: 's2' } }],
    ],
] as const;

// A peer's cell edit with the values its author computed.
const peerEdit = (t: Tab) =>
    withAuthorValues(t.ctx.sheets, [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: number(7) }]);

describe("an author's row, column or sheet edit", () => {
    test.each(STRUCTURAL)('%s undoes and redoes exactly, after a peer batch', (_, [recipe, options]) => {
        spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000009');
        const t = editor(start(random(5)));
        tabReceive(t, peerEdit(t));
        const before = inOrder(t.ctx.sheets);
        expect(tabEdit(t, recipe, options).length).toBeGreaterThan(0);
        const after = inOrder(t.ctx.sheets);
        expect(after).not.toBe(before);
        expect(tabUndo(t).length).toBeGreaterThan(0);
        expect(inOrder(t.ctx.sheets)).toBe(before);
        expect(tabRedo(t).length).toBeGreaterThan(0);
        expect(inOrder(t.ctx.sheets)).toBe(after);
        expect(tabUndo(t).length).toBeGreaterThan(0);
        expect(inOrder(t.ctx.sheets)).toBe(before);
    });

    test.each(STRUCTURAL)("%s and the edits before it can't be undone once a peer's batch applied", (_, edit) => {
        spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000009');
        const t: Tab & { history: { cutByPeer?: { undo: boolean; redo: boolean } } } = editor(start(random(5)));
        tabEdit(t, typed(0, 1, '3'), {});
        tabEdit(t, edit[0], edit[1]);
        tabReceive(t, peerEdit(t));
        expect(t.history.undoList).toEqual([]);
        expect(t.history.cutByPeer?.undo).toBe(true);
        const held = printed(t.ctx.sheets);
        expect(tabUndo(t)).toEqual([]);
        expect(printed(t.ctx.sheets)).toBe(held);
    });

    test.each(STRUCTURAL)("%s takes a peer's batch made before it, as a joiner reads the log", (_, edit) => {
        spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000009');
        const base = start(random(5));
        const t = editor(base);
        const mine = tabEdit(t, edit[0], edit[1]);
        // The peer wrote on the workbook it held before the edit reached it, below the rows the edit moves.
        const theirs: Op[] = [{ op: 'replace', id: 's2', path: ['data', 6, 1], value: number(4) }];
        tabReceive(t, theirs);
        expect(stored(t.ctx.sheets)).toBe(stored(replaySheetsOps(base, [mine, theirs])));
    });
});
