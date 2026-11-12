import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FUNCTIONS } from '../../functions/library';

const STATUSES = ['as Excel', 'differs', 'partial'];

// Every row of a table in FUNCTIONS.md that names a function: | `NAME` | status | note |.
const ROWS = readFileSync(new URL('../../../FUNCTIONS.md', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
        const [, name, status] = line.split('|').map((cell) => cell.trim());
        return { name: name.slice(1, -1), status };
    });
const LISTED = ROWS.map((row) => row.name);
const BUILT = [...FUNCTIONS.keys()];

describe('FUNCTIONS.md', () => {
    test('lists every function the engine computes', () => {
        expect(BUILT.filter((name) => !LISTED.includes(name))).toEqual([]);
    });

    test('lists no function the engine does not compute', () => {
        expect(LISTED.filter((name) => !FUNCTIONS.has(name))).toEqual([]);
    });

    test('lists each function once', () => {
        expect(LISTED.filter((name, at) => LISTED.indexOf(name) !== at)).toEqual([]);
    });

    test('gives each function one of the three statuses', () => {
        expect(ROWS.filter((row) => !STATUSES.includes(row.status))).toEqual([]);
    });
});
