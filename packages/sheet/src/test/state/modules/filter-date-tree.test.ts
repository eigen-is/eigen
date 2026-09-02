// Filter-by-values date tree. getFilterColumnValues groups date cells into a
// year > month > day tree whose `key`/`value` are the lookup and check-state
// identity (dotted ISO parts) and whose `text` is display only. The two are
// pinned together here because the labels used to be built by concatenating
// the value with a word — "2024Year", "08Month" — a luckysheet leftover that
// only reads correctly in Chinese. Excel's convention is 2024 > August > 5.

import { describe, expect, test } from 'bun:test';
import { genarate } from '../../../engine/format';
import type { Context } from '../../../state/context';
import { type FilterDate, getFilterColumnValues } from '../../../state/modules/filter';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

function date(iso: string): Cell {
    const [m, ct, v] = genarate(iso);
    expect(ct.t).toBe('d');
    return { v, m: `${m}`, ct };
}

function text(v: string): Cell {
    return { v, m: v, ct: { fa: 'General', t: 's' } };
}

// Header on row 0, four dated rows below it in one column.
function dateContext(): Context {
    return contextFactory({
        filter: {},
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                data: [
                    [text('When')],
                    [date('2024-08-05')],
                    [date('2024-08-15')],
                    [date('2024-11-09')],
                    [date('2023-03-02')],
                ],
                order: 0,
                row: 5,
                column: 1,
            },
        ],
    }) as Context;
}

type LabelTree = { text: string; children: LabelTree[] };

function labels(node: FilterDate): LabelTree {
    return { text: node.text, children: node.children.map(labels) };
}

function leaf(text: string): LabelTree {
    return { text, children: [] };
}

describe('getFilterColumnValues date tree', () => {
    test('labels read as year > full month name > bare day', () => {
        const { dates } = getFilterColumnValues(dateContext(), 0, 0, 4, 0);
        expect(dates.map(labels)).toEqual([
            {
                text: '2024',
                children: [
                    { text: 'August', children: [leaf('5'), leaf('15')] },
                    { text: 'November', children: [leaf('9')] },
                ],
            },
            { text: '2023', children: [{ text: 'March', children: [leaf('2')] }] },
        ]);
    });

    test('keys and values keep the padded ISO parts the check state is tracked by', () => {
        const { dates } = getFilterColumnValues(dateContext(), 0, 0, 4, 0);
        const [year] = dates;
        expect([year.key, year.value]).toEqual(['2024', '2024']);
        const [august] = year.children;
        expect([august.key, august.value]).toEqual(['2024-08', '08']);
        const [fifth] = august.children;
        expect([fifth.key, fifth.value]).toEqual(['2024-08-05', '05']);
    });
});
