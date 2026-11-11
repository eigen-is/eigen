import { expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, encodeSheetsSnapshot, sheetsOpLog, sheetsStateMap } from '@workspace/lib/sheets';
import * as Y from 'yjs';
import { compactSheetsSnapshot, readSheetsFromDoc } from '../../lib/document/sheets';
import { TRANSFORM_LIMITS } from '../../lib/document/transform/runner';
import { readXlsx } from '../../lib/import/sheets/from-xlsx';
import { openZip } from '../../lib/ooxml/zip';
import { exportXlsx } from '../fixtures/xlsx';

const one: Sheet = {
    name: 'One',
    id: 's1',
    order: 0,
    row: 3,
    column: 3,
    celldata: [
        { r: 0, c: 0, v: { v: 10, m: '10' } },
        { r: 0, c: 1, v: { f: '=A2*2', v: 40, m: '40' } },
        { r: 0, c: 2, v: { f: '=SUM(A1:A3)', v: 60, m: '60' } },
        { r: 1, c: 0, v: { v: 20, m: '20' } },
        { r: 2, c: 0, v: { v: 30, m: '30' } },
    ],
};
const two: Sheet = {
    name: 'Two',
    id: 's2',
    order: 1,
    row: 1,
    column: 2,
    celldata: [
        { r: 0, c: 0, v: { f: '=One!C1*2', v: 120, m: '120' } },
        { r: 0, c: 1, v: { f: '=A1+1', v: 121, m: '121' } },
    ],
};
// The time a compaction's job is killed at, as the runner gives it to the child.
const jobDeadline = () => Date.now() + TRANSFORM_LIMITS.compact.deadlineMs;
const rowDelete: Op = { op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 1, end: 1 } };
const tabDelete: Op = { op: 'deleteSheet', id: 's1', path: [], value: { id: 's1' } };

function doc(batches: Op[][]) {
    const d = new Y.Doc();
    sheetsStateMap(d).set('snapshot', encodeSheetsSnapshot([one, two], { computed: true }));
    sheetsOpLog(d).push(batches);
    return d;
}

test('the export and the preview read a row delete recomputed, on a sheet the batch names and one it does not', () => {
    for (const { sheets } of [
        readSheetsFromDoc(doc([[rowDelete]])),
        readSheetsFromDoc(doc([[rowDelete]]), { recalc: false }),
    ]) {
        expect(sheets[0].data?.[0][1]).toMatchObject({ f: '=#REF!*2', v: '#REF!' });
        expect(sheets[0].data?.[0][2]).toMatchObject({ f: '=SUM(A1:A2)', v: 40 });
        expect(sheets[1].data?.[0][0]).toMatchObject({ v: 80 });
        expect(sheets[1].data?.[0][1]).toMatchObject({ v: 81 });
    }
});

test('a compaction stores what the replay computed', () => {
    const snapshot = encodeSheetsSnapshot([one, two], { computed: true });
    const { snapshot: compacted, dropped } = compactSheetsSnapshot(
        snapshot,
        JSON.stringify([[rowDelete]]),
        jobDeadline(),
    );
    expect(dropped).toBe(0);
    const [, second] = decodeSheetsSnapshot(compacted);
    expect(second.celldata?.find((e) => e.c === 0)?.v).toMatchObject({ v: 80 });
});

test('a tab delete`s =#REF!*2 survives the codec, and exports as an xlsx formula with an error value', () => {
    const { sheets } = readSheetsFromDoc(doc([[tabDelete]]));
    expect(sheets.map((s) => s.name)).toEqual(['Two']);
    expect(sheets[0].data?.[0][0]).toMatchObject({ f: '=#REF!*2', v: '#REF!', ct: { t: 'e' } });
    expect(sheets[0].data?.[0][1]).toMatchObject({ v: '#REF!' });

    const [decoded] = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
    expect(decoded.celldata?.find((e) => e.c === 0)?.v).toMatchObject({ f: '=#REF!*2', v: '#REF!' });

    const bytes = exportXlsx(sheets);
    const xml = new TextDecoder().decode(openZip(bytes).read('xl/worksheets/sheet1.xml'));
    expect(xml).toContain('<c r="A1" t="e"><f>#REF!*2</f><v>#REF!</v></c>');

    const [back] = readXlsx(bytes, { maxMediaBytes: 1_000_000 }).sheets;
    expect(back.celldata?.find((e) => e.c === 0)?.v).toMatchObject({ f: '=#REF!*2', v: '#REF!' });
});
