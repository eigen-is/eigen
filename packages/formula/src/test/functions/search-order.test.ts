import { describe, expect, test } from 'bun:test';
import type { FormulaError, Literal, SheetSource } from '../../index';
import { Engine, errorOf, NA } from '../../index';
import { Workbook } from '../../store/workbook';
import { compareValues } from '../../values/compare';
import { engineOf, stored, valueAt } from '../recalc/support';

// Excel's search order, stated as plain functions (the MODEL) and held against every cell Excel recorded for it;
// then the engine is held against the same cells, and against the model on lists nobody recorded.

type Item = number | string | boolean | null | FormulaError;
type Key = number | string | boolean;

// How an item sorts against the key, or against another item, when both are of one kind, else NaN.
function against(item: Item, key: Item): number {
    if (typeof item === 'object' || typeof key === 'object') return Number.NaN;
    return typeof item !== typeof key ? Number.NaN : compareValues(item, key);
}

// The blanks at the end of a list take no part.
function usedOf(list: readonly Item[]): number {
    let used = list.length;
    while (used > 0 && list[used - 1] === null) used -= 1;
    return used;
}

// The item a halving probes: the middle one, or when that is of another kind than the key the next item of the
// key's kind after it, else the one before it; -1 when the window holds none.
function probed(list: readonly Item[], key: Key, low: number, high: number): number {
    const middle = (low + high) >> 1;
    let at = middle;
    while (at < high && Number.isNaN(against(list[at], key))) at += 1;
    if (Number.isNaN(against(list[at], key))) at = middle;
    while (at > low && Number.isNaN(against(list[at], key))) at -= 1;
    return Number.isNaN(against(list[at], key)) ? -1 : at;
}

// MATCH type 1, LOOKUP and an approximate VLOOKUP or HLOOKUP, by the owner's pick: the list is taken to be sorted
// upward and halved. An item at most the key sends the search to the right of it and is the answer when no later
// probe is, so of equal items the last is found; a larger one sends the search to its left.
function upward(list: readonly Item[], key: Key): number {
    let low = 0;
    let high = usedOf(list) - 1;
    let before = -1;
    while (low <= high) {
        const at = probed(list, key, low, high);
        if (at < 0) break;
        if (against(list[at], key) <= 0) {
            before = at;
            low = at + 1;
        } else high = at - 1;
    }
    return before;
}

// Excel's own steps there, which ours leaves: the same halving, but the first probe that equals the key ends the
// search at the last of the equal items that follow it, read one by one. On a sorted list that is what `upward`
// finds; where equal items come back after a larger one it is not.
function walked(list: readonly Item[], key: Key): number {
    const used = usedOf(list);
    let low = 0;
    let high = used - 1;
    let before = -1;
    while (low <= high) {
        let at = probed(list, key, low, high);
        if (at < 0) break;
        const order = against(list[at], key);
        if (order === 0) {
            while (at + 1 < used && against(list[at + 1], key) === 0) at += 1;
            return at;
        }
        if (order < 0) {
            before = at;
            low = at + 1;
        } else high = at - 1;
    }
    return before;
}

// MATCH type -1, by the owner's pick: the list is taken to be sorted downward and halved. A probe that equals the
// key sends the search to its left, so the first of equal items is found; a larger one sends it right and is the
// answer when no item equals.
function downward(list: readonly Item[], key: Key): number {
    let low = 0;
    let high = usedOf(list) - 1;
    let hit = -1;
    let above = -1;
    while (low <= high) {
        const at = probed(list, key, low, high);
        if (at < 0) break;
        const order = against(list[at], key);
        if (order === 0) hit = at;
        if (order > 0) {
            above = at;
            low = at + 1;
        } else high = at - 1;
    }
    return hit >= 0 ? hit : above;
}

// Excel's own steps for MATCH type -1, which ours leaves too: no halving. The items of the key's kind are read from the
// first one on; the key itself ends the search, and so does the first smaller item, which leaves the last larger
// one before it. On a list sorted downward that is what `downward` finds.
function scanned(list: readonly Item[], key: Key): number {
    let above = -1;
    for (let at = 0; at < list.length; at += 1) {
        const order = against(list[at], key);
        if (order === 0) return at;
        if (order < 0) break;
        if (order > 0) above = at;
    }
    return above;
}

// XMATCH search modes 2 and -2: a textbook bisection in the one order of all values (number, text, boolean), with
// an error and a blank past them all. Of equal items the first when the list goes up, the last when it goes down.
// `match` 0 wants the key itself, -1 takes the next smaller item instead, 1 the next larger.
function bisection(list: readonly Item[], key: Key, descending: boolean, match: number): number {
    let low = 0;
    let high = usedOf(list) - 1;
    let hit = -1;
    let before = -1;
    let after = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const item = list[middle];
        const order = typeof item === 'object' ? 1 : compareValues(item, key);
        const right = order === 0 ? descending : order < 0 !== descending;
        if (order === 0) hit = middle;
        else if (right) before = middle;
        else after = middle;
        if (right) low = middle + 1;
        else high = middle - 1;
    }
    if (hit >= 0 || match === 0) return hit;
    return match < 0 === descending ? after : before;
}

// The searches that read every item, which no recorded row asks to change: the key itself, a text key as a pattern
// with `wild`, from the first item on or from the last one back.
function linear(list: readonly Item[], key: Key, wild: boolean, reverse: boolean): number {
    const pattern =
        wild && typeof key === 'string' && /[*?~]/.test(key)
            ? new RegExp(
                  `^${key.replace(/~.|./gs, (part) =>
                      part === '*' ? '.*' : part === '?' ? '.' : part.slice(-1).replace(/[^\w\s]/, '\\$&'),
                  )}$`,
                  'is',
              )
            : null;
    for (let step = 0; step < list.length; step += 1) {
        const at = reverse ? list.length - 1 - step : step;
        const item = list[at];
        if (pattern === null ? against(item, key) === 0 : typeof item === 'string' && pattern.test(item)) return at;
    }
    return -1;
}

// The key, or else the nearest smaller item, or the nearest larger one: of equal candidates the first one met.
function nearest(list: readonly Item[], key: Key, larger: boolean, reverse: boolean): number {
    const same = linear(list, key, false, reverse);
    if (same >= 0) return same;
    let best = -1;
    for (let step = 0; step < list.length; step += 1) {
        const at = reverse ? list.length - 1 - step : step;
        const order = against(list[at], key);
        if (Number.isNaN(order) || order > 0 !== larger) continue;
        const gain = best < 0 ? 0 : against(list[at], list[best]);
        if (best < 0 || (larger ? gain < 0 : gain > 0)) best = at;
    }
    return best;
}

// The fixture of Excel's sheets b9_r8 and b9_r9, as cells and as the lists the model reads.
const ERRORS = { div0: errorOf('#DIV/0!'), na: errorOf('#N/A') };
const RANGES: Readonly<Record<string, readonly Item[]>> = {
    'A1:A5': [1.5, -2.5, 0, 10, 1e300],
    'B1:B7': [null, '3', true, ERRORS.div0, 'abc', '', ERRORS.na],
    'C1:C3': [2, 4, 6],
    'D1:D4': ['k1', 'k2', 'k3', 'k4'],
    'E1:E4': [10, 20, 30, 40],
    'B2:B3': ['3', true],
    'A1:C1': [1.5, null, 2],
};

// The fixture of Excel's sheet b13_2e: a blank inside a sorted list.
const BLANKED: Readonly<Record<string, readonly Item[]>> = { 'G1:G5': [1, 2, null, 3, 4] };

// The fixture of Excel's sheet b14_a: equal items that come back after a larger one.
const RUNS: Readonly<Record<string, readonly Item[]>> = {
    'A1:G1': [1, 2, 2, 3, 2, 2, 2],
    'A2:H2': [1, 2, 2, 3, 2, 2, 2, 4],
    'A3:G3': [2, 2, 3, 2, 2, 2, 2],
    'A4:I4': [1, 2, 3, 2, 2, 2, 2, 2, 2],
    'A5:O5': [1, 1, 2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5],
    'A6:O6': [2, 2, 2, 2, 2, 2, 2, 3, 2, 2, 2, 2, 2, 2, 2],
    'A7:P7': [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 2, 4],
};

function cellOf(item: Exclude<Item, null>): Literal {
    if (item === '') return '=""';
    return typeof item === 'object' ? (item === ERRORS.na ? '=NA()' : '=1/0') : item;
}

function sheetOf(ranges: Readonly<Record<string, readonly Item[]>>): Record<string, Literal> {
    const cells: Record<string, Literal> = {};
    for (const [range, items] of Object.entries(ranges)) {
        const [first = '', last = ''] = range.split(':');
        const top = Number(first.slice(1));
        items.forEach((item, at) => {
            const column = String.fromCharCode(first.charCodeAt(0) + (first[0] === last[0] ? 0 : at));
            if (item !== null) cells[`${column}${first[0] === last[0] ? top + at : top}`] = cellOf(item);
        });
    }
    return cells;
}

function itemOf(text: string): Item | undefined {
    if (/^-?\d+(\.\d+)?(E[+-]?\d+)?$/.test(text)) return Number(text);
    if (text.startsWith('"')) return text.slice(1, -1);
    if (text === 'TRUE' || text === 'FALSE') return text === 'TRUE';
    return text.startsWith('#') ? errorOf(text) : undefined;
}

// What the model says a recorded formula shows: a position, the item found, or #N/A, by our steps or by Excel's.
function modelOf(formula: string, excel = false): string {
    const up = excel ? walked : upward;
    const down = excel ? scanned : downward;
    const [, name = '', inside = ''] = /^=(\w+)\((.*)\)$/.exec(formula) ?? [];
    const [first = '', second = '', ...rest] = inside.split(/,(?![^{]*\})/);
    const key = itemOf(first);
    const list =
        RANGES[second] ??
        BLANKED[second] ??
        RUNS[second] ??
        second
            .slice(1, -1)
            .split(/[,;]/)
            .map((text) => itemOf(text) ?? null);
    if (key === undefined || key === null || typeof key === 'object') throw new Error(`no model of ${formula}`);
    const [third, fourth] = rest.map((text) => (text === '' ? undefined : Number(text)));
    let at: number;
    if (name === 'LOOKUP' || name === 'VLOOKUP') {
        at = up(list, key);
        return at < 0 ? '#N/A' : shown(list[at]);
    }
    if (name === 'MATCH') {
        const type = third ?? 1;
        at = type === 0 ? linear(list, key, true, false) : type > 0 ? up(list, key) : down(list, key);
    } else {
        const match = Math.trunc(third ?? 0);
        const search = Math.floor(fourth ?? 1);
        if (search === 2 || search === -2) at = bisection(list, key, search < 0, match);
        else if (match === 0 || match === 2) at = linear(list, key, match === 2, search < 0);
        else at = nearest(list, key, match > 0, search < 0);
    }
    return at < 0 ? '#N/A' : String(at + 1);
}

function shown(value: Item): string {
    if (typeof value === 'object') return value === null ? '' : value.text;
    return typeof value === 'boolean' ? String(value).toUpperCase() : String(value);
}

// What the engine shows for each formula, on the fixture.
function engineOn(formulas: readonly string[], ranges = RANGES): string[] {
    const cells: Record<string, Literal> = sheetOf(ranges);
    formulas.forEach((formula, row) => {
        cells[`R${row + 1}`] = formula;
    });
    const engine = engineOf({ s1: cells });
    engine.recalc(Number.POSITIVE_INFINITY);
    return formulas.map((_, row) => shown(valueAt(engine, `R${row + 1}`)));
}

// The eleven forms of batch 12, part A, in the order of its columns.
const FORMS: readonly ((key: string, list: string) => string)[] = [
    (key, list) => `=MATCH(${key},${list},1)`,
    (key, list) => `=MATCH(${key},${list},-1)`,
    (key, list) => `=MATCH(${key},${list},0)`,
    (key, list) => `=XMATCH(${key},${list},0,2)`,
    (key, list) => `=XMATCH(${key},${list},0,-2)`,
    (key, list) => `=XMATCH(${key},${list},-1,2)`,
    (key, list) => `=XMATCH(${key},${list},1,2)`,
    (key, list) => `=XMATCH(${key},${list},-1,-2)`,
    (key, list) => `=XMATCH(${key},${list},1,-2)`,
    (key, list) => `=LOOKUP(${key},${list})`,
    // Excel's row has TRANSPOSE(list), which is not built yet: this is the column it makes.
    (key, list) => `=VLOOKUP(${key},${list.replaceAll(',', ';')},1,TRUE)`,
];

// Excel batch 12, part A: a key, a list, and what the eleven forms show.
const RECORDED: readonly (readonly [string, string, string])[] = [
    ['4', '{6,4,2}', '2 2 2 2 2 2 2 2 2 4 4'],
    ['8', '{1,5,2,8,3}', '4 #N/A 4 4 #N/A 4 4 1 #N/A 8 8'],
    ['2', '{1,5,2,8,3}', '3 #N/A 3 3 3 3 3 3 3 2 2'],
    ['2', '{2,2,2}', '3 1 1 1 3 1 1 3 3 2 2'],
    ['2', '{1,2,2,2,3}', '4 #N/A 2 2 4 2 2 4 4 2 2'],
    ['2', '{3,2,2,2,1}', '4 2 2 3 4 3 3 4 4 2 2'],
    ['"b"', '{1,"a",3,"b",5,"c",7}', '4 #N/A 4 4 4 4 4 4 4 b b'],
    ['5', '{1,"a",3,"b",5,"c",7}', '5 #N/A 5 #N/A #N/A 1 2 #N/A 7 5 5'],
    ['4', '{1,"a",3,"b",5,"c",7}', '3 #N/A #N/A #N/A #N/A 1 2 #N/A 7 3 3'],
    ['"bb"', '{1,"a",3,"b",5,"c",7}', '4 #N/A #N/A #N/A #N/A 5 6 1 #N/A b b'],
    ['2', '{"a",1,"b",2,"c",3,"d"}', '4 #N/A 4 4 4 4 4 4 4 2 2'],
    ['"c"', '{"a",1,"b",2,"c",3,"d"}', '5 #N/A 5 #N/A #N/A 6 7 1 #N/A c c'],
    ['2', '{"a","b",1,2,"c","d",3}', '4 #N/A 4 4 4 4 4 4 4 2 2'],
    ['"c"', '{"a","b",1,2,"c","d",3}', '5 #N/A 5 5 #N/A 5 5 1 #N/A c c'],
    ['3', '{1,2,"a","b",3,4,"c"}', '5 #N/A 5 #N/A #N/A 2 3 #N/A 7 3 3'],
    ['"b"', '{1,2,"a","b",3,4,"c"}', '4 #N/A 4 4 4 4 4 4 4 b b'],
    ['TRUE', '{TRUE,1,"a",FALSE,2,"b"}', '4 1 1 #N/A 1 6 #N/A 1 1 FALSE FALSE'],
    ['2', '{TRUE,1,"a",FALSE,2,"b"}', '5 #N/A 5 #N/A 5 #N/A 1 5 5 2 2'],
    ['"a"', '{TRUE,1,"a",FALSE,2,"b"}', '3 3 3 3 3 3 3 3 3 a a'],
    ['3', '{1,#N/A,3,#N/A,5}', '3 #N/A 3 3 3 3 3 3 3 3 3'],
    ['5', '{1,#N/A,3,#N/A,5}', '5 #N/A 5 #N/A #N/A 3 4 1 #N/A 5 5'],
    ['4', '{1,#N/A,3,#N/A,5}', '3 #N/A #N/A #N/A #N/A 3 4 1 #N/A 3 3'],
    ['3', '{5,1,4,2,3}', '#N/A 1 5 #N/A #N/A #N/A 1 4 3 #N/A #N/A'],
    ['6', '{5,1,4,2,3}', '5 #N/A #N/A #N/A #N/A 5 #N/A 1 #N/A 3 3'],
    ['0', '{5,1,4,2,3}', '#N/A 5 #N/A #N/A #N/A #N/A 1 #N/A 5 #N/A #N/A'],
    ['6', '{1,3,5,7,9,2,4,6,8}', '3 #N/A 8 #N/A #N/A 3 4 6 5 5 5'],
    ['5', '{1,3,5,7,9,2,4,6,8}', '3 #N/A 3 3 #N/A 3 3 6 5 5 5'],
    ['5', '{9,7,5,3,1}', '3 3 3 3 3 3 3 3 3 5 5'],
    ['4', '{9,7,5,3,1}', '#N/A 3 #N/A #N/A #N/A #N/A 1 4 3 #N/A #N/A'],
    ['"c"', '{"b","a","d","c"}', '2 #N/A 4 #N/A #N/A 2 3 1 #N/A a a'],
    ['"bb"', '{"b","a","d","c"}', '2 #N/A #N/A #N/A #N/A 2 3 1 #N/A a a'],
    ['3', '{1,"",3,"",5}', '3 #N/A 3 3 3 3 3 3 3 3 3'],
    ['4.5', '{1,2,3,4,5,6,7,8}', '4 #N/A #N/A #N/A #N/A 4 5 1 #N/A 4 4'],
    ['4.5', '{8,7,6,5,4,3,2,1}', '#N/A 4 #N/A #N/A #N/A #N/A 1 5 4 #N/A #N/A'],
    ['2', '{2,2,2,2,2,2,2}', '7 1 1 1 7 1 1 7 7 2 2'],
    ['2', '{1,1,2,2,3,3}', '4 #N/A 3 3 3 3 3 3 3 2 2'],
    ['2', '{3,3,2,2,1,1}', '4 3 3 3 4 3 3 4 4 2 2'],
    ['"a"', '{1,"a",2,"a",3,"a"}', '4 2 2 6 #N/A 6 6 1 #N/A a a'],
    ['2', '{"a",1,"a",2,"a",3}', '4 #N/A 4 #N/A #N/A #N/A 1 #N/A 6 2 2'],
    ['95', '{10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170}', '9 #N/A #N/A #N/A #N/A 9 10 1 #N/A 90 90'],
    ['130', '{10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170}', '13 #N/A 13 13 #N/A 13 13 1 #N/A 130 130'],
    ['95', '{10,20,30,40,50,60,70,80,"x",100,110,120,130,140,150,160,170}', '8 #N/A #N/A #N/A #N/A 8 9 #N/A 17 80 80'],
    ['130', '{10,20,30,40,50,60,70,80,"x",100,110,120,130,140,150,160,170}', '13 #N/A 13 #N/A 13 8 9 13 13 130 130'],
    ['95', '{10,20,30,40,50,60,70,80,TRUE,100,110,120,130,140,150,160,170}', '8 #N/A #N/A #N/A #N/A 8 9 #N/A 17 80 80'],
    ['130', '{10,20,30,40,50,60,70,80,TRUE,100,110,120,130,140,150,160,170}', '13 #N/A 13 #N/A 13 8 9 13 13 130 130'],
    ['95', '{10,20,30,40,50,60,70,80,5,100,110,120,130,140,150,160,170}', '9 #N/A #N/A #N/A #N/A 9 10 1 #N/A 5 5'],
    ['130', '{10,20,30,40,50,60,70,80,5,100,110,120,130,140,150,160,170}', '13 #N/A 13 13 #N/A 13 13 1 #N/A 130 130'],
];

// Excel's rows of MATCH and XMATCH with typed arguments on its sheets b9_r8 and b9_r9.
const TYPED: readonly (readonly [string, string])[] = [
    ['=MATCH("3",C1:C3,1)', '#N/A'],
    ['=MATCH("abc",C1:C3,1)', '#N/A'],
    ['=MATCH(TRUE,C1:C3,1)', '#N/A'],
    ['=MATCH(12.5,C1:C3,1)', '3'],
    ['=MATCH(2,C1:C3,12.5)', '1'],
    ['=MATCH(2,C1:C3)', '1'],
    ['=MATCH(2,C1:C3,)', '1'],
    ['=MATCH(2,A1:A5,1)', '3'],
    ['=MATCH(2,B1:B7,1)', '#N/A'],
    ['=MATCH(2,C1:C3,0)', '1'],
    ['=MATCH(4,C1:C3,0)', '2'],
    ['=MATCH(4,C1:C3,1)', '2'],
    ['=MATCH(5,C1:C3,1)', '2'],
    ['=MATCH(1,C1:C3,1)', '#N/A'],
    ['=MATCH(7,C1:C3,1)', '3'],
    ['=MATCH(7,C1:C3)', '3'],
    ['=MATCH(6,C1:C3,0)', '3'],
    ['=MATCH(2,C1:C3,-1)', '1'],
    ['=MATCH(4,C1:C3,-1)', '#N/A'],
    ['=MATCH(3,{6,4,2},-1)', '2'],
    ['=MATCH(3,{6;4;2},-1)', '2'],
    ['=MATCH(5,{6,4,2},-1)', '1'],
    ['=MATCH(1,{6,4,2},-1)', '3'],
    ['=MATCH(7,{6,4,2},-1)', '#N/A'],
    ['=MATCH(4,{6,4,2},0)', '2'],
    ['=MATCH(4,{6,4,2},1)', '2'],
    ['=MATCH(4,{6,4,2})', '2'],
    ['=MATCH(2,C1:C3,2)', '1'],
    ['=MATCH(2,C1:C3,1.9)', '1'],
    ['=MATCH(2,C1:C3,0.9)', '1'],
    ['=MATCH(2,C1:C3,-0.5)', '1'],
    ['=MATCH(2,C1:C3,-1.9)', '1'],
    ['=MATCH(2,C1:C3,0.5)', '1'],
    ['=MATCH(3,{1,5,2,8,3},1)', '3'],
    ['=MATCH(3,{1,5,2,8,3},0)', '5'],
    ['=MATCH(8,{1,5,2,8,3},1)', '4'],
    ['=MATCH(4,{5,1,3,2},1)', '4'],
    ['=MATCH(4,{5,1,3,2},0)', '#N/A'],
    ['=MATCH(2,{1,2,2,2,3},1)', '4'],
    ['=MATCH(2,{1,2,2,2,3},0)', '2'],
    ['=MATCH(2,{3,2,2,2,1},-1)', '2'],
    ['=MATCH("k2",D1:D4,0)', '2'],
    ['=MATCH("K2",D1:D4,0)', '2'],
    ['=MATCH("k*",D1:D4,0)', '1'],
    ['=MATCH("k?",D1:D4,0)', '1'],
    ['=MATCH("*3",D1:D4,0)', '3'],
    ['=MATCH("k~2",D1:D4,0)', '2'],
    ['=MATCH("k*",D1:D4,1)', '#N/A'],
    ['=MATCH("k*",D1:D4,-1)', '4'],
    ['=MATCH("k2",D1:D4,1)', '2'],
    ['=MATCH("k25",D1:D4,1)', '2'],
    ['=MATCH("k25",D1:D4,-1)', '#N/A'],
    ['=MATCH("a",D1:D4,1)', '#N/A'],
    ['=MATCH("z",D1:D4,1)', '4'],
    ['=MATCH("k",D1:D4,1)', '#N/A'],
    ['=MATCH("?",D1:D4,0)', '#N/A'],
    ['=MATCH("k?",D1:D4)', '#N/A'],
    ['=MATCH("~*",{"a*","b"},0)', '#N/A'],
    ['=MATCH("a~*",{"a*","b"},0)', '1'],
    ['=MATCH("abc",B1:B7,0)', '5'],
    ['=MATCH("abc",B1:B7,1)', '5'],
    ['=MATCH("abc",B1:B7)', '5'],
    ['=MATCH(TRUE,B1:B7,0)', '3'],
    ['=MATCH(TRUE,B1:B7,1)', '3'],
    ['=MATCH(TRUE,{1,TRUE,"a"},0)', '2'],
    ['=MATCH(TRUE,{FALSE,TRUE},1)', '2'],
    ['=MATCH(TRUE,{FALSE,TRUE,TRUE},1)', '3'],
    ['=MATCH(TRUE,{TRUE,FALSE},-1)', '1'],
    ['=MATCH(1,{TRUE,1},0)', '2'],
    ['=MATCH(1,{TRUE},0)', '#N/A'],
    ['=MATCH("",B1:B7,0)', '6'],
    ['=MATCH("",{"",1},0)', '1'],
    ['=MATCH("",{"a","b"},1)', '#N/A'],
    ['=MATCH(1,B1:B7,0)', '#N/A'],
    ['=MATCH(3,B1:B7,0)', '#N/A'],
    ['=MATCH("3",B1:B7,0)', '2'],
    ['=MATCH("3",B1:B7,1)', '2'],
    ['=MATCH(3,B2:B3)', '#N/A'],
    ['=MATCH(2,{1,#N/A,3},1)', '1'],
    ['=MATCH(3,{1,#N/A,3},1)', '3'],
    ['=MATCH(3,{1,#N/A,3},0)', '3'],
    ['=MATCH(2,{1,#N/A,3},-1)', '#N/A'],
    ['=MATCH(2,A1:C1,0)', '3'],
    ['=MATCH(2,{1,2,3},0)', '2'],
    ['=MATCH(2,{2;3},0)', '1'],
    ['=MATCH("2",C1:C3,0)', '#N/A'],
    ['=MATCH("2",{2},0)', '#N/A'],
    ['=MATCH(2,{"2",2},0)', '2'],
    ['=MATCH(2,{"2"},0)', '#N/A'],
    ['=MATCH(1E+300,A1:A5,0)', '5'],
    ['=MATCH(1E+300,A1:A5,1)', '5'],
    ['=MATCH(0,A1:A5,0)', '3'],
    ['=MATCH(-2.5,A1:A5,0)', '2'],
    ['=MATCH(1.5,A1:A5,1)', '3'],
    ['=MATCH(20,E1:E4,0)', '2'],
    ['=MATCH(25,E1:E4,1)', '2'],
    ['=MATCH(5,E1:E4,1)', '#N/A'],
    ['=MATCH(50,E1:E4,1)', '4'],
    ['=XMATCH("3",C1:C3,0,1)', '#N/A'],
    ['=XMATCH("abc",C1:C3,0,1)', '#N/A'],
    ['=XMATCH(TRUE,C1:C3,0,1)', '#N/A'],
    ['=XMATCH(12.5,C1:C3,0,1)', '#N/A'],
    ['=XMATCH(2,C1:C3)', '1'],
    ['=XMATCH(2,C1:C3,0)', '1'],
    ['=XMATCH(2,C1:C3,,1)', '1'],
    ['=XMATCH(2,C1:C3,0,)', '1'],
    ['=XMATCH(2,A1:A5,0,1)', '#N/A'],
    ['=XMATCH(2,B1:B7,0,1)', '#N/A'],
    ['=XMATCH(3,C1:C3,0)', '#N/A'],
    ['=XMATCH(3,C1:C3,-1)', '1'],
    ['=XMATCH(3,C1:C3,1)', '2'],
    ['=XMATCH(3,C1:C3,2)', '#N/A'],
    ['=XMATCH(5,C1:C3,-1)', '2'],
    ['=XMATCH(5,C1:C3,1)', '3'],
    ['=XMATCH(7,C1:C3,1)', '#N/A'],
    ['=XMATCH(7,C1:C3,-1)', '3'],
    ['=XMATCH(1,C1:C3,-1)', '#N/A'],
    ['=XMATCH(1,C1:C3,1)', '1'],
    ['=XMATCH(4,C1:C3,0,1)', '2'],
    ['=XMATCH(4,C1:C3,0,-1)', '2'],
    ['=XMATCH(4,C1:C3,0,2)', '2'],
    ['=XMATCH(4,C1:C3,0,-2)', '2'],
    ['=XMATCH(4,C1:C3,0,1.9)', '2'],
    ['=XMATCH(4,C1:C3,1.9)', '2'],
    ['=XMATCH(4,C1:C3,,2)', '2'],
    ['=XMATCH(4,C1:C3,,-1)', '2'],
    ['=XMATCH(4,C1:C3,,)', '2'],
    ['=XMATCH(4,C1:C3,0,)', '2'],
    ['=XMATCH(4,{6,4,2},0,-2)', '2'],
    ['=XMATCH(4,{6,4,2},0,2)', '2'],
    ['=XMATCH(4,{2,4,6},0,2)', '2'],
    ['=XMATCH(4,{2,4,6},0,-2)', '2'],
    ['=XMATCH(5,{2,4,6},-1,2)', '2'],
    ['=XMATCH(5,{2,4,6},1,2)', '3'],
    ['=XMATCH(5,{6,4,2},-1,-2)', '2'],
    ['=XMATCH(5,{6,4,2},1,-2)', '1'],
    ['=XMATCH(4,{4,2,6},0,2)', '#N/A'],
    ['=XMATCH(4,{4,2,6},0,-2)', '1'],
    ['=XMATCH(2,{2,2,2},0,1)', '1'],
    ['=XMATCH(2,{2,2,2},0,-1)', '3'],
    ['=XMATCH(2,{2,2,2},0,2)', '1'],
    ['=XMATCH(2,{2,2,2},0,-2)', '3'],
    ['=XMATCH("k*",D1:D4,2)', '1'],
    ['=XMATCH("k?",D1:D4,2)', '1'],
    ['=XMATCH("k*",D1:D4,2,-1)', '4'],
    ['=XMATCH("k*",D1:D4,0)', '#N/A'],
    ['=XMATCH("k*",D1:D4,1)', '1'],
    ['=XMATCH("k2",D1:D4,2,-1)', '2'],
    ['=XMATCH("K2",D1:D4)', '2'],
    ['=XMATCH("k~2",D1:D4,2)', '2'],
    ['=XMATCH("*",D1:D4,2)', '1'],
    ['=XMATCH("*",D1:D4,2,-1)', '4'],
    ['=XMATCH("k25",D1:D4,1)', '3'],
    ['=XMATCH("k25",D1:D4,-1)', '2'],
    ['=XMATCH("k25",D1:D4,1,2)', '3'],
    ['=XMATCH("k25",D1:D4,-1,-2)', '1'],
    ['=XMATCH("a",D1:D4,-1)', '#N/A'],
    ['=XMATCH("z",D1:D4,1)', '#N/A'],
    ['=XMATCH("z",D1:D4,-1)', '4'],
    ['=XMATCH("k2",D1:D4,0,2)', '2'],
    ['=XMATCH("k2",D1:D4,0,-2)', '2'],
    ['=XMATCH(4,{2,4,6})', '2'],
    ['=XMATCH(4,{2;4;6})', '2'],
    ['=XMATCH("",B1:B7)', '6'],
    ['=XMATCH("abc",B1:B7)', '5'],
    ['=XMATCH(TRUE,B1:B7)', '3'],
    ['=XMATCH(3,B1:B7)', '#N/A'],
    ['=XMATCH(2,{1,2,3},-1,1)', '2'],
    ['=XMATCH(4,{1,"a",TRUE},0)', '#N/A'],
    ['=XMATCH(TRUE,{1,"a",TRUE},0)', '3'],
    ['=XMATCH("a",{1,"a",TRUE},0)', '2'],
    ['=XMATCH("A",{1,"a",TRUE},0)', '2'],
    ['=XMATCH(1,{TRUE,1},0)', '2'],
    ['=XMATCH("2",{2,"2"},0)', '2'],
    ['=XMATCH(2,{2,"2"},0)', '1'],
];

const CELLS = RECORDED.flatMap(([key, list, answers]) =>
    answers.split(' ').map((answer, form) => [FORMS[form](key, list), answer] as const),
);

// The recorded rows of MATCH types 1 and -1, LOOKUP and an approximate VLOOKUP on lists that are not sorted as the
// search takes them to be, where ours differs from Excel by the owner's pick: Excel also reads on item by item,
// ours only halves. A formula, Excel's value, ours.
const PICKED: readonly (readonly [string, string, string])[] = [
    ['=MATCH(4,{6,4,2},1)', '2', '3'],
    ['=LOOKUP(4,{6,4,2})', '4', '2'],
    ['=VLOOKUP(4,{6;4;2},1,TRUE)', '4', '2'],
    ['=MATCH(8,{1,5,2,8,3},1)', '4', '5'],
    ['=LOOKUP(8,{1,5,2,8,3})', '8', '3'],
    ['=VLOOKUP(8,{1;5;2;8;3},1,TRUE)', '8', '3'],
    ['=MATCH(2,{1,5,2,8,3},-1)', '#N/A', '3'],
    ['=MATCH(2,{1,2,2,2,3},-1)', '#N/A', '3'],
    ['=MATCH(2,{3,2,2,2,1},1)', '4', '5'],
    ['=LOOKUP(2,{3,2,2,2,1})', '2', '1'],
    ['=VLOOKUP(2,{3;2;2;2;1},1,TRUE)', '2', '1'],
    ['=MATCH("b",{1,"a",3,"b",5,"c",7},-1)', '#N/A', '4'],
    ['=MATCH(5,{1,"a",3,"b",5,"c",7},-1)', '#N/A', '5'],
    ['=MATCH(4,{1,"a",3,"b",5,"c",7},-1)', '#N/A', '7'],
    ['=MATCH(2,{"a",1,"b",2,"c",3,"d"},-1)', '#N/A', '4'],
    ['=MATCH("c",{"a",1,"b",2,"c",3,"d"},-1)', '#N/A', '5'],
    ['=MATCH(2,{"a","b",1,2,"c","d",3},-1)', '#N/A', '4'],
    ['=MATCH("c",{"a","b",1,2,"c","d",3},-1)', '#N/A', '5'],
    ['=MATCH(3,{1,2,"a","b",3,4,"c"},-1)', '#N/A', '5'],
    ['=MATCH("b",{1,2,"a","b",3,4,"c"},-1)', '#N/A', '4'],
    ['=MATCH(2,{TRUE,1,"a",FALSE,2,"b"},-1)', '#N/A', '5'],
    ['=MATCH(3,{1,#N/A,3,#N/A,5},-1)', '#N/A', '3'],
    ['=MATCH(3,{5,1,4,2,3},-1)', '1', '3'],
    ['=MATCH(6,{1,3,5,7,9,2,4,6,8},-1)', '#N/A', '5'],
    ['=MATCH(5,{1,3,5,7,9,2,4,6,8},-1)', '#N/A', '5'],
    ['=MATCH(5,{9,7,5,3,1},1)', '3', '5'],
    ['=LOOKUP(5,{9,7,5,3,1})', '5', '1'],
    ['=VLOOKUP(5,{9;7;5;3;1},1,TRUE)', '5', '1'],
    ['=MATCH(3,{1,"",3,"",5},-1)', '#N/A', '3'],
    ['=MATCH(2,{1,1,2,2,3,3},-1)', '#N/A', '3'],
    ['=MATCH(2,{3,3,2,2,1,1},1)', '4', '6'],
    ['=LOOKUP(2,{3,3,2,2,1,1})', '2', '1'],
    ['=VLOOKUP(2,{3;3;2;2;1;1},1,TRUE)', '2', '1'],
    ['=MATCH("a",{1,"a",2,"a",3,"a"},1)', '4', '6'],
    ['=MATCH(2,{"a",1,"a",2,"a",3},-1)', '#N/A', '4'],
    ['=MATCH(95,{10,20,30,40,50,60,70,80,"x",100,110,120,130,140,150,160,170},-1)', '#N/A', '17'],
    ['=MATCH(95,{10,20,30,40,50,60,70,80,TRUE,100,110,120,130,140,150,160,170},-1)', '#N/A', '17'],
    ['=MATCH(2,C1:C3,-1)', '1', '3'],
    ['=MATCH(4,C1:C3,-1)', '#N/A', '2'],
    ['=MATCH(4,{6,4,2})', '2', '3'],
    ['=MATCH(2,C1:C3,-0.5)', '1', '3'],
    ['=MATCH(2,C1:C3,-1.9)', '1', '3'],
    ['=MATCH("abc",B1:B7,1)', '5', '6'],
    ['=MATCH("abc",B1:B7)', '5', '6'],
    ['=MATCH(2,{1,#N/A,3},-1)', '#N/A', '3'],
    ['=MATCH(2,{1,2,2,2,2,2,2,2,2,2,2,2,3,2,2,4},1)', '12', '15'],
    ['=MATCH(2,A7:P7,1)', '12', '15'],
];

// The recorded rows with ours in place of Excel's value where the owner's pick differs.
function pinned(rows: readonly (readonly [string, string])[]): string[][] {
    return rows.map(([formula, answer]) => [formula, PICKED.find((row) => row[0] === formula)?.[2] ?? answer]);
}

describe("Excel's search order, the model", () => {
    test('answers every cell of batch 12, part A', () => {
        expect(CELLS.length).toBe(517);
        expect(CELLS.filter(([formula, answer]) => modelOf(formula, true) !== answer)).toEqual([]);
    });

    test('answers every typed row of MATCH and XMATCH', () => {
        expect(TYPED.length).toBe(175);
        expect(TYPED.filter(([formula, answer]) => modelOf(formula, true) !== answer)).toEqual([]);
    });

    test('answers every row of batch 13, part 2e, but the XLOOKUP', () => {
        expect(MODELLED_13.filter(([formula, answer]) => modelOf(formula, true) !== answer)).toEqual([]);
    });

    test('answers every row of batch 14, part a', () => {
        expect(BATCH_14.length).toBe(22);
        expect(BATCH_14.filter(([formula, answer]) => modelOf(formula, true) !== answer)).toEqual([]);
    });

    test("halving differs from Excel on the rows of the owner's pick and on no other", () => {
        const differing = [...CELLS, ...TYPED, ...MODELLED_13, ...BATCH_14]
            .map(([formula, answer]) => [formula, answer, modelOf(formula)])
            .filter(([, answer, ours]) => ours !== answer)
            .filter(([formula], at, rows) => rows.findIndex((row) => row[0] === formula) === at);
        expect(differing).toEqual(PICKED.map((row) => [...row]));
    });
});

// Excel batch 13, part 2e: the step after a probe moved right onto a larger item, MATCH type -1 on nine lists, and
// a blank inside a list.
const BATCH_13: readonly (readonly [string, string])[] = [
    ['=MATCH(2,{2,1,"a",3,1},1)', '2'],
    ['=MATCH(5,{9,7,5,5,3},-1)', '3'],
    ['=MATCH(5,{9,7,6,4,3},-1)', '3'],
    ['=MATCH(5,{9,7,5,6,5},-1)', '3'],
    ['=MATCH(10,{9,7,5},-1)', '#N/A'],
    ['=MATCH(1,{9,7,5},-1)', '3'],
    ['=MATCH("b",{"d","c","b","a"},-1)', '3'],
    ['=MATCH(5,{9,"x",5,3},-1)', '3'],
    ['=MATCH(5,{9,#N/A,5,3},-1)', '3'],
    ['=XMATCH(3,G1:G5,0,2)', '#N/A'],
    ['=XMATCH(3,G1:G5,-1,2)', '2'],
    ['=XMATCH(2.5,G1:G5,-1,2)', '2'],
    ['=XMATCH(2.5,G1:G5,1,2)', '3'],
    ['=XLOOKUP(3,G1:G5,G1:G5,"nf",0,2)', 'nf'],
    ['=XMATCH(3,G1:G5,0,-2)', '4'],
    ['=MATCH(3,G1:G5,1)', '4'],
    ['=MATCH(2.5,G1:G5,1)', '2'],
    ['=LOOKUP(2.5,G1:G5)', '2'],
];

// Excel batch 14, part a: equal items that come back after a larger one, as arrays and as cells.
const BATCH_14: readonly (readonly [string, string])[] = [
    ['=MATCH(2,{1,2,2,3,2,2,2},1)', '3'],
    ['=MATCH(2,{1,2,2,3,2,2,2,4},1)', '3'],
    ['=MATCH(2,{2,2,3,2,2,2,2},1)', '7'],
    ['=MATCH(2,{1,2,3,2,2,2,2,2,2},1)', '9'],
    ['=MATCH(2,{1,1,2,2,3,2,2,2,2,2,2,2,2,2,5},1)', '14'],
    ['=MATCH(2,{2,2,2,2,2,2,2,3,2,2,2,2,2,2,2},1)', '7'],
    ['=MATCH(2,{1,2,2,2,2,2,2,2,2,2,2,2,3,2,2,4},1)', '12'],
    ['=MATCH("b",{"a","b","b","c","b","b","b"},1)', '3'],
    ['=LOOKUP(2,{1,2,2,3,2,2,2})', '2'],
    ['=VLOOKUP(2,{1;2;2;3;2;2;2},1,TRUE)', '2'],
    ['=XMATCH(2,{1,2,2,3,2,2,2},0,2)', '2'],
    ['=XMATCH(2,{1,2,2,3,2,2,2},0,-2)', '7'],
    ['=XMATCH(2,{1,2,2,3,2,2,2},-1,2)', '2'],
    ['=MATCH(2,{1,2,2,2,2,2,2},1)', '7'],
    ['=MATCH(2,{2,2,2,2,2,2,2,2},1)', '8'],
    ['=MATCH(2,A1:G1,1)', '3'],
    ['=MATCH(2,A2:H2,1)', '3'],
    ['=MATCH(2,A3:G3,1)', '7'],
    ['=MATCH(2,A4:I4,1)', '9'],
    ['=MATCH(2,A5:O5,1)', '14'],
    ['=MATCH(2,A6:O6,1)', '7'],
    ['=MATCH(2,A7:P7,1)', '12'],
];

const MODELLED_13 = BATCH_13.filter(([formula]) => !formula.startsWith('=XLOOKUP'));

describe("Excel's search order, the engine", () => {
    test('answers every cell of batch 12, part A', () => {
        const ours = engineOn(CELLS.map(([formula]) => formula));
        expect(CELLS.map(([formula], at) => [formula, ours[at]])).toEqual(pinned(CELLS));
    });

    test('answers every row of batch 13, part 2e', () => {
        const ours = engineOn(
            BATCH_13.map(([formula]) => formula),
            BLANKED,
        );
        expect(BATCH_13.map(([formula], at) => [formula, ours[at]])).toEqual(pinned(BATCH_13));
    });

    test('answers every row of batch 14, part a', () => {
        const ours = engineOn(
            BATCH_14.map(([formula]) => formula),
            RUNS,
        );
        expect(BATCH_14.map(([formula], at) => [formula, ours[at]])).toEqual(pinned(BATCH_14));
    });

    // The escape of a pattern, "k~2", is the wildcard module's and not held here.
    test('answers every typed row of MATCH and XMATCH', () => {
        const rows = TYPED.filter(([formula]) => !formula.includes('~'));
        const ours = engineOn(rows.map(([formula]) => formula));
        expect(rows.map(([formula], at) => [formula, ours[at]])).toEqual(pinned(rows));
    });
});

// The same eleven forms, as the model answers them.
const SEARCHES: readonly ((list: readonly Item[], key: Key) => number)[] = [
    upward,
    downward,
    (list, key) => linear(list, key, true, false),
    (list, key) => bisection(list, key, false, 0),
    (list, key) => bisection(list, key, true, 0),
    (list, key) => bisection(list, key, false, -1),
    (list, key) => bisection(list, key, false, 1),
    (list, key) => bisection(list, key, true, -1),
    (list, key) => bisection(list, key, true, 1),
    upward,
    upward,
];

function typed(item: Item): string {
    return typeof item === 'string' ? `"${item}"` : shown(item);
}

// What the engine shows for the eleven forms over a list, as an array constant and as the cells of a column,
// beside what the model says.
function bothOn(list: readonly Item[], key: Key) {
    const model = SEARCHES.map((search, form) => {
        const at = search(list, key);
        return at < 0 ? '#N/A' : form < 9 ? String(at + 1) : shown(list[at]);
    });
    const range = `A1:A${list.length}`;
    const cells = engineOn(
        FORMS.map((form) => form(typed(key), range)),
        { [range]: list },
    );
    const constant = list.includes(null)
        ? model
        : engineOn(FORMS.map((form) => form(typed(key), `{${list.map(typed).join(';')}}`)));
    return { list, key, model, cells, constant };
}

describe("Excel's search order, the engine against the model", () => {
    const POOL: readonly Item[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 'a', 'b', 'c', 'd', '', true, false, ERRORS.na, null];
    const KEYS: readonly Key[] = [0, 1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9, 10, 'a', 'b', 'bb', 'c', 'd', 'e', true, false];
    let seed = 20261112;
    const next = (below: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % below;
    };

    // Half the lists draw from three values only, so that runs of equals are common.
    test('on 1,500 lists of any kinds in any order, each as an array and as cells', () => {
        const differing = [];
        for (let round = 0; round < 1500; round += 1) {
            const few = round % 2 === 0 ? [POOL[next(18)], POOL[next(18)], POOL[next(18)]] : POOL;
            const list = Array.from({ length: 1 + next(12) }, () => few[next(few.length)]);
            const seen = bothOn(list, KEYS[next(KEYS.length)]);
            if (seen.cells.join() !== seen.model.join() || seen.constant.join() !== seen.model.join())
                differing.push(seen);
        }
        expect(differing).toEqual([]);
    });

    // The blank cells above the sevens are one run that the array holds once.
    test('a search downward finds the first of a run of equals, and the last of a run above the key', () => {
        const ours = engineOn(
            ['=MATCH(2,(A1:A9="")+1,-1)', '=MATCH(1.5,(A1:A9="")+1,-1)', '=MATCH(1,(A1:A9="")+1,-1)'],
            {
                'A7:A9': [7, 7, 7],
            },
        );
        expect(ours).toEqual(['1', '6', '7']);
    });

    // The owner's pick keeps Excel's answer on sorted lists, long runs of equal items included: there halving finds
    // what Excel's reading on finds. Downward that holds with items of another kind anywhere among them; upward
    // Excel's walk along a run stops at one, so there they stand before the first item or after the last.
    test("on 1,200 sorted lists MATCH types 1 and -1 answer as Excel's own steps do", () => {
        const differing = [];
        for (let round = 0; round < 1200; round += 1) {
            const up = round % 4 < 2;
            const all: readonly Key[] =
                round % 2 === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
            const long = round % 5 === 0;
            const pool = long ? [all[next(all.length)], all[next(all.length)], all[next(all.length)]] : all;
            const others: readonly Item[] = round % 2 === 0 ? ['x', true, ERRORS.na, null] : [5, false, null];
            const list: Item[] = Array.from(
                { length: long ? 30 + next(60) : 1 + next(12) },
                () => pool[next(pool.length)],
            );
            list.sort((one, other) => (up ? against(one, other) : -against(one, other)));
            if (round % 3 === 0) {
                for (let more = next(6); more > 0; more -= 1) {
                    const at = up ? next(2) * list.length : next(list.length);
                    list.splice(at, 0, others[next(others.length)]);
                }
            }
            // Every tenth list is the cells of a whole column, far apart.
            let row = 0;
            const rows = list.map(() => {
                row += 1 + (round % 10 === 0 ? next(Math.floor(1048576 / list.length)) : 0);
                return row;
            });
            const sparse: Item[] = new Array(row).fill(null);
            list.forEach((item, at) => {
                sparse[rows[at] - 1] = item;
            });
            const key: Key = round % 2 === 0 ? next(27) / 2 : ['a', 'aa', 'c', 'cc', 'g', 'h', ''][next(7)];
            const cells: Record<string, Literal> = {};
            list.forEach((item, at) => {
                if (item !== null) cells[`A${rows[at]}`] = cellOf(item);
            });
            const constant = list.includes(null) ? `A1:A${row}` : `{${list.map(typed).join(';')}}`;
            [`A1:A${row}`, 'A:A', constant].forEach((range, at) => {
                cells[`N${at + 1}`] = `=MATCH(${typed(key)},${range},${up ? 1 : -1})`;
            });
            const engine = engineOf({ s1: cells });
            engine.recalc(Number.POSITIVE_INFINITY);
            const ours = ['N1', 'N2', 'N3'].map((cell) => shown(valueAt(engine, cell)));
            const law = [sparse, sparse, list.includes(null) ? sparse : list].map((items) => {
                // The model of Excel's walk stops at a blank between equal cells, which no row records: there
                // only ours is held.
                const apart = up && items.length > list.length;
                const excel = apart ? upward(items, key) : up ? walked(items, key) : scanned(items, key);
                const model = up ? upward(items, key) : downward(items, key);
                return model !== excel ? 'the model differs' : excel < 0 ? '#N/A' : String(excel + 1);
            });
            if (ours.join() !== law.join()) differing.push({ list, rows, key, ours, law });
        }
        expect(differing).toEqual([]);
    });

    // The law that needs no model: on sorted values that are all different, each form finds what it is named for.
    test('on sorted lists of different values every form answers by its definition', () => {
        const differing = [];
        for (let round = 0; round < 300; round += 1) {
            const pool: readonly Key[] =
                round % 2 === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
            const up = pool.filter(() => next(3) > 0);
            if (up.length === 0) continue;
            const key: Key = round % 2 === 0 ? next(27) / 2 : ['a', 'aa', 'c', 'cc', 'g', 'h', ''][next(7)];
            const atMost = up.findLast((item) => compareValues(item, key) <= 0);
            const atLeast = up.find((item) => compareValues(item, key) >= 0);
            const placed = (item: Key | undefined) => (item === undefined ? '#N/A' : String(up.indexOf(item) + 1));
            const turned = (item: Key | undefined) =>
                item === undefined ? '#N/A' : String(up.length - up.indexOf(item));
            const same = atMost === atLeast ? atMost : undefined;
            const rising = bothOn(up, key).cells;
            const falling = bothOn(up.toReversed(), key).cells;
            const ours = [rising[0], falling[1], rising[2], rising[3], falling[4], rising[5], rising[6], falling[7]];
            const law = [atMost, atLeast, same, same, same, atMost, atLeast, atMost].map((item, form) =>
                form === 1 || form === 4 || form === 7 ? turned(item) : placed(item),
            );
            law.push(turned(atLeast), atMost === undefined ? '#N/A' : shown(atMost));
            ours.push(falling[8], rising[9]);
            if (ours.join() !== law.join() || rising[10] !== rising[9]) differing.push({ up, key, ours, law });
        }
        expect(differing).toEqual([]);
    });
});

// The values of the formulas in column C over a column A of `rows` cells, and how many cells their searches read.
function readsOf(rows: number, fill: (row: number) => Literal, formulas: readonly string[]) {
    const sheet: SheetSource = {
        id: 's1',
        name: 'Sheet1',
        cells: (cell) => {
            for (let row = 0; row < rows; row += 1) cell(row, 0, fill(row), null);
            formulas.forEach((formula, row) => {
                cell(row, 2, null, stored(formula, `C${row + 1}`));
            });
        },
    };
    const engine = new Engine([sheet]);
    const { value } = Workbook.prototype;
    let reads = 0;
    Workbook.prototype.value = function counted(column, row) {
        reads += 1;
        return value.call(this, column, row);
    };
    try {
        engine.recalc(Number.POSITIVE_INFINITY);
    } finally {
        Workbook.prototype.value = value;
    }
    return { reads, values: formulas.map((_, row) => engine.valueOf('s1', row, 2)) };
}

describe('what a search of sorted values costs', () => {
    const WHOLE = 1048576;

    test('a whole column of sorted cells is halved: at most 22 cells read per search', () => {
        const formulas = [1, 2, 500001, 2097151, 2097152, 3000000].flatMap((key) => [
            `=MATCH(${key},A:A,1)`,
            `=LOOKUP(${key},A:A)`,
            `=VLOOKUP(${key},A:A,1,TRUE)`,
            `=XMATCH(${key},A:A,0,2)`,
            `=XMATCH(${key},A:A,-1,2)`,
            `=XMATCH(${key},A:A,1,2)`,
            `=XMATCH(${key},A:A,-1,-2)`,
        ]);
        const { reads, values } = readsOf(WHOLE, (row) => 2 * row + 2, formulas);
        expect(reads).toBeLessThanOrEqual(22 * formulas.length);
        expect(values.slice(0, 7)).toEqual([NA, NA, NA, NA, NA, 1, NA]);
        expect(values.slice(14, 21)).toEqual([250000, 500000, 500000, NA, 250000, 250001, NA]);
        expect(values.slice(28, 35)).toEqual([WHOLE, 2097152, 2097152, WHOLE, WHOLE, WHOLE, 1]);
    });

    test('100,000 lookups in a sorted table of 100,000 rows read at most 19 cells each', () => {
        const rows = 100000;
        const formulas = Array.from({ length: rows }, (_, row) => `=VLOOKUP(${3 * row + 4},A$1:A$${rows},1)`);
        const { reads, values } = readsOf(rows, (row) => 3 * row + 3, formulas);
        expect(reads).toBeLessThanOrEqual(19 * rows);
        expect(values.every((found, row) => found === 3 * row + 3)).toBe(true);
    });

    test('a whole column sorted downward is halved by MATCH type -1: at most 22 cells read per search', () => {
        const formulas = [1, 2, 500001, 2097151, 2097152, 3000000].map((key) => `=MATCH(${key},A:A,-1)`);
        const { reads, values } = readsOf(WHOLE, (row) => 2 * (WHOLE - row), formulas);
        expect(reads).toBeLessThanOrEqual(22 * formulas.length);
        expect(values).toEqual([WHOLE, WHOLE, WHOLE - 250000, 1, 1, NA]);
    });

    test('a run of equal values is halved too: a column of ten values, or of one, reads at most 22 cells', () => {
        const formulas = [0, 1, 5, 5.5, 10, 11].flatMap((key) => [
            `=MATCH(${key},A:A,1)`,
            `=LOOKUP(${key},A:A)`,
            `=VLOOKUP(${key},A:A,1,TRUE)`,
        ]);
        const ten = readsOf(1000000, (row) => 1 + Math.floor(row / 100000), formulas);
        expect(ten.reads).toBeLessThanOrEqual(22 * formulas.length);
        expect(ten.values).toEqual([
            NA,
            NA,
            NA,
            100000,
            1,
            1,
            500000,
            5,
            5,
            500000,
            5,
            5,
            1000000,
            10,
            10,
            1000000,
            10,
            10,
        ]);
        const one = [
            '=MATCH(2,A:A,1)',
            '=VLOOKUP(2,A:A,1,TRUE)',
            '=MATCH(2,A:A,-1)',
            '=XMATCH(2,A:A,0,2)',
            '=XMATCH(2,A:A,0,-2)',
        ];
        const equal = readsOf(WHOLE, () => 2, one);
        expect(equal.values).toEqual([WHOLE, 2, 1, 1, WHOLE]);
        expect(equal.reads).toBeLessThanOrEqual(22 * one.length);
    });

    // Values of another kind are stepped over once, not once per halving.
    test('a column of values of another kind is read at most once', () => {
        const other = readsOf(WHOLE, () => 'x', ['=MATCH(2,A:A,1)', '=XMATCH(2,A:A,0,2)']);
        expect(other.values).toEqual([NA, NA]);
        expect(other.reads).toBeLessThanOrEqual(WHOLE + 2 * 22);
        expect(readsOf(WHOLE, () => 'x', ['=MATCH(2,A:A,-1)'])).toEqual({ reads: WHOLE, values: [NA] });
    });

    // Values of the key's kind in any order among values of another kind: a search reads no cell a fourth time.
    test('no column makes MATCH type -1 read more than three times its cells', () => {
        let seed = 34;
        const next = (below: number) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return (seed >>> 8) % below;
        };
        let most = 0;
        for (let round = 0; round < 300; round += 1) {
            const rows = 1 + next(3000);
            const kinds = Array.from({ length: rows }, () => next(1 + (round % 7) * 40) === 0);
            const { reads } = readsOf(rows, (row) => (kinds[row] ? next(9) : 'x'), [`=MATCH(${next(9)},A:A,-1)`]);
            most = Math.max(most, reads / rows);
        }
        expect(most).toBeLessThanOrEqual(3);
    });
});
