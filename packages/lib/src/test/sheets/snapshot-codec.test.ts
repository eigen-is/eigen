import { describe, expect, test } from 'bun:test';
import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '../../sheets/snapshot-codec';
import type { Cell, CellWithRowAndCol, Sheet } from '../../sheets/types';

type SheetWithCalcChain = Sheet & { calcChain?: { r: number; c: number; id: string }[] };

type Envelope = {
    f: string;
    computed: boolean;
    styles: Record<string, unknown>[];
    borders: Record<string, unknown>[];
    sheets: Record<string, unknown>[];
};

const HEADER_STYLE = { bg: '#ff0000', fc: '#ffffff', bl: 1, ff: 'Arial', fs: 12 };

const WORKBOOK: Sheet[] = [
    {
        id: 'sheet-1',
        name: 'Sheet1',
        order: 0,
        row: 40,
        column: 12,
        showGridLines: 1,
        celldata: [
            { r: 0, c: 0, v: { ...HEADER_STYLE, v: 'Total', m: 'Total' } },
            { r: 0, c: 1, v: { ...HEADER_STYLE } },
            { r: 1, c: 0, v: { f: '=SUM(A1:A2)', v: 42, m: '42' } },
            { r: 1, c: 1, v: { v: 1234.5, m: '1,234.50', ct: { fa: '#,##0.00', t: 'n' } } },
            { r: 2, c: 0, v: { v: 7 } },
            { r: 2, c: 1, v: { v: 'plain', m: 'plain' } },
            { r: 2, c: 2, v: { v: 3, m: '3' } },
            { r: 2, c: 3, v: { v: true, m: 'true' } },
            { r: 2, c: 4, v: { v: 5, m: 5 } },
            { r: 3, c: 0, v: null },
            {
                r: 3,
                c: 1,
                v: {
                    v: 'Rich text',
                    m: 'Rich text',
                    ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'Rich', bl: 1, fc: '#123456' }, { v: ' text' }] },
                },
            },
            { r: 4, c: 0, v: { v: 'Merged', m: 'Merged', mc: { r: 4, c: 0, rs: 2, cs: 2 } } },
            { r: 4, c: 1, v: { mc: { r: 4, c: 0 } } },
            { r: 5, c: 0, v: { v: 'link', m: 'link', hl: { r: 5, c: 0, id: 'link-1' } } },
            { r: 5, c: 1, v: { v: 'noted', m: 'noted', commentCardIds: ['card-a', 'card-b'] } },
            { r: 6, c: 0, v: { v: 'spilled', m: 'spilled', spl: [[{ v: 1 }]] } as Cell },
            { r: 6, c: 1, v: { v: 'future', m: 'future', futureCellKey: 'kept' } as Cell },
            { r: 7, c: 0, v: { ...HEADER_STYLE, f: '=A1&"!"', v: 'Total!', m: 'Total!' } },
        ],
        config: {
            merge: { '4_0': { r: 4, c: 0, rs: 2, cs: 2 } },
            rowlen: { '0': 30 },
            borderInfo: {
                '0_0': { l: { style: 1, color: '#000000' }, t: { style: 1, color: '#000000' } },
                '1_0': { l: { style: 1, color: '#000000' }, t: { style: 1, color: '#000000' } },
                '2_0': { b: { style: 7, color: '#ff00ff' } },
                '3_3': { s: { style: 1, color: '#ff00ff' } },
            },
        },
        frozen: { type: 'rangeBoth', range: { row_focus: 0, column_focus: 0 } },
        filterRange: { row: [0, 7], column: [0, 4] },
        dataVerification: { '2_2': { type: 'dropdown', type2: '', value1: 'a,b,c', value2: '' } },
        hyperlink: { '5_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
        conditionalFormatRules: [
            {
                type: 'default',
                cellrange: [{ row: [0, 2], column: [0, 2] }],
                format: { textColor: '#ff0000', cellColor: null },
                conditionName: 'greaterThan',
                conditionValue: [10],
            },
        ],
    },
    {
        id: 'sheet-2',
        name: 'Sheet2',
        order: 1,
        celldata: [{ r: 0, c: 0, v: { ...HEADER_STYLE, v: 'b', m: 'b' } }],
        futureSheetKey: 'kept',
    } as Sheet,
];

const BULK_STYLE = { bg: '#a1b2c3', fc: '#ffffff', bl: 1, it: 1, ff: 'Arial', fs: 11, ht: 0, vt: 0, un: 0, cl: 0 };

function bulkSheet(order: number): Sheet {
    const celldata: CellWithRowAndCol[] = [];
    for (let r = 0; r < 1000; r++) {
        celldata.push({ r, c: 0, v: { ...BULK_STYLE, v: r, m: String(r) } });
    }
    return { id: `bulk-${order}`, name: `Bulk${order}`, order, celldata };
}

const BULK: Sheet[] = [bulkSheet(0), bulkSheet(1), bulkSheet(2)];

describe('encodeSheetsSnapshot / decodeSheetsSnapshot', () => {
    test('v2 envelope leads with the format tag', () => {
        const encoded = encodeSheetsSnapshot(WORKBOOK, { computed: true });
        expect(encoded.startsWith('{"f":"eigensheets/2"')).toBe(true);
        expect((JSON.parse(encoded) as Envelope).computed).toBe(true);
    });

    test('round-trips every cell, border and sheet branch (only calcChain is added)', () => {
        const decoded = decodeSheetsSnapshot(
            encodeSheetsSnapshot(WORKBOOK, { computed: true }),
        ) as SheetWithCalcChain[];
        expect(decoded.map(({ calcChain: _chain, ...sheet }) => sheet)).toEqual(WORKBOOK);
        expect(decoded[0].calcChain).toEqual([
            { r: 1, c: 0, id: 'sheet-1' },
            { r: 7, c: 0, id: 'sheet-1' },
        ]);
        expect(decoded[1].calcChain).toEqual([]);
    });

    test('repeated style and border payloads are interned once', () => {
        const envelope = JSON.parse(encodeSheetsSnapshot(WORKBOOK, { computed: true })) as Envelope;
        // HEADER_STYLE is shared by four cells across both sheets, the thin black
        // border by two borderInfo cells.
        expect(envelope.styles.filter((style) => style['bg'] === '#ff0000')).toHaveLength(1);
        expect(envelope.borders).toHaveLength(3);
    });

    test('computed: false → no calcChain on any sheet', () => {
        const decoded = decodeSheetsSnapshot(
            encodeSheetsSnapshot(WORKBOOK, { computed: false }),
        ) as SheetWithCalcChain[];
        for (const sheet of decoded) expect(sheet.calcChain).toBeUndefined();
    });

    test('one shared style across 3000 cells is serialized once', () => {
        const encoded = encodeSheetsSnapshot(BULK, { computed: true });
        expect(encoded.split('#a1b2c3')).toHaveLength(2);
        const decoded = decodeSheetsSnapshot(encoded) as SheetWithCalcChain[];
        expect(decoded.map(({ calcChain: _chain, ...sheet }) => sheet)).toEqual(BULK);
    });

    test('dictionary encoding shrinks a style-heavy workbook at least 5x', () => {
        const encoded = encodeSheetsSnapshot(BULK, { computed: true });
        expect(encoded.length * 5).toBeLessThan(JSON.stringify(BULK).length);
    });

    test('empty workbook, empty sheet and sheet without celldata', () => {
        expect(decodeSheetsSnapshot(encodeSheetsSnapshot([], { computed: true }))).toEqual([]);
        const sheets: Sheet[] = [
            { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [] },
            { id: 'sheet-2', name: 'Sheet2', order: 1 },
        ];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true })) as SheetWithCalcChain[];
        expect(decoded[0]).toEqual({ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], calcChain: [] });
        expect(decoded[1]).toEqual({ id: 'sheet-2', name: 'Sheet2', order: 1 });
    });

    test('an empty config survives the round-trip so config ops still resolve', () => {
        // Every fresh sheet carries `config: {}`; dropping it makes a later
        // `config.merge.0_0` op unreplayable.
        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        expect(decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: false }))).toEqual(sheets);
    });

    test('decoded cells sharing a style do not share nested object identity', () => {
        const ct = { fa: 'General', t: 'n', s: [{ v: 'run', fc: '#ff0000' }] };
        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [
                    { r: 0, c: 0, v: { v: 1, m: '1', ct } },
                    { r: 0, c: 1, v: { v: 2, m: '2', ct } },
                ],
            } as Sheet,
        ];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
        const [a, b] = decoded[0].celldata!.map((cell) => cell.v as { ct: typeof ct });
        expect(a.ct).toEqual(ct);
        expect(a.ct).not.toBe(b.ct);
        expect(a.ct.s).not.toBe(b.ct.s);
        a.ct.fa = 'mutated';
        expect(b.ct.fa).toBe('General');
    });

    test('decoded borders sharing a dict entry do not share side-object identity', () => {
        const side = { l: { style: 1, color: '#000000' }, t: { style: 1, color: '#000000' } };
        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [],
                config: { borderInfo: { '0_0': side, '1_0': side } },
            } as Sheet,
        ];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
        const borderInfo = decoded[0].config!.borderInfo!;
        const [a, b] = [borderInfo['0_0'], borderInfo['1_0']];
        expect(a.l).toEqual({ style: 1, color: '#000000' });
        expect(a.l).not.toBe(b.l);
        a.l!.style = 13;
        expect(b.l!.style).toBe(1);
    });

    test('an empty borderInfo map round-trips as an empty map', () => {
        // N1 materializes the config collections on every base; the codec must not
        // turn a present-but-empty map into an absent key (or the reverse).
        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: { borderInfo: {} } }];
        const encoded = encodeSheetsSnapshot(sheets, { computed: false });
        expect(decodeSheetsSnapshot(encoded)).toEqual(sheets);
    });

    test('an empty cell object survives as {} rather than collapsing to null', () => {
        // An op patch recorded against the {} cell (['data', r, c, 'v']) must still
        // resolve through it after a round-trip; a null parent rolls back the batch.
        const sheets: Sheet[] = [
            { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [{ r: 0, c: 0, v: {} }] } as Sheet,
        ];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
        expect(decoded[0].celldata![0].v).toEqual({});
        expect(decoded[0].celldata![0].v).not.toBeNull();
    });

    test('unknown envelope format throws instead of decoding garbage', () => {
        expect(() => decodeSheetsSnapshot('{"f":"eigensheets/99","sheets":[]}')).toThrow(
            'Unknown sheets snapshot format',
        );
        expect(() => decodeSheetsSnapshot('{"foo":1}')).toThrow('Unknown sheets snapshot format');
    });

    test('a v1 snapshot (plain Sheet[] JSON) throws instead of decoding', () => {
        // No legacy reading anywhere: the editor opens such a doc read-only on defaults
        // (use-sheet.ts loadedRef) and never persists over it.
        const legacy = JSON.stringify([{ id: 'sheet-1', name: 'Sheet1', order: 0, config: {}, celldata: [] }]);
        expect(() => decodeSheetsSnapshot(legacy)).toThrow('Unknown sheets snapshot format');
        expect(() => decodeSheetsSnapshot(`\n  ${legacy}`)).toThrow('Unknown sheets snapshot format');
    });

    test('encoding is byte-stable for a fixed workbook', async () => {
        // Byte stability is what the import golden in document-transform.test.ts pins
        // end-to-end; this local pin makes a codec-side drift fail fast. Moving it is
        // an intentional format change.
        const encoded = encodeSheetsSnapshot(WORKBOOK, { computed: true });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        expect(hex).toBe('5c106a392d5cb1103e0a83b5a6117489da13dea5908d15345f91709767ae3728');
    });

    test('data and selections never reach the snapshot', () => {
        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [{ r: 0, c: 0, v: { v: 1, m: '1' } }],
                data: [[{ v: 1, m: '1' }]],
                selections: [{ row: [0, 0], column: [0, 0] }],
            } as Sheet,
        ];
        const encoded = encodeSheetsSnapshot(sheets, { computed: true });
        expect(encoded).not.toContain('"data":');
        expect(encoded).not.toContain('"selections":');
        const decoded = decodeSheetsSnapshot(encoded);
        expect(decoded[0].data).toBeUndefined();
    });

    test('a dense `data` matrix is folded into cells and outranks a stale celldata', () => {
        // The editor flushes `data` with `celldata` left at its pre-edit state.
        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [{ r: 0, c: 0, v: { v: 'stale', m: 'stale' } }],
                data: [
                    [{ v: 'edited', m: 'edited' }, null],
                    [null, { ...HEADER_STYLE, f: '=A1', v: 'edited', m: 'edited' }],
                ],
            } as Sheet,
        ];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
        expect(decoded[0].celldata).toEqual([
            { r: 0, c: 0, v: { v: 'edited', m: 'edited' } },
            { r: 1, c: 1, v: { ...HEADER_STYLE, f: '=A1', v: 'edited', m: 'edited' } },
        ]);
    });
});
