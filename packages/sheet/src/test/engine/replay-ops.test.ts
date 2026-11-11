import { describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    createDefaultSheets,
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
    MAX_SHEET_ROW_COUNT,
} from '../../engine/defaults';
import { replaySheetsOps } from '../../engine/replay-ops';

const baseSheet = (id: string, name: string): Sheet => ({ id, name, order: 0, data: [[null]], config: {} });

describe('replaySheetsOps', () => {
    test('empty opBatches: celldata-only sheet passes through unchanged', () => {
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }],
            config: {},
        };
        const result = replaySheetsOps([sheet], []);
        expect(result[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }]);
        expect(result[0].data).toBeUndefined();
    });

    test('empty opBatches: snapshot with fresh data + stale celldata gets celldata resynced', () => {
        // Repro for the empty-export bug: FE state edits update `data` but
        // never refresh `celldata`, so a snapshot has fresh data and
        // stale (often empty) celldata. Without ops, replay must still sync
        // celldata — otherwise HTML/PDF/XLSX exports come out empty.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'hello', m: 'hello', ct: { fa: 'General', t: 'g' } }]],
            celldata: [], // stale: editor never updated it after the user typed "hello"
            config: {},
        };
        const result = replaySheetsOps([sheet], []);
        expect(result[0].celldata).toEqual([
            { r: 0, c: 0, v: { v: 'hello', m: 'hello', ct: { fa: 'General', t: 'g' } } },
        ]);
    });

    test('addSheet appends a sheet', () => {
        const sheets = [baseSheet('s1', 'Sheet1')];
        const newSheet = baseSheet('s2', 'Sheet2');
        const ops: Op[][] = [[{ op: 'addSheet', path: [], value: newSheet }]];
        const result = replaySheetsOps(sheets, ops);
        expect(result).toHaveLength(2);
        expect(result[1].id).toBe('s2');
    });

    test('a sheet an addSheet op introduces is materialized like the replay base', () => {
        // The editor writes each image and chart under its own key and each config entry the same way, so a
        // patch against a sheet that lacks the map fails to resolve and drops the batch.
        const ops: Op[][] = [[{ op: 'addSheet', path: [], value: baseSheet('s2', 'Sheet2') }]];
        const [base, added] = replaySheetsOps([baseSheet('s1', 'Sheet1')], ops);
        expect(added.images).toEqual({});
        expect(added.charts).toEqual({});
        expect(added.config).toEqual(base.config);
    });

    test("an image's first write replays on a base stored without images", () => {
        const image = { id: 'i1', index: 'a0', x: 0, y: 0, width: 40, height: 30, mediaName: 'a.png' };
        const ops: Op[][] = [[{ op: 'add', id: 's1', path: ['images', 'i1'], value: image }]];
        expect(replaySheetsOps([baseSheet('s1', 'Sheet1')], ops)[0].images).toEqual({ i1: image });
    });

    test('deleteSheet filters by id', () => {
        const sheets = [baseSheet('s1', 'Sheet1'), baseSheet('s2', 'Sheet2')];
        const ops: Op[][] = [[{ op: 'deleteSheet', id: 's1', path: [] }]];
        const result = replaySheetsOps(sheets, ops);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s2');
    });

    test('insertRowCol shifts the target sheet', () => {
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
            config: {},
        };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('a');
    });

    test('insertRowCol shifts borderInfo with the other config collections, no whole-config op needed', () => {
        const side = { style: 1, color: '#000' };
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[null], [null]],
            config: { borderInfo: { '0_0': { t: side }, '1_0': { b: side } } },
        };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].config?.borderInfo).toEqual({ '0_0': { t: side }, '1_0': { t: side }, '2_0': { b: side } });
    });

    test('deleteRowCol shrinks the target sheet', () => {
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [
                [{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }],
                [{ v: 'b', m: 'b', ct: { fa: 'General', t: 'g' } }],
            ],
            config: {},
        };
        const ops: Op[][] = [
            [
                {
                    op: 'deleteRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', start: 0, end: 0 },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(1);
        expect(result[0].data![0][0]?.v).toBe('b');
    });

    test('mixed batch: insertRowCol runs before companion patches (post-mutation positions)', () => {
        // As an undo's batch holds them: the row op first, and the cell patches after it at post-insert indices.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'old', m: 'old', ct: { fa: 'General', t: 'g' } }]],
            config: {},
        };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
                { op: 'replace', id: 's1', path: ['data', 1, 0, 'v'], value: 'new' },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('new');
    });

    test('insertRowCol with malformed value warns and skips', () => {
        const sheet = baseSheet('s1', 'Sheet1');
        const ops: Op[][] = [[{ op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index: 0 } }]];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(1);
    });

    test('deleteRowCol with malformed value warns and skips', () => {
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
            config: {},
        };
        const ops: Op[][] = [[{ op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row' } }]];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(1);
    });

    test('celldata-only snapshot: data is materialized so cell ops can apply', () => {
        // The persisted snapshot (xlsxToSheets / an FE snapshot from before
        // materialization) typically carries celldata only. Patches reference
        // ['data', r, c]; without internal materialization applyPatches throws
        // "path doesn't resolve". Verifies the BE export and FE startup paths.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }],
            config: {},
        };
        const ops: Op[][] = [[{ op: 'replace', id: 's1', path: ['data', 0, 0, 'v'], value: 'b' }]];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data![0][0]?.v).toBe('b');
        // celldata is refreshed from data so consumers (xlsx export) see updates.
        expect(result[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 'b', m: 'a', ct: { fa: 'General', t: 'g' } } }]);
    });

    test('FE-emitted [sheets] wholesale replace is dropped, paired insertRowCol applies', () => {
        // Reproduces the export crash: row/col mutations in the sheet
        // reducer reassign ctx.sheets, so immer emits a synthetic
        // wholesale-replace patch alongside the insertRowCol special op. The
        // synthetic patch has no sheet id and a path of ['sheets']
        // which is not applicable to a Sheet[] root (immer error 14).
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
            config: {},
        };
        const ops: Op[][] = [
            [
                { op: 'replace', path: ['sheets'], value: [{ ...sheet }] },
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('a');
    });

    test('multi-sheet batch: ops with id target the correct sheet, others untouched', () => {
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const s1: Sheet = { id: 's1', name: 'A', order: 0, data: [[cell('a1')]], config: {} };
        const s2: Sheet = { id: 's2', name: 'B', order: 1, data: [[cell('b1')]], config: {} };
        const ops: Op[][] = [
            [
                { op: 'replace', id: 's2', path: ['data', 0, 0, 'v'], value: 'b1*' },
                { op: 'replace', id: 's1', path: ['color'], value: 'red' },
            ],
        ];
        const [r1, r2] = replaySheetsOps([s1, s2], ops);
        expect(r1.color).toBe('red');
        expect(r1.data![0][0]?.v).toBe('a1');
        expect(r2.color).toBeUndefined();
        expect(r2.data![0][0]?.v).toBe('b1*');
    });

    test('addSheet then patch on the new sheet applies in order', () => {
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const s1: Sheet = { id: 's1', name: 'A', order: 0, data: [[cell('a')]], config: {} };
        const newSheet: Sheet = { id: 's2', name: 'B', order: 1, data: [[null]], config: {} };
        const ops: Op[][] = [
            [
                { op: 'addSheet', path: [], value: newSheet },
                { op: 'replace', id: 's2', path: ['color'], value: 'red' },
            ],
        ];
        const result = replaySheetsOps([s1], ops);
        expect(result).toHaveLength(2);
        expect(result[1].id).toBe('s2');
        expect(result[1].color).toBe('red');
    });

    test('patch on a sheet that was deleted in the same batch is dropped', () => {
        // opToPatchOnSheets locates target by id; after deleteSheet special op
        // runs the id is gone, so the patch can't resolve and is silently
        // skipped (vs throwing). Guards against orphan-patch crashes when the
        // FE batches a delete with stale companion ops.
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const s1: Sheet = { id: 's1', name: 'A', order: 0, data: [[cell('a')]], config: {} };
        const s2: Sheet = { id: 's2', name: 'B', order: 1, data: [[cell('b')]], config: {} };
        const ops: Op[][] = [
            [
                { op: 'deleteSheet', id: 's2', path: [] },
                { op: 'replace', id: 's2', path: ['color'], value: 'red' },
            ],
        ];
        const result = replaySheetsOps([s1, s2], ops);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s1');
    });

    test('celldata-only sheet + insertRowCol materializes data and applies', () => {
        // Persisted snapshots typically carry celldata only. A queued insertRowCol
        // bypasses path-based materialization (its path is []), so without
        // including row/col ops in collectDataOpSheetIds the engine would see
        // target.data === undefined and silently no-op. This regression test
        // pins the materialization behavior.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }],
            config: {},
        };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        // Materialization expands to the default editor grid (the dimensions
        // the op was recorded against), then the insert adds one row.
        expect(result[0].data!.length).toBe(DEFAULT_SHEET_ROW_COUNT + 1);
        expect(result[0].data![0].length).toBe(DEFAULT_SHEET_COLUMN_COUNT);
        expect(result[0].data![1][0]?.v).toBe('a');
        // celldata is resynced from the materialized data so downstream consumers see the shifted row.
        expect(result[0].celldata).toEqual([{ r: 1, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }]);
    });

    test('an insert past the row limit skips its whole batch on the replay path', () => {
        // The engine refuses the insert with a RowColError. The replay must not crash on it, or every export and
        // preview would, and the batch's other ops were written for the rows the insert would have moved.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [
                [{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }],
                ...Array.from({ length: MAX_SHEET_ROW_COUNT - 1 }, () => [null]),
            ],
        };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
                { op: 'replace', id: 's1', path: ['data', 0, 0, 'v'], value: 'b' },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(MAX_SHEET_ROW_COUNT);
        expect(result[0].data![0][0]?.v).toBe('a');
    });

    test('cell op beyond the celldata extent applies over the default editor grid', () => {
        // Reproduces the unloadable-doc bug: a fresh doc closed
        // before its first compaction has pending ops but no snapshot, so
        // replay starts from the default sheets (celldata-only, no row/column).
        // The editor that emitted the ops worked on a grid expanded to the
        // default dimensions — patches at row/col ≥ 1 must still resolve.
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const ops: Op[][] = [[{ op: 'replace', id: 'sheet-1', path: ['data', 1, 1], value: cell('b2') }]];
        const result = replaySheetsOps(createDefaultSheets(), ops);
        expect(result[0].data!.length).toBe(DEFAULT_SHEET_ROW_COUNT);
        expect(result[0].data![0].length).toBe(DEFAULT_SHEET_COLUMN_COUNT);
        expect(result[0].data![1][1]?.v).toBe('b2');
    });

    test('a batch whose patches cannot resolve is skipped, earlier and later batches still apply', () => {
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const sheet: Sheet = { id: 's1', name: 'Sheet1', order: 0, data: [[cell('a')]], config: {} };
        const ops: Op[][] = [
            [{ op: 'replace', id: 's1', path: ['data', 0, 0, 'v'], value: 'first' }],
            // data is already materialized at 1×1, so row 5 can't resolve —
            // applyPatches throws and the batch must be skipped, not the doc.
            [{ op: 'replace', id: 's1', path: ['data', 5, 0, 'v'], value: 'poison' }],
            [{ op: 'replace', id: 's1', path: ['color'], value: 'red' }],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(1);
        expect(result[0].data![0][0]?.v).toBe('first');
        expect(result[0].color).toBe('red');
    });

    test('addSheet with a config that is no map adds nothing, as the tab adds nothing', () => {
        for (const config of [5, 'x', true, []]) {
            const value = { id: 's2', name: 'B', config };
            const ops: Op[][] = [[{ op: 'addSheet', id: 's2', path: [], value }]];
            expect(replaySheetsOps([baseSheet('s1', 'A')], ops).map(({ id }) => id)).toEqual(['s1']);
        }
        const value = { id: 's2', name: 'B', config: null };
        const ops: Op[][] = [[{ op: 'addSheet', id: 's2', path: [], value }]];
        expect(replaySheetsOps([baseSheet('s1', 'A')], ops).map(({ id }) => id)).toEqual(['s1', 's2']);
    });

    test('addSheet mid-replay with a celldata-only value is materialized for later data ops', () => {
        // copySheet emits addSheet values carrying celldata only (data is
        // deleted, row/column absent when the source sheet had none). A later
        // batch's data-path op on that sheet must trigger materialization —
        // the up-front pass only sees the base sheets.
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const s1: Sheet = { id: 's1', name: 'A', order: 0, data: [[cell('a')]], config: {} };
        const newSheet: Sheet = { id: 's2', name: 'B', order: 1, celldata: [{ r: 0, c: 0, v: cell('b') }], config: {} };
        const ops: Op[][] = [
            [{ op: 'addSheet', id: 's2', path: [], value: newSheet }],
            [{ op: 'replace', id: 's2', path: ['data', 1, 1], value: cell('b2') }],
        ];
        const result = replaySheetsOps([s1], ops);
        expect(result).toHaveLength(2);
        expect(result[1].data![0][0]?.v).toBe('b');
        expect(result[1].data![1][1]?.v).toBe('b2');
    });

    test('multiple batches apply sequentially', () => {
        const sheet: Sheet = { id: 's1', name: 'Sheet1', order: 0, data: [[null]], config: {} };
        const ops: Op[][] = [
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
            [
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(3);
    });
});

// Two tabs pressing + at once both name the new tab Sheet2, and nothing either typed may be lost. Two sheets of one
// name would let a delete or a rename of one break or repoint the formulas reading the other.
describe('a sheet added under a name it cannot take', () => {
    test.each([
        ['past the length limit', 'x'.repeat(32), 'x'.repeat(31)],
        ['with a colon', 'a:b', 'a_b'],
        ['with a quote at its end', "x'", 'x'],
        ['empty', '', 'Sheet1'],
    ])('a name %s is repaired, as an import repairs it', (_, name, repaired) => {
        const added: Op = { op: 'addSheet', id: 's2', path: [], value: baseSheet('s2', name) };
        expect(replaySheetsOps([baseSheet('s1', 'One')], [[added]]).map((sheet) => sheet.name)).toEqual([
            'One',
            repaired,
        ]);
    });

    test('a name a sheet already has, in any case, takes the next free one, and formulas read the first', () => {
        const add = (id: string, name: string): Op[] => [{ op: 'addSheet', id, path: [], value: baseSheet(id, name) }];
        const typedInB: Op[] = [{ op: 'replace', id: 'b', path: ['data', 0, 0], value: { v: 7, m: '7' } }];
        const typed: Op[] = [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: { f: '=Sheet2!A1', v: 0 } }];
        const gone: Op[] = [{ op: 'deleteSheet', id: 'b', path: [] }];
        const batches = [add('a', 'Sheet2'), add('b', 'Sheet2'), add('c', 'SHEET2'), typedInB, typed];
        const replayed = replaySheetsOps([baseSheet('s1', 'One')], batches);
        expect(replayed.map((sheet) => [sheet.id, sheet.name])).toEqual([
            ['s1', 'One'],
            ['a', 'Sheet2'],
            ['b', 'Sheet2 (2)'],
            ['c', 'SHEET2 (3)'],
        ]);
        expect(replayed[2].data?.[0]?.[0]?.v).toBe(7);
        const afterDelete = replaySheetsOps([baseSheet('s1', 'One')], [...batches, gone]);
        expect(afterDelete[0].data?.[0]?.[0]?.f).toBe('=Sheet2!A1');
    });
});

// A granular patch into a collection (`['config','rowlen','2']`) only resolves if the collection
// already exists. Every document written before the editor started materializing them — and every
// fresh doc before its first compaction — stores `config: {}`, so the replay base must materialize
// them too. Without this,
// replaySheetsOps throws "path doesn't resolve" and rolls back the WHOLE batch: the edit is
// lost, not degraded, on every reader (a second client opening the doc, the preview renderer,
// and every xlsx/HTML/PDF export).
describe('ops from a normalizing editor apply to an un-normalized stored sheet', () => {
    const storedBeforeThisBranch = (): Sheet[] => [{ name: 'Sheet1', id: 'id_1', order: 0, celldata: [], config: {} }];

    test('a granular row-height op resolves and is kept', () => {
        const out = replaySheetsOps(storedBeforeThisBranch(), [
            [{ op: 'add', id: 'id_1', path: ['config', 'rowlen', '2'], value: 53 }],
        ]);
        expect(out[0].config?.rowlen).toEqual({ 2: 53 });
    });

    test('a granular border op resolves and is kept', () => {
        const out = replaySheetsOps(storedBeforeThisBranch(), [
            [
                {
                    op: 'add',
                    id: 'id_1',
                    path: ['config', 'borderInfo', '0_0'],
                    value: { l: { style: 1, color: '#000' } },
                },
            ],
        ]);
        expect(out[0].config?.borderInfo).toEqual({ '0_0': { l: { style: 1, color: '#000' } } });
    });

    test('a sheet added mid-session takes ops on its config too', () => {
        const out = replaySheetsOps(storedBeforeThisBranch(), [
            [{ op: 'addSheet', id: 'id_2', path: [], value: { name: 'S2', id: 'id_2', order: 1, celldata: [] } }],
            [{ op: 'add', id: 'id_2', path: ['config', 'merge', '0_0'], value: { r: 0, c: 0, rs: 2, cs: 2 } }],
        ]);
        expect(out[1].config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
    });
});

// A peer deletes a rule while another tab shrinks it, and the log holds the delete first. The shrink's whole-entry
// write saw the rule, so on a sheet without it the delete wins, the same on every tab and in the replay.
describe('a rule a peer deleted', () => {
    test('stays deleted when a whole-entry write of it comes later in the log', () => {
        const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
        const base: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            celldata: [],
            row: 5,
            column: 2,
            config: {},
            dataValidations: { x: { ranges: [{ row: [0, 3], column: [0, 0] }], rule } },
        };
        const shrunk = { ranges: [{ row: [0, 1], column: [0, 0] }], rule };
        const [sheet] = replaySheetsOps(
            [base],
            [
                [{ op: 'remove', id: 's1', path: ['dataValidations', 'x'] }],
                [{ op: 'replace', id: 's1', path: ['dataValidations', 'x'], value: shrunk }],
            ],
        );
        expect(sheet.dataValidations).toEqual({});
    });
});

// A write into something a peer deleted or cleared finds no parent on any reader, so that write alone is skipped. The
// rest of its batch was written for cells and fields that are still there.
describe('a write whose parent is gone', () => {
    const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
    const image = { id: 'i1', index: 'a0', x: 10, y: 20, width: 40, height: 30, mediaName: 'i1.png' };
    const base = (): Sheet => ({
        id: 's1',
        name: 'Sheet1',
        order: 0,
        data: [
            [cell('a'), null],
            [null, null],
        ],
        config: {},
        images: { i1: image },
    });
    const kept: Op = { op: 'replace', id: 's1', path: ['data', 0, 1], value: cell('kept') };

    test.each<[string, Op['op'], Op['path'], unknown]>([
        ['a field of a cell a peer cleared', 'add', ['data', 1, 1, 'bg'], '#ff0000'],
        ['a cell on a row a peer deleted', 'replace', ['data', 5, 0], cell('x')],
        ['a field of a cell on a row a peer deleted', 'replace', ['data', 5, 0, 'v'], 'x'],
        ['a row past the matrix', 'replace', ['data', 50], [cell('x'), null]],
        ['a cell past its row', 'replace', ['data', 0, 9], cell('x')],
        ['a matrix made longer by its length', 'replace', ['data', 'length'], 50],
        ['a write below a field of an image', 'replace', ['images', 'i1', 'x', 'y'], 1],
        ['a field of an image a peer deleted', 'replace', ['images', 'gone', 'x'], 1],
        ['an entry of a filter a peer cleared', 'add', ['filter', '1'], { rows: [1] }],
        ['a key every object inherits', 'add', ['config', '__proto__'], { polluted: true }],
    ])('%s is skipped, and the rest of its batch applies', (_, op, path, value) => {
        const dropped: unknown[] = [];
        for (const batch of [
            [{ op, id: 's1', path, value }, kept],
            [kept, { op, id: 's1', path, value }],
        ]) {
            const [sheet] = replaySheetsOps([base()], [batch], (e) => dropped.push(e));
            expect(sheet.data).toHaveLength(2);
            expect(sheet.data).toEqual([
                [cell('a'), cell('kept')],
                [null, null],
            ]);
            expect(sheet.images).toEqual({ i1: image });
            expect(sheet).not.toHaveProperty('filter');
            expect(Object.getPrototypeOf(sheet.config)).toBe(Object.prototype);
        }
        expect(dropped).toEqual([]);
    });

    test('a batch of only such writes hands the sheets back as they were', () => {
        const [sheet] = replaySheetsOps(
            [base()],
            [[{ op: 'add', id: 's1', path: ['data', 1, 1, 'bg'], value: '#ff0000' }]],
        );
        expect(sheet.data).toEqual(base().data);
    });

    test('a refused row op still rolls its whole batch back', () => {
        const dropped: unknown[] = [];
        const refused: Op = { op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index: -1 } };
        const [sheet] = replaySheetsOps([base()], [[kept, refused]], (e) => dropped.push(e));
        expect(dropped).toHaveLength(1);
        expect(sheet.data).toEqual(base().data);
    });

    test('a shorter length cuts an array, as the undo of a grown one writes it', () => {
        const [sheet] = replaySheetsOps([base()], [[{ op: 'replace', id: 's1', path: ['data', 'length'], value: 1 }]]);
        expect(sheet.data).toEqual([[cell('a'), null]]);
    });
});

// A peer can write anything as a sheet's matrix or one of its rows, and every reader of the replay walks the matrix.
// Such a write is dropped, so one op can't make the workbook unreadable, and the cells of its batch still arrive.
describe('a write that would leave the matrix or a row no array', () => {
    const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
    test.each([
        ['a row written as null', ['data', 0], null],
        ['a row written as text', ['data', 1], 'x'],
        ['the matrix written as text', ['data'], 'x'],
        ['the matrix written as a number', ['data'], 5],
    ])('%s', (_, path, value) => {
        const base: Sheet = { id: 's1', name: 'Sheet1', order: 0, celldata: [], row: 3, column: 2, config: {} };
        const [sheet] = replaySheetsOps(
            [base],
            [
                [
                    { op: 'replace', id: 's1', path: ['data', 2, 0], value: cell('a') },
                    { op: 'replace', id: 's1', path, value },
                ],
            ],
        );
        expect(sheet.data?.length).toBe(3);
        expect(sheet.data?.every((row) => Array.isArray(row))).toBe(true);
        expect(sheet.celldata).toEqual([{ r: 2, c: 0, v: cell('a') }]);
    });
});

describe('a batch with two row ops', () => {
    test('recomputes what the first op touched at the rows the second moved it to', () => {
        const n = (v: number) => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });
        const data = [1, 2, 3, 4, 5, 6].map((v, r) => [n(v), r === 0 ? { f: '=SUM(A4:A6)', v: 15 } : null]);
        const sheet: Sheet = { id: 's1', name: 'One', order: 0, data, config: {} };
        const batch: Op[] = [
            { op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 4, end: 4 } },
            {
                op: 'insertRowCol',
                id: 's1',
                path: [],
                value: { type: 'row', index: 0, count: 2, direction: 'lefttop' },
            },
        ];
        const [replayed] = replaySheetsOps([sheet], [batch]);
        expect(replayed.data?.[2]?.[1]).toMatchObject({ f: '=SUM(A6:A7)', v: 10 });
    });
});

describe("a write to a sheet's own id or name", () => {
    const n = (v: number) => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });
    const sheets = (): Sheet[] => [
        { id: 's1', name: 'One', order: 0, data: [[n(1)]], config: {} },
        { id: 's2', name: 'Two', order: 1, data: [[{ f: '=One!A1*2', v: 2, m: '2' }]], config: {} },
    ];

    test('a forged id is dropped, so no two sheets share one', () => {
        const forged: Op[] = [{ op: 'replace', id: 's2', path: ['id'], value: 's1' }];
        const replayed = replaySheetsOps(sheets(), [forged]);
        expect(replayed.map((sheet) => sheet.id)).toEqual(['s1', 's2']);
    });

    test('a forged name is dropped, and later row ops still apply', () => {
        const forged: Op[] = [{ op: 'replace', id: 's2', path: ['name'], value: 7 }];
        const insert: Op[] = [
            {
                op: 'insertRowCol',
                id: 's1',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ];
        const dropped: unknown[] = [];
        const replayed = replaySheetsOps(sheets(), [forged, insert], (e) => dropped.push(e));
        expect(dropped).toEqual([]);
        expect(replayed.map((sheet) => sheet.name)).toEqual(['One', 'Two']);
        expect(replayed[1].data?.[0]?.[0]).toMatchObject({ f: '=One!A2*2', v: 2 });
    });
});

describe("a delete of a sheet's last lines", () => {
    const n = (v: number) => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });
    const remove = (type: 'row' | 'column', start: number, end: number): Op[] => [
        { op: 'deleteRowCol', id: 's1', path: [], value: { type, start, end } },
    ];

    test('recomputes a formula that read only the deleted rows', () => {
        const one: Sheet = { id: 's1', name: 'One', order: 0, data: [1, 2, 3, 4, 5].map((v) => [n(v)]), config: {} };
        const two: Sheet = { id: 's2', name: 'Two', order: 1, data: [[{ f: '=SUM(One!A4:A10)', v: 9 }]], config: {} };
        const [, replayed] = replaySheetsOps([one, two], [remove('row', 3, 4)]);
        expect(replayed.data?.[0]?.[0]).toMatchObject({ f: '=SUM(One!A4:A8)', v: 0 });
    });

    test('recomputes a whole-row reader when the last column goes', () => {
        const one: Sheet = { id: 's1', name: 'One', order: 0, data: [[n(1), n(2)]], config: {} };
        const two: Sheet = { id: 's2', name: 'Two', order: 1, data: [[{ f: '=SUM(One!1:1)', v: 3 }]], config: {} };
        const [, replayed] = replaySheetsOps([one, two], [remove('column', 1, 1)]);
        expect(replayed.data?.[0]?.[0]).toMatchObject({ f: '=SUM(One!1:1)', v: 1 });
    });

    // Two tabs deleting at once can ask for every line. A stored sheet reads no rows as the default size, so a fold
    // would part from the replay.
    test.each(['row', 'column'] as const)('a delete that would take every %s keeps the last', (type) => {
        const values = [n(1), n(2), n(3)];
        const data = type === 'row' ? values.map((v) => [v]) : [values];
        const one: Sheet = { id: 's1', name: 'One', order: 0, data, config: {} };
        const sum = type === 'row' ? '=SUM(One!A1:A3)' : '=SUM(One!A1:C1)';
        const two: Sheet = { id: 's2', name: 'Two', order: 1, data: [[{ f: sum, v: 6 }]], config: {} };
        const [left, reader] = replaySheetsOps([one, two], [remove(type, 2, 2), remove(type, 0, 1)]);
        expect(left.data).toEqual([[n(2)]]);
        expect([left.row, left.column]).toEqual(type === 'row' ? [1, undefined] : [undefined, 1]);
        expect(reader.data?.[0]?.[0]?.v).toBe(2);
    });

    test('a delete of the one line left changes nothing', () => {
        const one: Sheet = { id: 's1', name: 'One', order: 0, data: [[n(1)], [n(2)]], config: {} };
        const [left] = replaySheetsOps([one], [remove('row', 1, 1), remove('row', 0, 0)]);
        expect(left.data).toEqual([[n(1)]]);
    });
});
