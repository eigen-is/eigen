import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../../lib/core/errors';
import { xmlChild } from '../../../lib/core/xml';
import { evaluateGuides, type GuideList, guideListOf, guideValue, MAX_GUIDES } from '../../../lib/import/slides/guides';
import { affords, withWorkBudget } from '../../../lib/import/slides/lookup';
import { A_NS, parseOoxml } from '../../../lib/ooxml/ooxml';
import { NS } from '../../fixtures/pptx';

// DrawingML's shape guide formulas: lengths in EMU, angles in 60,000ths of a degree, every result finite.

const DEGREE = 60_000;

// The value the last guide of `list` takes in a 1000 × 500 shape.
const last = (...list: GuideList[number][]) => {
    const guides = evaluateGuides(1000, 500, list);
    return guides?.get(list.at(-1)?.[0] ?? '');
};
const formula = (fmla: string) => last(['x', fmla]);

describe('the shape guides', () => {
    test("name the shape's extents, their fractions and the quarter turns", () => {
        const guides = evaluateGuides(1000, 500);
        const expected = {
            w: 1000,
            h: 500,
            l: 0,
            t: 0,
            r: 1000,
            b: 500,
            hc: 500,
            vc: 250,
            ss: 500,
            ls: 1000,
            wd2: 500,
            wd3: 1000 / 3,
            wd4: 250,
            wd5: 200,
            wd6: 1000 / 6,
            wd8: 125,
            wd10: 100,
            wd12: 1000 / 12,
            wd32: 31.25,
            hd2: 250,
            hd3: 500 / 3,
            hd4: 125,
            hd5: 100,
            hd6: 500 / 6,
            hd8: 62.5,
            hd10: 50,
            ssd2: 250,
            ssd4: 125,
            ssd6: 500 / 6,
            ssd8: 62.5,
            ssd16: 31.25,
            ssd32: 15.625,
            cd8: 45 * DEGREE,
            cd4: 90 * DEGREE,
            cd3: 120 * DEGREE,
            '3cd8': 135 * DEGREE,
            cd2: 180 * DEGREE,
            '5cd8': 225 * DEGREE,
            '3cd4': 270 * DEGREE,
            '7cd8': 315 * DEGREE,
        };
        expect(Object.fromEntries(guides ?? [])).toEqual(expected);
    });
});

describe('a formula', () => {
    test('evaluates each of the 17 operators', () => {
        const cases: [string, number][] = [
            ['*/ 6 4 3', 8],
            ['+- 6 4 3', 7],
            ['+/ 6 4 5', 2],
            ['?: 1 4 5', 4],
            ['?: 0 4 5', 5],
            ['?: -1 4 5', 5],
            ['abs -7', 7],
            [`at2 1 1`, 45 * DEGREE],
            [`at2 -1 0`, 180 * DEGREE],
            [`cat2 10 3 4`, 6],
            [`cos 10 ${60 * DEGREE}`, 5],
            ['max 3 -8', 3],
            ['min 3 -8', -8],
            ['mod 2 3 6', 7],
            ['pin 0 -5 10', 0],
            ['pin 0 5 10', 5],
            ['pin 0 15 10', 10],
            [`sat2 10 3 4`, 8],
            [`sin 10 ${30 * DEGREE}`, 5],
            ['sqrt 16', 4],
            [`tan 10 ${45 * DEGREE}`, 10],
            ['val -12', -12],
        ];
        for (const [fmla, value] of cases) expect([fmla, formula(fmla)]).toEqual([fmla, expect.closeTo(value, 9)]);
    });

    test('mod of a length past the square root of the largest double is that length, not an overflow', () => {
        const max = '9007199254740991';
        const value = last(
            ['a', `*/ ${max} ${max} 1`],
            ['b', '*/ a a 1'],
            ['c', '*/ b b 1'],
            ['d', '*/ c c 1'],
            ['e', 'mod d 0 0'],
        );
        expect(value).toBe(Number(max) ** 16);
    });

    test("reads the shape guides, guides before it and the avLst's adjust values by name", () => {
        const guides = evaluateGuides(
            1000,
            500,
            [['adj', 'val 25000']],
            [
                ['a', '*/ ss adj 100000'],
                ['b', '+- r 0 a'],
            ],
        );
        expect([guides?.get('a'), guides?.get('b')]).toEqual([125, 875]);
    });

    test("a later list's guide replaces an earlier one's of its name, as a shape's avLst does a preset's", () => {
        const guides = evaluateGuides(1000, 500, [['adj', 'val 25000']], [['adj', 'val 50000']], [['a', 'val adj']]);
        expect(guides?.get('a')).toBe(50000);
    });

    test('is 0 where it divides by zero, overflows, takes a negative root, or names no operator', () => {
        const huge = `1${'0'.repeat(300)}`;
        for (const fmla of [
            '*/ 5 6 0',
            '+/ 5 6 0',
            'sqrt -4',
            `*/ ${huge} ${huge} 1`,
            `+- ${huge}${'0'.repeat(10)} 0 0`,
            'eval 5',
            'constructor 1',
            '',
        ])
            expect([fmla, formula(fmla)]).toEqual([fmla, 0]);
    });

    test('is 0 for a missing argument, an unknown name, and a guide not yet defined', () => {
        expect(formula('*/ 5 6')).toBe(0);
        expect(formula('+- 5')).toBe(5);
        expect(formula('val nope')).toBe(0);
        expect(formula('val NaN')).toBe(0);
        expect(formula('val Infinity')).toBe(0);
        expect(formula('val 1e308')).toBe(0);
        const guides = evaluateGuides(1000, 500, [
            ['p', 'val q'],
            ['q', 'val 5'],
        ]);
        expect([guides?.get('p'), guides?.get('q')]).toEqual([0, 5]);
    });

    test('past 256 characters is 0 unread: no operator and three arguments need more', () => {
        const padded = (length: number) => `+- 5${' '.repeat(length - '+- 57 0'.length)}7 0`;
        expect([padded(256).length, formula(padded(256))]).toEqual([256, 12]);
        expect(formula(padded(257))).toBe(0);
        expect(formula(`val 1${' '.repeat(4_000_000)}`)).toBe(0);
    });

    test('a guide that names itself or a cycle reads only what came before it', () => {
        const guides = evaluateGuides(1000, 500, [
            ['a', '+- a 1 0'],
            ['a', '+- a 1 0'],
            ['p', 'val q'],
            ['q', 'val p'],
        ]);
        expect([guides?.get('a'), guides?.get('p'), guides?.get('q')]).toEqual([2, 0, 0]);
    });

    test('a chain of guides each reading the one before is evaluated without recursion', () => {
        const chain: [string, string][] = [['g0', 'val 1']];
        for (let i = 1; i < MAX_GUIDES; i++) chain.push([`g${i}`, `+- g${i - 1} 1 0`]);
        expect(evaluateGuides(1000, 500, chain)?.get(`g${MAX_GUIDES - 1}`)).toBe(MAX_GUIDES);
    });
});

describe('a coordinate', () => {
    test('is a number, a universal measure, or a guide by name; anything else is 0', () => {
        const guides = evaluateGuides(1000, 500) ?? new Map<string, number>();
        expect(guideValue(guides, '-250')).toBe(-250);
        expect(guideValue(guides, '1pt')).toBe(12700);
        expect(guideValue(guides, 'hc')).toBe(500);
        expect(guideValue(guides, 'nope')).toBe(0);
        expect(guideValue(guides, undefined)).toBe(0);
    });
});

describe('the guides of a shape', () => {
    test("are an a:avLst's or a:gdLst's a:gd in order", () => {
        const list = parseOoxml(
            `<a:gdLst ${NS}><a:gd name="a" fmla="val 5"/><a:x/><a:gd name="b" fmla="*/ a 2 1"/></a:gdLst>`,
        );
        expect(guideListOf(list ?? undefined)).toEqual([
            ['a', 'val 5'],
            ['b', '*/ a 2 1'],
        ]);
        expect(guideListOf(undefined)).toEqual([]);
        const custGeom = parseOoxml(`<a:custGeom ${NS}><a:gdLst/></a:custGeom>`);
        expect(guideListOf(custGeom ? xmlChild(custGeom, A_NS, 'gdLst') : undefined)).toEqual([]);
    });

    test('are read once for their list, however many shapes it draws', () => {
        const list = parseOoxml(`<a:avLst ${NS}>${'<a:gd name="a" fmla="val 5"/>'.repeat(100)}</a:avLst>`);
        if (!list) throw new Error('not XML');
        withWorkBudget(1000, () => {
            const first = guideListOf(list);
            expect(guideListOf(list)).toBe(first);
            // Its 100 children scanned once.
            expect([affords(900), affords(901)]).toEqual([true, false]);
        });
    });

    test('are refused past MAX_GUIDES across the lists', () => {
        const half = Array.from({ length: MAX_GUIDES / 2 }, (_, i): [string, string] => [`g${i}`, 'val 1']);
        expect(evaluateGuides(1000, 500, half, half)).toBeDefined();
        expect(evaluateGuides(1000, 500, half, half, [['one', 'val 1']])).toBeUndefined();
    });

    test("charge the read's work budget one unit a guide", () => {
        const list = Array.from({ length: 100 }, (_, i): [string, string] => [`g${i}`, 'val 1']);
        withWorkBudget(150, () => {
            evaluateGuides(1000, 500, list);
            expect([affords(50), affords(51)]).toEqual([true, false]);
        });
        expect(() => withWorkBudget(99, () => evaluateGuides(1000, 500, list))).toThrow(
            new ApiError(413, 'This presentation is too large to import'),
        );
    });
});
