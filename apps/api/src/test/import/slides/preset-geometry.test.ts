import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { MAX_PATH_BYTES, MAX_PATH_COMMANDS } from '@workspace/lib/vector';
import { parseXml, type XmlElement, xmlElements } from '../../../lib/core/xml';
import { affords, withWorkBudget } from '../../../lib/import/slides/lookup';
import { PRESET_KINDS, presetGeometry } from '../../../lib/import/slides/preset-geometry';
import { parseOoxml } from '../../../lib/ooxml/ooxml';
import { NS } from '../../fixtures/pptx';

// A shape's a:prstGeom → the native kind it is, or the paths Ecma's preset definitions draw for its adjust values.

const SLIDES = join(import.meta.dir, '../../../lib/import/slides');
const PRESETS_FILE = join(SLIDES, 'presetShapeDefinitions.xml');

const avLst = (guides: Record<string, string>): XmlElement => {
    const gds = Object.entries(guides).map(([name, fmla]) => `<a:gd name="${name}" fmla="${fmla}"/>`);
    const element = parseOoxml(`<a:avLst ${NS}>${gds.join('')}</a:avLst>`);
    if (!element) throw new Error('not XML');
    return element;
};

const FILLED = { closed: true, filled: true, stroked: true };

const presetNames = (): string[] => {
    const root = parseXml(fs.readFileSync(PRESETS_FILE));
    return root ? xmlElements(root).map((preset) => preset.local) : [];
};

describe('the preset definitions', () => {
    test('are read and parsed once, on first use', async () => {
        const read = spyOn(fs, 'readFileSync');
        try {
            const fresh: typeof import('../../../lib/import/slides/preset-geometry') = await import(
                `../../../lib/import/slides/preset-geometry?${Date.now()}`
            );
            expect(read).not.toHaveBeenCalled();
            fresh.presetGeometry('star5', undefined, 1000, 1000);
            fresh.presetGeometry('can', undefined, 1000, 1000);
            expect(read).toHaveBeenCalledTimes(1);
        } finally {
            read.mockRestore();
        }
    });

    test("are Ecma's file, byte for byte, as its NOTICE names it", () => {
        const notice = fs.readFileSync(join(SLIDES, 'NOTICE'), 'utf8');
        const bytes = fs.readFileSync(PRESETS_FILE);
        const [, size = '', sha256] = notice.match(/(\d{3},\d{3}) bytes, sha256 ([0-9a-f]{64})/) ?? [];
        expect(bytes.length).toBe(Number(size.replace(',', '')));
        expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(sha256);
        expect(sha256).toBe('2f7c868d857c1e3c4b5a6068759fe0e07d77ad58377a6618d1b02ba3507b6939');
    });
});

describe('a preset', () => {
    test('draws its paths in the unit box for its default adjust values', () => {
        expect(presetGeometry('triangle', undefined, 1000, 500)).toEqual([
            { path: 'M 0 1 L 0.5 0 L 1 1 Z', closed: true, filled: true, stroked: true },
        ]);
    });

    test("takes the shape's adjust values by name, ignoring one the preset does not define", () => {
        expect(presetGeometry('triangle', avLst({ adj: 'val 0', other: 'val 100000' }), 1000, 500)).toEqual([
            { path: 'M 0 1 L 0 0 L 1 1 Z', closed: true, filled: true, stroked: true },
        ]);
        expect(presetGeometry('triangle', avLst({ w: 'val 0', x2: 'val 0' }), 1000, 500)).toEqual(
            presetGeometry('triangle', undefined, 1000, 500),
        );
    });

    test("the shape's last adjust value of a name wins, however often it repeats the name", () => {
        const repeated = parseOoxml(
            `<a:avLst ${NS}>${'<a:gd name="adj" fmla="val 0"/>'.repeat(5000)}<a:gd name="adj" fmla="val 100000"/></a:avLst>`,
        );
        expect(presetGeometry('triangle', repeated ?? undefined, 1000, 500)?.[0].path).toBe('M 0 1 L 1 0 L 1 1 Z');
    });

    test('an unknown name is undefined, whatever an object would inherit', () => {
        for (const name of ['', 'notAPreset', '__proto__', 'constructor', 'toString', 'presetShapeDefinitons'])
            expect(presetGeometry(name, undefined, 1000, 1000)).toBeUndefined();
    });

    test('paints each shade of its fill as a geometry of its own, after the plain fill and before the outline', () => {
        const bevel = presetGeometry('bevel', undefined, 1000, 1000);
        expect(bevel?.map(({ filled, stroked, shade }) => ({ filled, stroked, shade }))).toEqual([
            { filled: true, stroked: false, shade: undefined },
            { filled: true, stroked: false, shade: 0.2 },
            { filled: true, stroked: false, shade: -0.2 },
            { filled: true, stroked: false, shade: 0.4 },
            { filled: true, stroked: false, shade: -0.4 },
            { filled: false, stroked: true, shade: undefined },
        ]);
        expect(bevel?.[1].path).toBe('M 0 0 L 1 0 L 0.875 0.125 L 0.125 0.125 Z');
    });

    test("draws chartPlus's lines over its box, though the file lists them first", () => {
        expect(presetGeometry('chartPlus', undefined, 1000, 1000)).toEqual([
            { path: 'M 1 0 L 1 1 L 0 1 L 0 0 Z', closed: true, filled: true, stroked: false },
            { path: 'M 0.5 0 L 0.5 1 M 0 0.5 L 1 0.5', closed: false, filled: false, stroked: true },
        ]);
    });

    test("charges the read's work budget for each guide it evaluates", () => {
        withWorkBudget(10_000, () => {
            presetGeometry('star32', undefined, 1000, 1000);
            expect(affords(10_000 - 100)).toBe(false);
        });
    });
});

describe('every preset', () => {
    const inFile = presetNames();
    // ST_ShapeType's 187: the file's, and upArrow, which it lacks.
    const names = [...new Set(inFile), 'upArrow'];
    const hostile = [
        undefined,
        avLst({ adj: 'val 1e308', adj1: 'val 999999999999', adj2: 'val -999999999999', adj3: 'val 1e400' }),
        avLst({ adj: 'val -100000', adj1: 'val NaN', adj2: 'val Infinity', adj3: '*/ 1 1 0', adj4: 'sqrt -1' }),
        avLst({ adj5: 'val 50000', adj6: 'at2 0 0', adj7: 'tan w cd4', adj8: '?: x y', notOne: 'val 1' }),
    ];
    const boxes = [
        [1000, 1000],
        [4_000_000, 1000],
        [1000, 4_000_000],
    ];

    test('is in the file but upArrow: 187 definitions of 186 presets, upDownArrow twice and alike', () => {
        expect(inFile.length).toBe(187);
        expect(new Set(inFile).size).toBe(186);
        expect(inFile.filter((name) => name === 'upDownArrow').length).toBe(2);
        expect(inFile).not.toContain('upArrow');
        // Alike to the byte, so whichever is read draws the same.
        const copies = fs.readFileSync(PRESETS_FILE, 'utf8').match(/<upDownArrow>[\s\S]*?<\/upDownArrow>/g) ?? [];
        expect(copies).toHaveLength(2);
        expect(copies[0]).toBe(copies[1]);
    });

    test('draws for its default adjust values at any aspect', () => {
        for (const name of names)
            for (const [width, height] of boxes)
                expect(presetGeometry(name, undefined, width, height)?.length, name).toBeGreaterThan(0);
    });

    // A hostile value may leave a sliver that draws nothing (a chord pinned to a 1/60,000° arc), never more than the caps.
    test('draws for hostile adjust values at any aspect finite and within the caps', () => {
        for (const name of names) {
            for (const list of hostile) {
                for (const [width, height] of boxes) {
                    for (const { path } of presetGeometry(name, list, width, height) ?? []) {
                        expect(path.length).toBeLessThanOrEqual(MAX_PATH_BYTES);
                        expect(path.match(/[MLCQZ]/g)?.length ?? 0).toBeLessThanOrEqual(MAX_PATH_COMMANDS);
                        expect(path).toMatch(/^M( -?\d+(\.\d{1,4})?){2}( [MLCQZ]( -?\d+(\.\d{1,4})?)*)*$/);
                        for (const number of path
                            .split(' ')
                            .filter((token) => /\d/.test(token))
                            .map(Number))
                            expect(number >= -2 && number <= 3).toBe(true);
                    }
                }
            }
        }
    });
});

describe('the overrides', () => {
    // downArrow upside down, as LibreOffice's presets (taken from PowerPoint) define upArrow.
    test("draw upArrow, which Ecma's file lacks, as downArrow turned upright", () => {
        expect(presetGeometry('upArrow', undefined, 1000, 1000)).toEqual([
            { path: 'M 0 0.5 L 0.5 0 L 1 0.5 L 0.75 0.5 L 0.75 1 L 0.25 1 L 0.25 0.5 Z', ...FILLED },
        ]);
        expect(presetGeometry('upArrow', avLst({ adj1: 'val 20000', adj2: 'val 25000' }), 1000, 2000)).toEqual([
            { path: 'M 0 0.125 L 0.5 0 L 1 0.125 L 0.6 0.125 L 0.6 1 L 0.4 1 L 0.4 0.125 Z', ...FILLED },
        ]);
    });
});

describe('the native kinds', () => {
    test('are the presets a canvas kind draws as PowerPoint does', () => {
        expect(PRESET_KINDS.get('rect')).toEqual({ type: 'rectangle', corners: 'straight' });
        expect(PRESET_KINDS.get('flowChartProcess')).toEqual({ type: 'rectangle', corners: 'straight' });
        expect(PRESET_KINDS.get('roundRect')).toEqual({ type: 'rectangle', corners: 'curved' });
        expect(PRESET_KINDS.get('ellipse')).toEqual({ type: 'ellipse' });
        expect(PRESET_KINDS.get('flowChartConnector')).toEqual({ type: 'ellipse' });
        expect(PRESET_KINDS.get('diamond')).toEqual({ type: 'diamond', corners: 'straight' });
        expect(PRESET_KINDS.get('flowChartDecision')).toEqual({ type: 'diamond', corners: 'straight' });
    });

    test('leave every other preset to its path', () => {
        for (const name of ['star5', 'triangle', 'pie', 'flowChartAlternateProcess', 'snipRoundRect', 'nope'])
            expect(PRESET_KINDS.get(name)).toBeUndefined();
    });
});
