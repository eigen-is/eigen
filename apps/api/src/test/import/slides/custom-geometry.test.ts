import { describe, expect, test } from 'bun:test';
import { parseOoxml } from '../../../lib/core/ooxml';
import type { XmlElement } from '../../../lib/core/xml';
import {
    type CustomGeometry,
    customGeometry,
    MAX_GEOMETRY_NODES,
    MAX_PATH_BYTES,
    MAX_PATH_COMMANDS,
} from '../../../lib/import/slides/custom-geometry';
import { MAX_GUIDES } from '../../../lib/import/slides/guides';
import { affords, withWorkBudget } from '../../../lib/import/slides/lookup';
import { NS } from '../../fixtures/pptx';

// A shape's a:custGeom → the path a canvas path element stores, normalized to the shape's box.

const DEGREE = 60_000;

const custGeom = (paths: string, guides = ''): XmlElement => {
    const element = parseOoxml(
        `<a:custGeom ${NS}><a:avLst/><a:gdLst>${guides}</a:gdLst><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`,
    );
    if (!element) throw new Error('not XML');
    return element;
};
const pt = (x: number | string, y: number | string) => `<a:pt x="${x}" y="${y}"/>`;
const moveTo = (x: number | string, y: number | string) => `<a:moveTo>${pt(x, y)}</a:moveTo>`;
const lnTo = (x: number | string, y: number | string) => `<a:lnTo>${pt(x, y)}</a:lnTo>`;
const arcTo = (wR: number, hR: number, stAng: number, swAng: number) =>
    `<a:arcTo wR="${wR}" hR="${hR}" stAng="${stAng * DEGREE}" swAng="${swAng * DEGREE}"/>`;
const CLOSE = '<a:close/>';
const path = (body: string, attributes = 'w="100" h="100"') => `<a:path ${attributes}>${body}</a:path>`;
const SQUARE = moveTo(0, 0) + lnTo(100, 0) + lnTo(100, 100) + lnTo(0, 100) + CLOSE;

// In a 1000 × 1000 EMU shape.
const geometry = (paths: string, guides = '') => customGeometry(custGeom(paths, guides), 1000, 1000);
const only = (paths: string, guides = ''): CustomGeometry | undefined => {
    const found = geometry(paths, guides);
    expect(found?.length).toBe(1);
    return found?.[0];
};
const pathOf = (paths: string, guides = '') => only(paths, guides)?.path;

describe('the commands', () => {
    test('moveTo, lnTo, cubicBezTo, quadBezTo and close are M, L, C, Q and Z in the unit box', () => {
        const body =
            moveTo(0, 0) +
            lnTo(50, 0) +
            `<a:cubicBezTo>${pt(60, 0)}${pt(100, 40)}${pt(100, 50)}</a:cubicBezTo>` +
            `<a:quadBezTo>${pt(100, 100)}${pt(50, 100)}</a:quadBezTo>` +
            CLOSE;
        expect(only(path(body))).toEqual({
            path: 'M 0 0 L 0.5 0 C 0.6 0 1 0.4 1 0.5 Q 1 1 0.5 1 Z',
            closed: true,
            filled: true,
            stroked: true,
        });
    });

    test('numbers keep 4 decimals', () => {
        expect(pathOf(path(moveTo(1, 2) + lnTo(33.33333, 66.666666), 'w="300" h="300"'))).toBe(
            'M 0.0033 0.0067 L 0.1111 0.2222',
        );
    });

    test('a path that draws before any moveTo starts at the origin', () => {
        expect(pathOf(path(lnTo(100, 0) + lnTo(100, 100)))).toBe('M 0 0 L 1 0 L 1 1');
    });

    test('a command drawn after close starts a new subpath at the closed one’s start', () => {
        expect(pathOf(path(moveTo(50, 50) + lnTo(100, 50) + lnTo(100, 100) + CLOSE + lnTo(0, 100) + lnTo(0, 50)))).toBe(
            'M 0.5 0.5 L 1 0.5 L 1 1 Z M 0.5 0.5 L 0 1 L 0 0.5',
        );
    });

    test('a moveTo that draws nothing, and a close with nothing to close, leave nothing', () => {
        expect(pathOf(path(moveTo(0, 0) + moveTo(10, 10) + CLOSE + moveTo(20, 20) + lnTo(100, 100)))).toBe(
            'M 0.2 0.2 L 1 1',
        );
        expect(pathOf(path(SQUARE + CLOSE + CLOSE))).toBe('M 0 0 L 1 0 L 1 1 L 0 1 Z');
        expect(geometry(path(moveTo(0, 0) + CLOSE + moveTo(50, 50)))).toBeUndefined();
    });

    test('a command missing its points, or one the reader does not know, is skipped', () => {
        expect(
            pathOf(
                path(
                    `${moveTo(0, 0)}<a:lnTo/><a:cubicBezTo>${pt(1, 1)}</a:cubicBezTo><a:quadBezTo>${pt(1, 1)}</a:quadBezTo><a:x/>${lnTo(100, 100)}`,
                ),
            ),
        ).toBe('M 0 0 L 1 1');
    });
});

describe('arcTo', () => {
    // A circle of radius 50 about (50, 50): a quarter's control points sit 4/3·tan(22.5°)·50 ≈ 27.61 along the tangents.
    // Unfilled, so drawn the way it runs.
    const quarter = (from: [number, number], stAng: number, swAng: number) =>
        pathOf(path(moveTo(...from) + arcTo(50, 50, stAng, swAng), 'w="100" h="100" fill="none"'));

    test('draws a clockwise quarter from each quadrant', () => {
        expect(quarter([100, 50], 0, 90)).toBe('M 1 0.5 C 1 0.7761 0.7761 1 0.5 1');
        expect(quarter([50, 100], 90, 90)).toBe('M 0.5 1 C 0.2239 1 0 0.7761 0 0.5');
        expect(quarter([0, 50], 180, 90)).toBe('M 0 0.5 C 0 0.2239 0.2239 0 0.5 0');
        expect(quarter([50, 0], 270, 90)).toBe('M 0.5 0 C 0.7761 0 1 0.2239 1 0.5');
    });

    test('draws a negative sweep anticlockwise', () => {
        expect(quarter([100, 50], 0, -90)).toBe('M 1 0.5 C 1 0.2239 0.7761 0 0.5 0');
        expect(quarter([50, 0], 270, -90)).toBe('M 0.5 0 C 0.2239 0 0 0.2239 0 0.5');
        expect(quarter([0, 50], -180, -90)).toBe('M 0 0.5 C 0 0.7761 0.2239 1 0.5 1');
    });

    test('splits a sweep into quarters at most, a full turn returning to its start', () => {
        const half = quarter([100, 50], 0, 180);
        expect(half).toBe('M 1 0.5 C 1 0.7761 0.7761 1 0.5 1 C 0.2239 1 0 0.7761 0 0.5');
        const full = quarter([100, 50], 0, 360);
        expect(full?.match(/C/g)?.length).toBe(4);
        expect(full?.endsWith(' 1 0.5')).toBe(true);
        // A sweep past a full turn retraces it.
        expect(quarter([100, 50], 0, 3600)).toBe(full);
        expect(geometry(path(moveTo(100, 50) + arcTo(50, 50, 0, 0)))).toBeUndefined();
        expect(quarter([100, 50], 720, 90)).toBe(quarter([100, 50], 0, 90));
    });

    test("takes its angles on the ellipse as drawn: an end at 45° lies on the centre's 45° ray", () => {
        // wR 100, hR 50 about (100, 50) in a 200 × 100 space: t = atan(2) on the ellipse, (100 + 44.72, 50 + 44.72).
        const found = pathOf(path(moveTo(200, 50) + arcTo(100, 50, 0, 45), 'w="200" h="100"'));
        expect(found?.split(' ').slice(-2)).toEqual(['0.7236', '0.9472']);
    });

    test('continues from where the arc ended', () => {
        expect(pathOf(path(moveTo(100, 50) + arcTo(50, 50, 0, 90) + lnTo(0, 0)))).toBe(
            'M 1 0.5 C 1 0.7761 0.7761 1 0.5 1 L 0 0',
        );
    });
});

describe('guides', () => {
    test("points name the custGeom's guides and the shape's own, in a path spanning the shape's EMU", () => {
        const guides = '<a:gd name="inset" fmla="*/ w 1 10"/><a:gd name="far" fmla="+- r 0 inset"/>';
        expect(pathOf(path(moveTo('inset', 't') + lnTo('far', 'vc') + lnTo('hc', 'b') + CLOSE, ''), guides)).toBe(
            'M 0.1 0 L 0.9 0.5 L 0.5 1 Z',
        );
    });

    test('an arc takes its radii and angles from guides', () => {
        const guides = '<a:gd name="rad" fmla="val 500"/><a:gd name="sweep" fmla="val 5400000"/>';
        const arc = '<a:arcTo wR="rad" hR="hd2" stAng="0" swAng="sweep"/>';
        expect(pathOf(path(moveTo('r', 'vc') + arc, ''), guides)).toBe('M 1 0.5 C 1 0.7761 0.7761 1 0.5 1');
    });

    test('too many guides leave the shape undrawn', () => {
        const guides = '<a:gd name="g" fmla="val 1"/>'.repeat(MAX_GUIDES + 1);
        expect(geometry(path(SQUARE), guides)).toBeUndefined();
        expect(geometry(path(SQUARE), '<a:gd name="g" fmla="val 1"/>'.repeat(MAX_GUIDES))).toBeDefined();
    });

    test('a cyclic, self-naming or dividing-by-zero guide places its point at 0', () => {
        const guides =
            '<a:gd name="p" fmla="val q"/><a:gd name="q" fmla="val p"/><a:gd name="u" fmla="*/ w 1 0"/><a:gd name="v" fmla="+- v 1000 0"/>';
        expect(pathOf(path(moveTo('p', 'q') + lnTo('u', 'v'), ''), guides)).toBe('M 0 0 L 0 1');
    });
});

describe('coordinate spaces', () => {
    test("each path's w and h span the box, so paths of different spaces line up", () => {
        const found = pathOf(
            path(moveTo(0, 0) + lnTo(10, 20), 'w="10" h="20"') +
                path(moveTo(500, 0) + lnTo(0, 500), 'w="1000" h="500"'),
        );
        expect(found).toBe('M 0 0 L 1 1 M 0.5 0 L 0 1');
    });

    test("a path with no w or h, or 0, spans the shape's EMU extent", () => {
        const geometryIn = (attributes: string) =>
            customGeometry(custGeom(path(moveTo(0, 0) + lnTo(2000, 500), attributes)), 4000, 1000)?.[0].path;
        expect(geometryIn('')).toBe('M 0 0 L 0.5 0.5');
        expect(geometryIn('w="0" h="0"')).toBe('M 0 0 L 0.5 0.5');
    });

    test('a box of no height puts every y at 0', () => {
        expect(customGeometry(custGeom(path(moveTo(0, 0) + lnTo(1000, 50), '')), 1000, 0)?.[0].path).toBe(
            'M 0 0 L 1 0',
        );
    });
});

describe('fill and stroke', () => {
    test("a path's fill and stroke flags say what it paints", () => {
        expect(only(path(SQUARE, 'w="100" h="100" fill="none"'))).toMatchObject({ filled: false, stroked: true });
        expect(only(path(SQUARE, 'w="100" h="100" stroke="0"'))).toMatchObject({ filled: true, stroked: false });
        expect(only(path(SQUARE, 'w="100" h="100" fill="darken" stroke="1" extrusionOk="0"'))).toMatchObject({
            filled: true,
            stroked: true,
        });
        expect(geometry(path(SQUARE, 'w="100" h="100" fill="none" stroke="false"'))).toBeUndefined();
    });

    test("a shading fill is a geometry of its own carrying its shade, toward white or black; an unknown one isn't", () => {
        const shaded = (fill: string) => path(SQUARE, `w="100" h="100" stroke="0" fill="${fill}"`);
        const fills = ['norm', 'darken', 'darkenLess', 'lighten', 'lightenLess', 'darken', 'sparkle'];
        expect(geometry(fills.map(shaded).join(''))?.map(({ shade }) => shade)).toEqual([
            undefined,
            -0.4,
            -0.2,
            0.4,
            0.2,
        ]);
        expect(only(shaded('darken'))).toEqual({
            path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            closed: true,
            filled: true,
            stroked: false,
            shade: -0.4,
        });
    });

    test('paths painting alike concatenate;the others are geometries of their own, in the order they first draw', () => {
        const filled = path(SQUARE, 'w="100" h="100" stroke="0"');
        const outline = path(moveTo(0, 0) + lnTo(100, 100), 'w="100" h="100" fill="none"');
        const shadow = path(moveTo(0, 0) + lnTo(0, 100) + lnTo(100, 100) + CLOSE, 'w="100" h="100" stroke="0"');
        expect(geometry(filled + outline + shadow)).toEqual([
            { path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z M 1 1 L 0 1 L 0 0 Z', closed: true, filled: true, stroked: false },
            { path: 'M 0 0 L 1 1', closed: false, filled: false, stroked: true },
        ]);
    });

    test('a filled path winding the other way is reversed, so paths concatenated fill as their union', () => {
        const backwards =
            moveTo(25, 25) +
            `<a:cubicBezTo>${pt(25, 50)}${pt(25, 60)}${pt(25, 75)}</a:cubicBezTo>` +
            lnTo(75, 75) +
            lnTo(75, 25) +
            CLOSE;
        expect(pathOf(path(SQUARE) + path(backwards))).toBe(
            'M 0 0 L 1 0 L 1 1 L 0 1 Z M 0.75 0.25 L 0.75 0.75 L 0.25 0.75 C 0.25 0.6 0.25 0.5 0.25 0.25 Z',
        );
        expect(pathOf(path(backwards, 'w="100" h="100" fill="none"'))).toBe(
            'M 0.25 0.25 C 0.25 0.5 0.25 0.6 0.25 0.75 L 0.75 0.75 L 0.75 0.25 Z',
        );
    });

    test('a geometry is closed only when every subpath ends in close; an open one still fills', () => {
        expect(only(path(SQUARE + moveTo(0, 0) + lnTo(50, 50)))).toMatchObject({ closed: false, filled: true });
        expect(only(path(SQUARE + moveTo(0, 0) + lnTo(50, 50) + CLOSE))).toMatchObject({ closed: true });
    });

    test('a custGeom with no pathLst, no path, or only empty ones draws nothing', () => {
        const empty = parseOoxml(`<a:custGeom ${NS}><a:avLst/><a:gdLst/></a:custGeom>`);
        expect(empty && customGeometry(empty, 1000, 1000)).toBeUndefined();
        expect(geometry('')).toBeUndefined();
        expect(geometry(path('') + path(moveTo(5, 5)))).toBeUndefined();
    });
});

describe('caps', () => {
    test('a coordinate past the range the canvas keeps is clamped there; NaN and overflow are 0', () => {
        const huge = `1${'0'.repeat(400)}`;
        expect(pathOf(path(moveTo(-1_000_000, 1_000_000_000) + lnTo('NaN', huge) + lnTo('1e308', 'Infinity')))).toBe(
            'M -2 3 L 0 0 L 0 0',
        );
    });

    test('an arc of absurd radii stays finite and in range', () => {
        // 1e240: the next square overflows to 0.
        let guides = '<a:gd name="g0" fmla="*/ 999999999999999 999999999999999 1"/>';
        for (let i = 1; i <= 4; i++) guides += `<a:gd name="g${i}" fmla="*/ g${i - 1} g${i - 1} 1"/>`;
        const arc =
            '<a:arcTo wR="g3" hR="g4" stAng="1" swAng="-5400000"/><a:arcTo wR="g4" hR="g3" stAng="0" swAng="1"/>';
        const numbers = pathOf(path(moveTo(50, 50) + arc), guides)
            ?.split(' ')
            .filter((token) => /\d/.test(token))
            .map(Number);
        expect(numbers?.length).toBeGreaterThan(2);
        expect(numbers?.every((n) => Number.isFinite(n) && n >= -2 && n <= 3)).toBe(true);
    });

    test('an arc starting at an absurd angle starts where that angle, less its whole turns, puts it', () => {
        let guides = '<a:gd name="g0" fmla="*/ 999999999999999 999999999999999 1"/>';
        for (let i = 1; i <= 4; i++) guides += `<a:gd name="g${i}" fmla="*/ g${i - 1} g${i - 1} 1"/>`;
        const arc = '<a:arcTo wR="50" hR="50" stAng="g3" swAng="5400000"/>';
        expect(pathOf(path(moveTo(100, 50) + arc), guides)?.match(/C/g)?.length).toBe(1);
    });

    test('past MAX_GEOMETRY_NODES the shape is undrawn before any of it is read', () => {
        const many = lnTo(1, 1).repeat(MAX_GEOMETRY_NODES);
        expect(geometry(path(moveTo(0, 0) + many))).toBeUndefined();
        expect(geometry(path('').repeat(MAX_GEOMETRY_NODES + 1))).toBeUndefined();
    });

    test('a path past MAX_PATH_COMMANDS drops points on the line between their neighbours and tiny steps', () => {
        let body = moveTo(0, 0);
        for (let i = 1; i <= 1000; i++) body += lnTo(i / 10, i % 2 === 0 ? 0 : 0.01);
        body += lnTo(100, 100) + CLOSE;
        expect(pathOf(path(body))).toBe('M 0 0 L 1 0 L 1 1 Z');
    });

    test('past the cap, the least tolerance that fits is taken', () => {
        // 600 points wobbling by `amplitude` of the box, the last 100 by `tail`.
        const wobbly = (amplitude: number, tail = amplitude) => {
            let body = moveTo(0, 0);
            for (let i = 1; i <= 600; i++) body += lnTo(i / 6, i % 2 === 0 ? 0 : (i > 500 ? tail : amplitude) * 100);
            return pathOf(path(body, 'w="100" h="100" fill="none"'));
        };
        // A wobble of 0.0015 goes at the second, one of 0.003 at the third.
        expect(wobbly(0.0015)).toBe('M 0 0 L 1 0');
        expect(wobbly(0.003)).toBe('M 0 0 L 1 0');
        // The first drops the 0.0005 wobble and fits, so the 0.0015 one stays.
        expect(wobbly(0.0005, 0.0015)?.split('L').length).toBeGreaterThan(90);
    });

    test("past the cap, a closed subpath's last line back to its start goes", () => {
        let body = '';
        for (let i = 0; i < 100; i++)
            body += moveTo(i, 0) + lnTo(i + 0.5, 0) + lnTo(i + 0.5, 50) + lnTo(i, 50) + lnTo(i, 0) + CLOSE;
        const found = pathOf(path(body));
        expect(found?.startsWith('M 0 0 L 0.005 0 L 0.005 0.5 L 0 0.5 Z M 0.01 0 L')).toBe(true);
        expect(found?.split('Z').length).toBe(101);
    });

    test('a flat curve past the cap becomes a line, a curved one stays', () => {
        let body = moveTo(0, 0);
        for (let i = 1; i <= 600; i++) body += `<a:quadBezTo>${pt(i / 6 - 0.05, 0.001)}${pt(i / 6, 0)}</a:quadBezTo>`;
        body += `<a:cubicBezTo>${pt(100, 50)}${pt(50, 100)}${pt(0, 100)}</a:cubicBezTo>`;
        expect(pathOf(path(body))).toBe('M 0 0 L 1 0 C 1 0.5 0.5 1 0 1');
    });

    test('a path that stays past the caps once simplified is undrawn', () => {
        let zigzag = moveTo(0, 0);
        for (let i = 1; i <= MAX_PATH_COMMANDS; i++) zigzag += lnTo(i / 10, i % 2 === 0 ? 0 : 100);
        expect(geometry(path(zigzag, 'w="100" h="100"'))).toBeUndefined();
        const within = moveTo(0, 0) + lnTo(0, 100).repeat(MAX_PATH_COMMANDS - 1);
        expect(only(path(within))?.path.split('L').length).toBe(MAX_PATH_COMMANDS);
    });

    test('a path of fewer commands but past MAX_PATH_BYTES is undrawn', () => {
        const waves = (count: number) => {
            let body = moveTo(0, 0);
            for (let i = 0; i < count; i++) {
                const x = i * 0.24;
                body += `<a:cubicBezTo>${pt(x + 0.0812, 98.7654)}${pt(x + 0.1623, 1.2345)}${pt(x + 0.24, 50.5555)}</a:cubicBezTo>`;
            }
            return geometry(path(body));
        };
        expect(waves(300)?.[0].path.length).toBeLessThan(MAX_PATH_BYTES);
        // 401 commands, under MAX_PATH_COMMANDS: only the bytes refuse it.
        expect(waves(400)).toBeUndefined();
    });

    test("charges the read's work budget for its guides and commands, and is undrawn where the budget can't cover it", () => {
        const geometryOf = custGeom(path(SQUARE), '<a:gd name="g" fmla="val 1"/>');
        withWorkBudget(1000, () => {
            customGeometry(geometryOf, 1000, 1000);
            expect(affords(1000 - 11)).toBe(true);
            expect(affords(1000 - 10)).toBe(false);
        });
        expect(withWorkBudget(3, () => customGeometry(geometryOf, 1000, 1000))).toBeUndefined();
    });
});
