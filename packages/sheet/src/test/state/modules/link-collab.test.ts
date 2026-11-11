// A link on the tabs and in a joiner's replay: two people's edits of different links, and row ops sent at the same time,
// leave every reader with the same links on the same cells.

import { describe, expect, test } from 'bun:test';
import { withMaterializedData } from '../../../engine';
import type { Context } from '../../../state/context';
import { removeHyperlink, saveHyperlink } from '../../../state/modules/hyperlink';
import { insertRowCol } from '../../../state/modules/rowcol';
import type { Sheet } from '../../../state/types';
import type { PatchOptions } from '../../../state/utils/patch';
import { author, join, receive } from '../factories/collab';
import { contextFactory } from '../factories/context';

const INSERT = { type: 'row', index: 1, count: 1, direction: 'lefttop', id: 'id_1' } as const;
const INSERTED = { insertRowColOp: INSERT };

function grid(): Context {
    const cell = (v: string) => ({ v, m: v });
    return contextFactory({
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                data: Array.from({ length: 8 }, (_, r) => [cell(`a${r}`), cell(`b${r}`)]),
                config: {},
            },
        ],
    }) as Context;
}

// Every link of a sheet by its cell.
function links(sheet: Sheet): Record<string, string | undefined> {
    const found: Record<string, string> = {};
    for (const [r, row] of (sheet.data ?? []).entries()) {
        for (const [c, cell] of row.entries()) if (cell?.link) found[`${r}_${c}`] = cell.link.address;
    }
    return found;
}

// Two edits made on one base and sent at once, with the log holding `first` first. Each tab has applied its own before
// it takes the other's. Returns the links of the first tab, the second tab and a joiner.
function raced(
    base: Context,
    [first, firstOptions]: Edit,
    [second, secondOptions]: Edit,
): Record<string, string | undefined>[] {
    const a = author(base, first, firstOptions);
    const b = author(base, second, secondOptions);
    const onFirst = receive(a.next, b.ops);
    const onSecond = receive(receive(base, a.ops), b.ops);
    const joined = join(base, [a.ops, b.ops]).map(withMaterializedData);
    return [onFirst.sheets[0], onSecond.sheets[0], joined[0]].map(links);
}

type Edit = [(ctx: Context) => void, PatchOptions?];

const save = (r: number, address: string): Edit => [(ctx) => saveHyperlink(ctx, r, 0, `a${r}`, 'webpage', address)];
const remove = (r: number): Edit => [(ctx) => removeHyperlink(ctx, r, 0)];
const insert: Edit = [(ctx) => insertRowCol(ctx, INSERT), INSERTED];

function linked(...rows: number[]): Context {
    let ctx = grid();
    for (const r of rows) ctx = author(ctx, save(r, `https://${r}.example`)[0]).next;
    return ctx;
}

function expectEveryReader(readers: Record<string, string | undefined>[], expected: Record<string, string>) {
    for (const reader of readers) expect(reader).toEqual(expected);
}

describe("a peer's edit of another cell's link", () => {
    test('two first links on a sheet both land', () => {
        const readers = raced(grid(), save(2, 'https://a.example'), save(5, 'https://b.example'));
        expectEveryReader(readers, { '2_0': 'https://a.example', '5_0': 'https://b.example' });
    });

    test('a removal keeps a link a peer added at the same time', () => {
        const readers = raced(linked(5), save(2, 'https://a.example'), remove(5));
        expectEveryReader(readers, { '2_0': 'https://a.example' });
    });

    test('two removals take only their own links', () => {
        const readers = raced(linked(2, 5, 6), remove(2), remove(5));
        expectEveryReader(readers, { '6_0': 'https://6.example' });
    });
});

describe('row ops sent at the same time', () => {
    test('two inserts move a link two rows', () => {
        const readers = raced(linked(5), insert, insert);
        expectEveryReader(readers, { '7_0': 'https://5.example' });
    });

    test('an insert keeps a link a peer saved first, on its cell', () => {
        const readers = raced(grid(), save(5, 'https://a.example'), insert);
        expectEveryReader(readers, { '6_0': 'https://a.example' });
    });

    test("a peer's removal sent after an insert leaves the other link on its cell", () => {
        const readers = raced(linked(2, 5), insert, remove(2));
        for (const reader of readers) expect(reader).toEqual(readers[0]);
        expect(readers[0]['6_0']).toBe('https://5.example');
        expect(readers[0]['5_0']).toBeUndefined();
    });

    test("an insert sent after a peer's removal leaves the other link on its cell", () => {
        const readers = raced(linked(2, 5), remove(2), insert);
        expectEveryReader(readers, { '6_0': 'https://5.example' });
    });
});
