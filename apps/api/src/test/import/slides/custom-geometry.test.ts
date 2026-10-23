import { describe, expect, test } from 'bun:test';
import { MAX_PATH_BYTES, MAX_PATH_COMMANDS, parsePathCommands } from '@workspace/lib/vector';
import type { XmlElement } from '../../../lib/core/xml';
import {
    type CustomGeometry,
    closedPath,
    customGeometry,
    MAX_GEOMETRY_NODES,
    MAX_SHAPE_PATHS,
} from '../../../lib/import/slides/custom-geometry';
import { MAX_GUIDES } from '../../../lib/import/slides/guides';
import { affords, withWorkBudget } from '../../../lib/import/slides/lookup';
import { presetGeometry } from '../../../lib/import/slides/preset-geometry';
import { parseOoxml } from '../../../lib/ooxml/ooxml';
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

// How much of the read's budget a call leaves unspent.
const leftAfter = (budget: number, read: () => unknown) =>
    withWorkBudget(budget, () => {
        read();
        let [low, high] = [0, budget];
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (affords(middle)) low = middle;
            else high = middle - 1;
        }
        return low;
    });

// The way each subpath winds, by the sign of its control points' polygon's area: 1 clockwise (y down), -1 the other.
const windings = (found: string | undefined) => {
    const subpaths: { x: number; y: number }[][] = [];
    for (const { op, points } of parsePathCommands(found ?? '') ?? []) {
        if (op === 'M') subpaths.push([...points]);
        else subpaths[subpaths.length - 1]?.push(...points);
    }
    return subpaths.map((points) =>
        Math.sign(
            points.reduce((area, p, i) => {
                const q = points[(i + 1) % points.length];
                return area + p.x * q.y - q.x * p.y;
            }, 0),
        ),
    );
};

// A clockwise circle about (50000, 50000) as four cubics, the first from `phase` degrees: a path of w="100000".
const circle = (radius: number, phase: number) => {
    const at = (degrees: number, k = 0) => {
        const r = (degrees * Math.PI) / 180;
        const x = 50_000 + radius * Math.cos(r) - k * radius * Math.sin(r);
        const y = 50_000 + radius * Math.sin(r) + k * radius * Math.cos(r);
        return pt(Math.round(x), Math.round(y));
    };
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    let body = `<a:moveTo>${at(phase)}</a:moveTo>`;
    for (let quarter = 0; quarter < 4; quarter++) {
        const [from, to] = [phase + quarter * 90, phase + (quarter + 1) * 90];
        body += `<a:cubicBezTo>${at(from, k)}${at(to, -k)}${at(to)}</a:cubicBezTo>`;
    }
    return body + CLOSE;
};

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

    test('a negative radius sweeps a full turn at most too, in four curves', () => {
        const radii = [-1, -50, 50];
        const sweeps = [359.9, 360, -360, 3600];
        for (const [wR, hR, swAng] of radii.flatMap((wR) => radii.flatMap((hR) => sweeps.map((sw) => [wR, hR, sw])))) {
            const arc = path(moveTo(50, 20) + arcTo(wR, hR, 45, swAng), 'w="100" h="100" fill="none"');
            expect(geometry(arc)?.[0].path.match(/C/g)?.length ?? 0).toBeLessThanOrEqual(4);
        }
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
            path(moveTo(0, 0) + lnTo(10, 20), 'w="10" h="20" fill="none"') +
                path(moveTo(500, 0) + lnTo(0, 500), 'w="1000" h="500" fill="none"'),
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
            -0.4,
            undefined,
        ]);
        expect(only(shaded('darken'))).toEqual({
            path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            closed: true,
            filled: true,
            stroked: false,
            shade: -0.4,
        });
    });

    test('paths painting alike and apart concatenate; the others are geometries of their own, in the order they first draw', () => {
        const filled = path(
            moveTo(0, 0) + lnTo(40, 0) + lnTo(40, 40) + lnTo(0, 40) + CLOSE,
            'w="100" h="100" stroke="0"',
        );
        const outline = path(moveTo(0, 0) + lnTo(100, 100), 'w="100" h="100" fill="none"');
        const shadow = path(moveTo(60, 60) + lnTo(60, 100) + lnTo(100, 100) + CLOSE, 'w="100" h="100" stroke="0"');
        expect(geometry(filled + outline + shadow)).toEqual([
            {
                path: 'M 0 0 L 0.4 0 L 0.4 0.4 L 0 0.4 Z M 1 1 L 0.6 1 L 0.6 0.6 Z',
                closed: true,
                filled: true,
                stroked: false,
            },
            { path: 'M 0 0 L 1 1', closed: false, filled: false, stroked: true },
        ]);
    });

    test("filled paths painting alike whose boxes overlap stay apart, as the export's a:path fills even-odd", () => {
        const rect = (x0: number, y0: number, x1: number, y1: number) =>
            path(moveTo(x0, y0) + lnTo(x1, y0) + lnTo(x1, y1) + lnTo(x0, y1) + CLOSE);
        // A wall, two bricks on it sharing an edge, and a third brick over the first: each joins the last alike
        // geometry it overlaps nothing of, so the order they draw in holds.
        const wall = rect(0, 0, 100, 100);
        const bricks = rect(10, 10, 30, 30) + rect(30, 10, 50, 30) + rect(20, 20, 40, 40);
        expect(geometry(wall + bricks)?.map((found) => found.path)).toEqual([
            'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            'M 0.1 0.1 L 0.3 0.1 L 0.3 0.3 L 0.1 0.3 Z M 0.3 0.1 L 0.5 0.1 L 0.5 0.3 L 0.3 0.3 Z',
            'M 0.2 0.2 L 0.4 0.2 L 0.4 0.4 L 0.2 0.4 Z',
        ]);
        // Lines fill nothing, so overlapping they concatenate.
        const crossing = path(moveTo(0, 0) + lnTo(100, 100), 'w="100" h="100" fill="none"');
        expect(geometry(crossing + crossing.replace('x="0"', 'x="100"'))).toHaveLength(1);
        // Past MAX_SHAPE_PATHS geometries, alike paths concatenate overlapping or not, and a path painting a new way
        // leaves the shape undrawn.
        const stacked = geometry(wall.repeat(MAX_SHAPE_PATHS + 5));
        expect(stacked).toHaveLength(MAX_SHAPE_PATHS);
        expect(stacked?.at(-1)?.path.split('M')).toHaveLength(7);
        expect(geometry(crossing + wall.repeat(MAX_SHAPE_PATHS + 5))).toHaveLength(MAX_SHAPE_PATHS);
        expect(geometry(wall.repeat(MAX_SHAPE_PATHS) + crossing)).toBeUndefined();
    });

    test('the filled geometries come first, the lines after: LibreOffice and Apache POI stroke over every fill', () => {
        const lines = path(moveTo(50, 0) + lnTo(50, 100), 'w="100" h="100" fill="none"');
        const square = path(SQUARE, 'w="100" h="100" stroke="0"');
        expect(geometry(lines + square)?.map(({ filled, stroked }) => [filled, stroked])).toEqual([
            [true, false],
            [false, true],
        ]);
    });

    test('a filled path winding the other way is reversed, so each outermost contour winds clockwise', () => {
        const backwards =
            moveTo(25, 25) +
            `<a:cubicBezTo>${pt(25, 50)}${pt(25, 60)}${pt(25, 75)}</a:cubicBezTo>` +
            lnTo(75, 75) +
            lnTo(75, 25) +
            CLOSE;
        expect(pathOf(path(backwards))).toBe('M 0.75 0.25 L 0.75 0.75 L 0.25 0.75 C 0.25 0.6 0.25 0.5 0.25 0.25 Z');
        expect(pathOf(path(backwards, 'w="100" h="100" fill="none"'))).toBe(
            'M 0.25 0.25 C 0.25 0.5 0.25 0.6 0.25 0.75 L 0.75 0.75 L 0.75 0.25 Z',
        );
    });

    test('a geometry is closed only when every subpath ends in close; an open one still fills, each subpath closed', () => {
        const open = only(path(SQUARE + moveTo(0, 0) + lnTo(50, 50)));
        expect(open).toMatchObject({ closed: false, filled: true });
        expect(only(path(SQUARE + moveTo(0, 0) + lnTo(50, 50) + CLOSE))).toMatchObject({ closed: true });
        expect(closedPath(open?.path ?? '')).toBe('M 0 0 L 1 0 L 1 1 L 0 1 Z M 0 0 L 0.5 0.5 Z');
        expect(closedPath('M 0 0 L 1 1 M 0.5 0 L 0 0.5 Z')).toBe('M 0 0 L 1 1 Z M 0.5 0 L 0 0.5 Z');
    });

    test("a contour inside another of its path winds the other way, a hole, and one inside that the first's way", () => {
        const square = (from: number, to: number, clockwise = true) =>
            clockwise
                ? moveTo(from, from) + lnTo(to, from) + lnTo(to, to) + lnTo(from, to) + CLOSE
                : moveTo(from, from) + lnTo(from, to) + lnTo(to, to) + lnTo(to, from) + CLOSE;
        expect(pathOf(path(square(0, 100) + square(20, 80) + square(40, 60)))).toBe(
            'M 0 0 L 1 0 L 1 1 L 0 1 Z M 0.2 0.8 L 0.8 0.8 L 0.8 0.2 L 0.2 0.2 Z M 0.4 0.4 L 0.6 0.4 L 0.6 0.6 L 0.4 0.6 Z',
        );
        // Wound the other way round, each comes out the same way: only how deep it lies counts.
        expect(pathOf(path(square(0, 100, false) + square(20, 80, false) + square(40, 60, false)))).toBe(
            'M 1 0 L 1 1 L 0 1 L 0 0 Z M 0.2 0.2 L 0.2 0.8 L 0.8 0.8 L 0.8 0.2 Z M 0.6 0.4 L 0.6 0.6 L 0.4 0.6 L 0.4 0.4 Z',
        );
        // Side by side, both are outermost; a contour sharing its first corner with the one around it is still in it.
        expect(pathOf(path(square(0, 40, false) + square(60, 100)))).toBe(
            'M 0.4 0 L 0.4 0.4 L 0 0.4 L 0 0 Z M 0.6 0.6 L 1 0.6 L 1 1 L 0.6 1 Z',
        );
        expect(pathOf(path(square(0, 100) + moveTo(0, 0) + lnTo(50, 0) + lnTo(50, 50) + CLOSE))).toBe(
            'M 0 0 L 1 0 L 1 1 L 0 1 Z M 0.5 0.5 L 0.5 0 L 0 0 Z',
        );
        // A path that only strokes keeps its contours as drawn; another path's contours are not this one's holes.
        const lines = path(square(0, 100) + square(20, 80), 'w="100" h="100" fill="none"');
        expect(pathOf(lines)).toBe('M 0 0 L 1 0 L 1 1 L 0 1 Z M 0.2 0.2 L 0.8 0.2 L 0.8 0.8 L 0.2 0.8 Z');
        expect(geometry(path(square(0, 100)) + path(square(20, 80)))?.map((found) => found.path)).toEqual([
            'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            'M 0.2 0.2 L 0.8 0.2 L 0.8 0.8 L 0.2 0.8 Z',
        ]);
    });

    test('a thin ring is a hole in its disc: each contour is probed on its curve, against the curves of the others', () => {
        // 4% inside the disc, its first curve's middle at 22.5°, where an octagon of ends and middles lies 7.6% inside.
        const ring = path(circle(50_000, 0) + circle(48_000, -22.5), 'w="100000" h="100000"');
        expect(windings(pathOf(ring))).toEqual([1, -1]);
        // Three circles about one centre: a disc, a hole, a disc.
        const circles = [500, 400, 300].map((r) => moveTo(500 + r, 500) + arcTo(r, r, 0, 360) + CLOSE);
        expect(windings(pathOf(path(circles.join(''), 'w="1000" h="1000"')))).toEqual([1, -1, 1]);
        // A donut whose ring is 10% and 5% of its box.
        for (const adj of [10_000, 5000]) {
            const avLst = parseOoxml(`<a:avLst ${NS}><a:gd name="adj" fmla="val ${adj}"/></a:avLst>`) ?? undefined;
            const [donut] = presetGeometry('donut', avLst, 1000, 1000) ?? [];
            expect(windings(donut?.path)).toEqual([1, -1]);
        }
    });

    test('a filled path of more subpaths than can fit is undrawn before their nesting is worked out', () => {
        const triangles = (count: number) => path((moveTo(0, 0) + lnTo(1, 0) + lnTo(0, 1) + CLOSE).repeat(count));
        expect(geometry(triangles(MAX_PATH_COMMANDS / 4))).toBeDefined();
        const many = MAX_PATH_COMMANDS / 2 + 1;
        withWorkBudget(100_000, () => {
            expect(geometry(triangles(many))).toBeUndefined();
            // Its nodes, never the square of its subpaths.
            expect(affords(100_000 - 10 * many)).toBe(true);
        });
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

    test("charge the read's work budget each curve an arc draws and each point a simplifying pass scans", () => {
        const circles = (count: number) => path(moveTo(100, 50) + arcTo(50, 50, 0, 360).repeat(count));
        const charged = (paths: string) => 100_000 - leftAfter(100_000, () => geometry(paths));
        // 4 curves an arc; 200 arcs' 800 curves are past MAX_PATH_COMMANDS, scanned by each of 3 passes that can't fit them.
        expect(charged(circles(10))).toBeGreaterThanOrEqual(40);
        expect(charged(circles(200))).toBeGreaterThanOrEqual(200 * 4 * 4);
        let zigzag = moveTo(0, 0);
        for (let i = 1; i <= 1000; i++) zigzag += lnTo(i / 10, i % 2 === 0 ? 0 : 0.01);
        // Its 2,000 nodes, a pass over its 1,000 segments, and that pass's scans of the points between the ends it keeps.
        expect(charged(path(zigzag))).toBeGreaterThanOrEqual(4000);
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
        expect(only(path(within, 'w="100" h="100" fill="none"'))?.path.split('L').length).toBe(MAX_PATH_COMMANDS);
        // A filled one keeps room to close each subpath it leaves open.
        expect(only(path(within))?.path).toBe('M 0 0 L 0 1');
        const closing = moveTo(0, 0) + lnTo(0, 100).repeat(MAX_PATH_COMMANDS - 2);
        expect(
            closedPath(only(path(closing))?.path ?? '')
                .split(' ')
                .filter((token) => /[MLZ]/.test(token)),
        ).toHaveLength(MAX_PATH_COMMANDS);
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

    test('a mirrored path is mirrored before the caps measure it, so the path that fits is the one stored', () => {
        // Each x at the range's far end: mirrored, each takes a sign, past MAX_PATH_BYTES unless simplified.
        let body = moveTo(0, 0);
        for (let i = 0; i < 370; i++) body += `<a:cubicBezTo>${pt(2999.9, 123.4).repeat(3)}</a:cubicBezTo>`;
        const drawn = (mirrored: boolean) =>
            customGeometry(custGeom(path(body, 'w="1000" h="1000" fill="none"')), 1000, 1000, mirrored)?.[0].path;
        expect(drawn(false)?.length).toBeGreaterThan(MAX_PATH_BYTES - 2000);
        expect(drawn(false)?.length).toBeLessThanOrEqual(MAX_PATH_BYTES);
        expect(drawn(true)).toBe('M 1 0 L -1.9999 0.1234');
    });

    test("work the read's budget can't cover is never begun: the shape is undrawn and the budget left for the rest", () => {
        // 100 circles about one centre, each of 36 arcs: each one's probe is tested against every circle around it.
        const rings = Array.from({ length: 100 }, (_, i) => {
            const r = 100 + i * 4;
            return moveTo(500 + r, 500) + arcTo(r, r, 0, 10).repeat(36) + CLOSE;
        });
        const nesting = path(rings.join(''), 'w="1000" h="1000"');
        expect(leftAfter(120_000, () => expect(geometry(nesting)).toBeUndefined())).toBeGreaterThan(30_000);
        // 500 curves in one filled subpath, whose chords the budget can't cover.
        let waves = moveTo(0, 50);
        for (let i = 0; i < 500; i++)
            waves += `<a:cubicBezTo>${pt(i / 5, 0)}${pt(i / 5, 100)}${pt((i + 1) / 5, 50)}</a:cubicBezTo>`;
        expect(leftAfter(8000, () => expect(geometry(path(waves))).toBeUndefined())).toBeGreaterThan(5000);
        // 1000 arcs, whose curves the budget can't cover.
        const turns = path(moveTo(100, 50) + arcTo(50, 50, 0, 360).repeat(1000));
        expect(leftAfter(3000, () => expect(geometry(turns)).toBeUndefined())).toBeGreaterThan(1500);
        // A zigzag past MAX_PATH_COMMANDS, whose simplifying pass the budget can't cover.
        let zigzag = moveTo(0, 0);
        for (let i = 1; i <= 1000; i++) zigzag += lnTo(i / 10, i % 2 === 0 ? 0 : 100);
        const unfilled = path(zigzag, 'w="100" h="100" fill="none"');
        expect(leftAfter(5000, () => expect(geometry(unfilled)).toBeUndefined())).toBeGreaterThan(2000);
    });

    test("charges a filled path's box tests against the alike geometry it may join, and lines none", () => {
        const charged = (paths: string) => 100_000 - leftAfter(100_000, () => geometry(paths));
        // Each line's path node, its 2 commands and their 2 points.
        const line = path(moveTo(0, 0) + lnTo(10, 10), 'w="100" h="100" fill="none"');
        expect(charged(line.repeat(250))).toBe(250 * 5);
        // The second triangle's box against the first's, besides each one's 8 nodes and 3-point outline.
        const triangle = path(moveTo(0, 0) + lnTo(10, 0) + lnTo(10, 10) + CLOSE);
        expect(charged(triangle + triangle.replaceAll('"0"', '"20"').replaceAll('"10"', '"30"'))).toBe(2 * (8 + 3) + 1);
    });

    test("charges the read's work budget for its guides, commands and outline, and is undrawn where it can't cover them", () => {
        const geometryOf = custGeom(path(SQUARE), '<a:gd name="g" fmla="val 1"/>');
        withWorkBudget(1000, () => {
            customGeometry(geometryOf, 1000, 1000);
            // 11 nodes, and the 4 points of the outline that finds the square outermost.
            expect(affords(1000 - 15)).toBe(true);
            expect(affords(1000 - 14)).toBe(false);
        });
        expect(withWorkBudget(3, () => customGeometry(geometryOf, 1000, 1000))).toBeUndefined();
    });
});
