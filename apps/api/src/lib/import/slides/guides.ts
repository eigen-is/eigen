import { A_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr } from '../../core/xml';
import { cachedBy, charge, childrenOf } from './lookup';
import { emu } from './package';

// DrawingML's shape guides (ECMA-376 §20.1.9.11), as a custGeom and the presets compute their points: lengths in EMU,
// angles in 60,000ths of a degree. A formula is its operator and up to three arguments, each a number or a guide's name;
// nothing in it is ever run as code.

export type Guides = Map<string, number>;
export type GuideList = readonly (readonly [name: string, formula: string])[];

// A guide reads only the guides before it, so evaluation never recurses and no cycle can form: a name not yet defined,
// itself included, reads 0. The corpus's most is 1,905 in one custGeom, an export spelling every coordinate as a guide.
export const MAX_GUIDES = 4096;

// An operator and three arguments, each a number emu() reads or a name: past this a formula is junk, read as 0 unread.
const MAX_FORMULA_CHARS = 256;

export const DEGREE = 60_000;
export const RADIANS_PER_UNIT = Math.PI / (180 * DEGREE);

// x, y, z as the spec names them. Whatever comes out not finite (a quotient by zero, an overflow, a negative root) is 0.
const OPERATORS = new Map<string, (x: number, y: number, z: number) => number>([
    ['*/', (x, y, z) => (x * y) / z],
    ['+-', (x, y, z) => x + y - z],
    ['+/', (x, y, z) => (x + y) / z],
    ['?:', (x, y, z) => (x > 0 ? y : z)],
    ['abs', (x) => Math.abs(x)],
    ['at2', (x, y) => Math.atan2(y, x) / RADIANS_PER_UNIT],
    ['cat2', (x, y, z) => x * Math.cos(Math.atan2(z, y))],
    ['cos', (x, y) => x * Math.cos(y * RADIANS_PER_UNIT)],
    ['max', (x, y) => Math.max(x, y)],
    ['min', (x, y) => Math.min(x, y)],
    ['mod', (x, y, z) => Math.hypot(x, y, z)],
    ['pin', (x, y, z) => (y < x ? x : y > z ? z : y)],
    ['sat2', (x, y, z) => x * Math.sin(Math.atan2(z, y))],
    ['sin', (x, y) => x * Math.sin(y * RADIANS_PER_UNIT)],
    ['sqrt', (x) => Math.sqrt(x)],
    ['tan', (x, y) => x * Math.tan(y * RADIANS_PER_UNIT)],
    ['val', (x) => x],
]);

const guideLists = cachedBy<null, GuideList>();

// An a:avLst's or a:gdLst's a:gd, in order, read once for the list however many shapes it draws.
export function guideListOf(list: XmlElement | undefined): GuideList {
    if (!list) return [];
    return guideLists(list, null, () =>
        childrenOf(list, A_NS, 'gd').map((gd) => [xmlAttr(gd, '', 'name') ?? '', xmlAttr(gd, '', 'fmla') ?? '']),
    );
}

// The shape's own guides for its extents, then each list's in order, a later guide replacing an earlier one of its name
// (a shape's avLst a preset's defaults); undefined past MAX_GUIDES.
export function evaluateGuides(width: number, height: number, ...lists: GuideList[]): Guides | undefined {
    if (lists.reduce((count, list) => count + list.length, 0) > MAX_GUIDES) return undefined;
    const guides = shapeGuides(width, height);
    for (const list of lists) {
        for (const [name, formula] of list) {
            charge(1);
            guides.set(name, formulaValue(formula, guides));
        }
    }
    return guides;
}

// A point's coordinate or a formula's argument: a number, a universal measure, else a guide's name; 0 for none.
export function guideValue(guides: Guides, value: string | undefined): number {
    if (value === undefined) return 0;
    return emu(value) ?? guides.get(value) ?? 0;
}

function formulaValue(formula: string, guides: Guides): number {
    if (formula.length > MAX_FORMULA_CHARS) return 0;
    const [operator = '', ...args] = formula.trim().split(/\s+/, 4);
    const [x = 0, y = 0, z = 0] = args.map((arg) => guideValue(guides, arg));
    const value = OPERATORS.get(operator)?.(x, y, z) ?? 0;
    return Number.isFinite(value) ? value : 0;
}

function shapeGuides(w: number, h: number): Guides {
    const [ss, ls] = [Math.min(w, h), Math.max(w, h)];
    const fractions = (name: string, of: number, divisors: number[]) =>
        divisors.map((divisor): [string, number] => [`${name}${divisor}`, of / divisor]);
    return new Map([
        ['w', w],
        ['h', h],
        ['l', 0],
        ['t', 0],
        ['r', w],
        ['b', h],
        ['hc', w / 2],
        ['vc', h / 2],
        ['ss', ss],
        ['ls', ls],
        // The spec's, and wd12, hd10 and cd3, which the preset definitions read and LibreOffice defines.
        ...fractions('wd', w, [2, 3, 4, 5, 6, 8, 10, 12, 32]),
        ...fractions('hd', h, [2, 3, 4, 5, 6, 8, 10]),
        ...fractions('ssd', ss, [2, 4, 6, 8, 16, 32]),
        ['cd8', 45 * DEGREE],
        ['cd4', 90 * DEGREE],
        ['cd3', 120 * DEGREE],
        ['3cd8', 135 * DEGREE],
        ['cd2', 180 * DEGREE],
        ['5cd8', 225 * DEGREE],
        ['3cd4', 270 * DEGREE],
        ['7cd8', 315 * DEGREE],
    ]);
}
