import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { Op } from '../../sheets/types';
import { readSheetsLog, sheetsLogStartsWith, sheetsOpLog } from '../../sheets/yjs-state';

const typed = (v: string): Op[] => [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: { v, m: v } }];

function docWith(...entries: unknown[]) {
    const doc = new Y.Doc();
    sheetsOpLog(doc).push(entries);
    return doc;
}

// A peer can store anything as an entry. One that is no batch of well-formed ops reads as an empty batch on every
// reader, so the batches after it keep their places in the log.
test.each([
    ['a number', 42],
    ['text', 'abc'],
    ['a null op', [null]],
    ['a BigInt', [1n]],
    ['an op of no known kind', [{ op: 'move', id: 's1', path: ['data'] }]],
    ['an op with no path', [{ op: 'replace', id: 's1' }]],
    ['a sheet id that is no text', [{ op: 'replace', id: 7, path: ['color'], value: 'red' }]],
    ['a path key that is no text or number', [{ op: 'add', id: 's1', path: ['config', ['__proto__']], value: {} }]],
    ['a BigInt inside a value', [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: { ct: { s: [{ v: 1n }] } } }]],
    ['one bad op among good ones', [...typed('good'), null]],
])('a log entry that holds %s reads as an empty batch', (_name, forged) => {
    const doc = docWith(typed('before'), forged, typed('after'));
    expect(readSheetsLog(doc)).toEqual([typed('before'), [], typed('after')]);
    expect(readSheetsLog(doc, 2)).toEqual([typed('after')]);
});

test('a batch of well-formed ops reads as the entry itself, so the log still starts with it', () => {
    const structural: Op[] = [
        { op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index: 0, count: 1, direction: 'lefttop' } },
        { op: 'addSheet', path: [], value: { id: 's2', name: 'Two', celldata: [{ r: 0, c: 0, v: null }] } },
        { op: 'remove', id: 's1', path: ['images', 'a'] },
    ];
    const doc = docWith(typed('one'), 42, structural);
    const entries = sheetsOpLog(doc).toArray();
    expect<unknown>(readSheetsLog(doc)[0]).toBe(entries[0]);
    expect<unknown>(readSheetsLog(doc)[2]).toBe(entries[2]);
    expect(sheetsLogStartsWith(doc, entries)).toBe(true);
    expect(sheetsLogStartsWith(doc, [entries[0], entries[2]])).toBe(false);
});

test('a value nested past any call stack is walked without a throw', () => {
    let deep: unknown = 1n;
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    const entry = [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: deep }];
    expect(readSheetsLog(docWith(entry))).toEqual([[]]);
});
