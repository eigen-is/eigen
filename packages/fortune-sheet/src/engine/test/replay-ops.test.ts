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

    test('mixed batch: patch then insertRowCol applies in order', () => {
        const sheet: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            data: [[{ v: 'old', m: 'old', ct: { fa: 'General', t: 'g' } }]],
            config: {},
        };
        const ops: Op[][] = [
            [
                { op: 'replace', id: 's1', path: ['data', 0, 0, 'v'], value: 'new' },
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
        expect(result[0].data![1][0]?.v).toBe('new');
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
