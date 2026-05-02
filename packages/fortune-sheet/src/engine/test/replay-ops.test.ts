import { describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { replaySheetsOps } from '../replay-ops';

const baseSheet = (id: string, name: string): Sheet => ({ id, name, order: 0, data: [[null]], config: {} });

describe('replaySheetsOps', () => {
    test('empty opBatches returns input by reference', () => {
        const sheets = [baseSheet('s1', 'Sheet1')];
        expect(replaySheetsOps(sheets, [])).toBe(sheets);
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

    test('FE-emitted [luckysheetfile] wholesale replace is dropped, paired insertRowCol applies', () => {
        // Reproduces the export crash: row/col mutations in fortune-sheet's
        // reducer reassign ctx.luckysheetfile, so immer emits a synthetic
        // wholesale-replace patch alongside the insertRowCol special op. The
        // synthetic patch has no sheet id and a path of ['luckysheetfile']
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
                { op: 'replace', path: ['luckysheetfile'], value: [{ ...sheet }] },
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
        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('a');
        // celldata is resynced from the materialized data so downstream consumers see the shifted row.
        expect(result[0].celldata).toEqual([{ r: 1, c: 0, v: { v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } } }]);
    });

    test('engine readOnly throw is caught and op skipped on the replay path', () => {
        // The engine throws bare Error('readOnly') / Error('maxExceeded') as
        // signals for the UI layer. On the BE replay path they must not
        // propagate, or every export/preview crashes when an op queue happens
        // to target a readOnly row.
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
            // biome-ignore lint/suspicious/noExplicitAny: rowReadOnly lives on state's ExtendedSheetConfig
            config: { rowReadOnly: { 0: 1 } } as any,
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
