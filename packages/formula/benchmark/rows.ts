// Writes the data file of Excel's recorded answers that the correctness run reads: every row the oracle's rows
// mode runs, each with the sheets it needs, the formula as typed in Excel and Excel's answer. The recorded files
// are local and not in git, so this runs once, by hand, and the data file is committed. An array Excel answered
// without its elements leaves nothing to compare, so such a row is counted and left out.

import * as fs from 'node:fs';
import path from 'node:path';
import type { Cells, Expected, Probe } from './recorded';
import { loadOracle } from './recorded';

export const DATA_FILE = path.join(import.meta.dir, 'excel-rows.jsonl');

export type RowSheet = { readonly name: string; readonly cells: Cells };
export type DataHeader = {
    readonly source: string;
    readonly rows: number;
    readonly unjudged: number;
    readonly fixtures: readonly (readonly RowSheet[])[];
};
// One row: its file's tag, its fixture's place in the header, the formula as typed, the answer, and for an array
// Excel answered as #CALC!, the ISREF and SUM recorded beside it.
export type DataRow = readonly [
    string,
    number,
    string,
    Expected | Probe,
    { readonly isref?: string; readonly sum?: string },
];

if (import.meta.main) {
    const dir = process.argv[2];
    if (dir === undefined) throw new Error('usage: bun rows.ts <oracle dir>');
    const oracle = await loadOracle();
    const fixtures: RowSheet[][] = [];
    const places = new Map<string, number>();
    const rows: DataRow[] = [];
    let unjudged = 0;
    for (const row of oracle.rows(dir)) {
        const { fixture, named, expected } = row;
        if ('rows' in expected && expected.elements === null && row.excel !== '#CALC!') {
            unjudged += 1;
            continue;
        }
        // The oracle's sheets for a row: the host, the fixture's other sheets, each named sheet as a copy of the host.
        const hostName = fixture.hostName ?? named[0] ?? 'Sheet1';
        const others: Record<string, Cells> = { ...fixture.others };
        for (const name of named) if (name !== hostName && !(name in others)) others[name] = fixture.host;
        if (Object.keys(others).length === 0) others.Sheet2 = fixture.host;
        const sheets = [
            { name: hostName, cells: fixture.host },
            ...Object.entries(others).map(([name, cells]) => ({ name, cells })),
        ];
        const key = JSON.stringify(sheets);
        let place = places.get(key);
        if (place === undefined) {
            place = fixtures.push(sheets) - 1;
            places.set(key, place);
        }
        rows.push([row.file, place, row.formula, expected, row.extra]);
    }
    const header: DataHeader = {
        source: 'Recorded by hand in Excel for the web, November 2026: the family and batch files of the oracle.',
        rows: rows.length,
        unjudged,
        fixtures,
    };
    fs.writeFileSync(DATA_FILE, `${[header, ...rows].map((line) => JSON.stringify(line)).join('\n')}\n`);
    console.log(`${rows.length} rows, ${fixtures.length} fixtures, ${unjudged} arrays without elements left out`);
}

export function readData(): { readonly header: DataHeader; readonly rows: readonly DataRow[] } {
    const [first, ...rest] = fs.readFileSync(DATA_FILE, 'utf8').trim().split('\n');
    return { header: JSON.parse(first), rows: rest.map((line) => JSON.parse(line)) };
}
