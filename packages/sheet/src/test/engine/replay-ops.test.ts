import { describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { createDefaultSheets, DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from '../../engine/defaults';
import { replaySheetsOps } from '../../engine/replay-ops';
import type { EditorSheetConfigExtras } from '../../engine/types';

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
        // never refresh `celldata`, so a flushed snapshot has fresh data and
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
        // Mirrors how patchToOp emits real batches: the special row/col op is
        // pushed first, and the cell patches that follow already reference
        // post-insert row/col indices (additionalCellOps, mergeOps).
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
        // The persisted snapshot (xlsxToSheets / FE flushSnapshot before
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
                { op: 'replace', id: 's1', path: ['name'], value: 'A*' },
            ],
        ];
        const [r1, r2] = replaySheetsOps([s1, s2], ops);
        expect(r1.name).toBe('A*');
        expect(r1.data![0][0]?.v).toBe('a1');
        expect(r2.name).toBe('B');
        expect(r2.data![0][0]?.v).toBe('b1*');
    });

    test('addSheet then patch on the new sheet applies in order', () => {
        const cell = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
        const s1: Sheet = { id: 's1', name: 'A', order: 0, data: [[cell('a')]], config: {} };
        const newSheet: Sheet = { id: 's2', name: 'B', order: 1, data: [[null]], config: {} };
        const ops: Op[][] = [
            [
                { op: 'addSheet', path: [], value: newSheet },
                { op: 'replace', id: 's2', path: ['name'], value: 'B*' },
            ],
        ];
        const result = replaySheetsOps([s1], ops);
        expect(result).toHaveLength(2);
        expect(result[1].id).toBe('s2');
        expect(result[1].name).toBe('B*');
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
                { op: 'replace', id: 's2', path: ['name'], value: 'orphan' },
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

    test('engine readOnly throw is caught and op skipped on the replay path', () => {
        // The engine throws RowColError as a UI-layer signal. On the BE replay
        // path they must not propagate, or every export/preview crashes when an
        // op queue happens to target a readOnly row.
        const sheet: Sheet & { config?: EditorSheetConfigExtras } = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
            config: { rowReadOnly: { 0: 1 } },
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
        // Row insert was skipped (no shift), but the companion patch still applied.
        expect(result[0].data!.length).toBe(1);
        expect(result[0].data![0][0]?.v).toBe('b');
    });

    test('cell op beyond the celldata extent applies over the default editor grid', () => {
        // Reproduces the unloadable-doc bug: a fresh doc whose tab was killed
        // before the first flushSnapshot has pending ops but no snapshot, so
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
            [{ op: 'replace', id: 's1', path: ['name'], value: 'after' }],
        ];
        const result = replaySheetsOps([sheet], ops);
        expect(result[0].data!.length).toBe(1);
        expect(result[0].data![0][0]?.v).toBe('first');
        expect(result[0].name).toBe('after');
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

// A granular config patch (`['config','rowlen','2']`) only resolves if the collection already
// exists. Every document written before the editor started materializing them — and every
// fresh doc before its first snapshot flush — stores `config: {}`, so the replay base must
// materialize them too. Without this, replaySheetsOps throws "path doesn't resolve" and rolls
// back the WHOLE batch: the edit is lost, not degraded, on every reader (a second client
// opening the doc, the preview renderer, and every xlsx/HTML/PDF export).
describe('config ops from a normalizing editor apply to an un-normalized stored sheet', () => {
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
