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

// MATCH type 1, LOOKUP and an approximate VLOOKUP or HLOOKUP. The list is halved. A probe at an item of another
// kind moves to the next item of the key's kind after it, else to the one before it. A probe that equals the key
// ends the search at the last of the equal items that follow it; a smaller one sends the search to the right.
function upward(list: readonly Item[], key: Key): number {
    const used = usedOf(list);
    let low = 0;
    let high = used - 1;
    let before = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        let at = middle;
        while (at < high && Number.isNaN(against(list[at], key))) at += 1;
        if (Number.isNaN(against(list[at], key))) at = middle;
        while (at > low && Number.isNaN(against(list[at], key))) at -= 1;
        const order = against(list[at], key);
        if (Number.isNaN(order)) break;
        if (order === 0) {
            while (at + 1 < used && against(list[at + 1], key) === 0) at += 1;
            return at;
        }
        if (order < 0) {
            before = at;
            low = at + 1;
        } else high = Math.min(at, middle) - 1;
    }
    return before;
}

// MATCH type -1: no halving. The items of the key's kind are read from the first one on; the key itself ends the
// search, and so does the first smaller item, which leaves the last larger one before it.
function downward(list: readonly Item[], key: Key): number {
    let above = -1;
    for (let at = 0; at < list.length; at += 1) {
        const order = against(list[at], key);
        if (order === 0) return at;
        if (order < 0) break;
        if (order > 0) above = at;
    }
    return above;
}

// XMATCH search modes 2 and -2: a textbook bisection in the one order of all values (number, text, boolean), an
// error past them all and a blank ahead of them (the blank is not recorded: Excel check). Of equal items the first when the list goes up, the last when it goes down.
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
        const order = item === null ? -1 : typeof item === 'object' ? 1 : compareValues(item, key);
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

// What the model says a recorded formula shows: a position, the item found, or #N/A.
function modelOf(formula: string): string {
    const [, name = '', inside = ''] = /^=(\w+)\((.*)\)$/.exec(formula) ?? [];
    const [first = '', second = '', ...rest] = inside.split(/,(?![^{]*\})/);
    const key = itemOf(first);
    const list =
        RANGES[second] ??
        second
            .slice(1, -1)
            .split(/[,;]/)
            .map((text) => itemOf(text) ?? null);
    if (key === undefined || key === null || typeof key === 'object') throw new Error(`no model of ${formula}`);
    const [third, fourth] = rest.map((text) => (text === '' ? undefined : Number(text)));
    let at: number;
    if (name === 'LOOKUP' || name === 'VLOOKUP') {
        at = upward(list, key);
        return at < 0 ? '#N/A' : shown(list[at]);
    }
    if (name === 'MATCH') {
        const type = third ?? 1;
        at = type === 0 ? linear(list, key, true, false) : type > 0 ? upward(list, key) : downward(list, key);
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
        cells[`N${row + 1}`] = formula;
    });
    const engine = engineOf({ s1: cells });
    engine.recalc(Number.POSITIVE_INFINITY);
    return formulas.map((_, row) => shown(valueAt(engine, `N${row + 1}`)));
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

describe("Excel's search order, the model", () => {
    test('answers every cell of batch 12, part A', () => {
        expect(CELLS.length).toBe(517);
        expect(CELLS.filter(([formula, answer]) => modelOf(formula) !== answer)).toEqual([]);
    });

    test('answers every typed row of MATCH and XMATCH', () => {
        expect(TYPED.length).toBe(175);
        expect(TYPED.filter(([formula, answer]) => modelOf(formula) !== answer)).toEqual([]);
    });
});

describe("Excel's search order, the engine", () => {
    test('answers every cell of batch 12, part A', () => {
        const ours = engineOn(CELLS.map(([formula]) => formula));
        expect(CELLS.map(([formula], at) => [formula, ours[at]])).toEqual(CELLS.map((cell) => [...cell]));
    });

    // The escape of a pattern, "k~2", is the wildcard module's and not held here.
    test('answers every typed row of MATCH and XMATCH', () => {
        const rows = TYPED.filter(([formula]) => !formula.includes('~'));
        const ours = engineOn(rows.map(([formula]) => formula));
        expect(rows.map(([formula], at) => [formula, ours[at]])).toEqual(rows.map((row) => [...row]));
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
    test('a scan from the top stops at the first of a run of equals, and leaves the last of a run above the key', () => {
        const ours = engineOn(
            ['=MATCH(2,(A1:A9="")+1,-1)', '=MATCH(1.5,(A1:A9="")+1,-1)', '=MATCH(1,(A1:A9="")+1,-1)'],
            {
                'A7:A9': [7, 7, 7],
            },
        );
        expect(ours).toEqual(['1', '6', '7']);
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

    // A run of equals is walked once, and values of another kind are stepped over once: neither once per halving.
    test('a column of equal values, or of values of another kind, is read at most once', () => {
        const equal = readsOf(WHOLE, () => 2, ['=MATCH(2,A:A,1)', '=XMATCH(2,A:A,0,2)', '=XMATCH(2,A:A,0,-2)']);
        expect(equal.values).toEqual([WHOLE, 1, WHOLE]);
        expect(equal.reads).toBeLessThanOrEqual(WHOLE / 2 + 3 * 22);
        const other = readsOf(WHOLE, () => 'x', ['=MATCH(2,A:A,1)', '=XMATCH(2,A:A,0,2)']);
        expect(other.values).toEqual([NA, NA]);
        expect(other.reads).toBeLessThanOrEqual(WHOLE + 2 * 22);
    });
});
