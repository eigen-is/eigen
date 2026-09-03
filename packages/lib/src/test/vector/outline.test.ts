import { describe, expect, test } from 'bun:test';
import { solidFill } from '../../vector/fill';
// The shipped sharp implementation, for the radius-0 parity check.
import { outlineIntersections, type Point } from '../../vector/geometry';
import {
    cornerRadius,
    diamondOutline,
    ellipseOutline,
    outlineDistance,
    outlineHits,
    outlinePath,
    polylineOutline,
    rectOutline,
    sharpDiamondOffset,
} from '../../vector/outline';
import { DEFAULT_ELEMENT_PROPS, type VectorRectangleElement, type VectorShapeElement } from '../../vector/types';

// The box every outline routine takes; outline.ts keeps its own copy private.
type OutlineBox = { x: number; y: number; width: number; height: number };

// Spread-only so the ellipse case doesn't trip the excess-property check on `corners`.
const SHAPE_BASE: Omit<VectorRectangleElement, 'id' | 'type'> = {
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    index: 'a0',
    fill: solidFill('transparent'),
    roughness: 1,
    seed: 1,
    corners: 'straight',
};

const shapeEl = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id' | 'type'>): VectorShapeElement => ({
    ...SHAPE_BASE,
    ...over,
});

// The maths the module builds its outlines from, re-derived here as the test's own oracle: the inradius,
// the two inset cores and the sharp rectangle. Independent formulations, so a wrong rewrite of the
// shipped ones fails these.
type Seg = { a: Point; b: Point };
const inradius = (box: OutlineBox, kind: 'rectangle' | 'diamond'): number => {
    if (kind === 'rectangle') return Math.min(box.width, box.height) / 2;
    const a = box.width / 2;
    const b = box.height / 2;
    return (a * b) / Math.hypot(a, b);
};
const rectCoreOf = (box: OutlineBox, radius: number): Point[] => {
    const r = Math.min(radius, inradius(box, 'rectangle'));
    const pts = [
        { x: box.x + r, y: box.y + r },
        { x: box.x + box.width - r, y: box.y + r },
        { x: box.x + box.width - r, y: box.y + box.height - r },
        { x: box.x + r, y: box.y + box.height - r },
    ];
    return pts.filter((p, i) => pts.findIndex((q) => dist(p, q) < 1e-7) === i);
};
const diamondCoreOf = (box: OutlineBox, radius: number): Point[] => {
    const a = box.width / 2;
    const b = box.height / 2;
    const inr = inradius(box, 'diamond');
    const k = inr === 0 ? 0 : 1 - Math.min(radius, inr) / inr;
    const cx = box.x + a;
    const cy = box.y + b;
    const pts = [
        { x: cx, y: cy - b * k },
        { x: cx + a * k, y: cy },
        { x: cx, y: cy + b * k },
        { x: cx - a * k, y: cy },
    ];
    return pts.filter((p, i) => pts.findIndex((q) => dist(p, q) < 1e-7) === i);
};
const sharpRect = (box: OutlineBox, gap: number): Point[] => [
    { x: box.x - gap, y: box.y - gap },
    { x: box.x + box.width + gap, y: box.y - gap },
    { x: box.x + box.width + gap, y: box.y + box.height + gap },
    { x: box.x - gap, y: box.y + box.height + gap },
];
const roundedRectPath = (box: OutlineBox, radius: number): string => outlinePath(rectOutline(box, radius, 0));
const roundedDiamondPath = (box: OutlineBox, radius: number): string => outlinePath(diamondOutline(box, radius, 0));

const ray = (from: Point, dx: number, dy: number, len = 1000): Seg => {
    const m = Math.hypot(dx, dy);
    return { a: from, b: { x: from.x + (dx / m) * len, y: from.y + (dy / m) * len } };
};
const centre = (b: OutlineBox): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const nearest = (hits: Point[], from: Point): Point => {
    expect(hits.length).toBeGreaterThan(0);
    return hits.reduce((best, h) => (dist(h, from) < dist(best, from) ? h : best));
};
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const distToSeg = (p: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const close = (a: Point, b: Point, eps = 1e-6) => {
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    return eps;
};
function pointInPolygon(p: Point, poly: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const hit =
            poly[i].y > p.y !== poly[j].y > p.y &&
            p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x;
        if (hit) inside = !inside;
    }
    return inside;
}

const PILL: OutlineBox = { x: 0, y: 0, width: 200, height: 100 };
const RECT: OutlineBox = { x: 0, y: 0, width: 200, height: 100 };
const DIA: OutlineBox = { x: 0, y: 0, width: 100, height: 60 };

describe('round radius (the inradius, for both shapes)', () => {
    test('rectangle: min(w, h) / 2 — a pill', () => {
        expect(inradius(PILL, 'rectangle')).toBe(50);
        expect(inradius({ x: 0, y: 0, width: 80, height: 80 }, 'rectangle')).toBe(40);
    });

    test('diamond: w·h / (2·√(w² + h²)) — the inscribed circle', () => {
        expect(inradius(DIA, 'diamond')).toBeCloseTo((100 * 60) / (2 * Math.hypot(100, 60)), 9);
        // a square diamond of side s: s / (2√2)
        expect(inradius({ x: 0, y: 0, width: 80, height: 80 }, 'diamond')).toBeCloseTo(80 / (2 * Math.SQRT2), 9);
    });

    test('at the round radius the core degenerates (pill = segment, diamond = point)', () => {
        expect(rectCoreOf(PILL, inradius(PILL, 'rectangle'))).toHaveLength(2);
        expect(diamondCoreOf(DIA, inradius(DIA, 'diamond'))).toHaveLength(1);
    });
});

describe('a ray exits on the arc, not the sharp corner', () => {
    // NOTE: direction (1,1) on a 200x100 pill lands exactly on the flat/arc junction (the ray hits the
    // bottom edge at x = 150, which IS the tangent point) — an aspect-ratio coincidence, not a dock. (3,1)
    // aims into the cap proper.
    test('pill: a diagonal ray from the centre lands on the cap arc, strictly inside the sharp box', () => {
        const seg = ray(centre(PILL), 3, 1);
        const hit = nearest(outlineHits(rectOutline(PILL, 50, 0), seg.a, seg.b), centre(PILL));
        // the right cap's arc centre is (150, 50), radius 50
        expect(dist(hit, { x: 150, y: 50 })).toBeCloseTo(50, 6);
        expect(hit.x).toBeLessThan(200 - 1e-6);
        expect(hit.y).toBeLessThan(100 - 1e-6);
        // and strictly inside the sharp outline the old code would have used
        expect(pointInPolygon(hit, sharpRect(PILL, 0))).toBe(true);
    });

    test('the arc hit is measurably short of the sharp hit (> 10px on a pill)', () => {
        const seg = ray(centre(PILL), 3, 1);
        const roundHit = nearest(outlineHits(rectOutline(PILL, 50, 0), seg.a, seg.b), centre(PILL));
        const sharpHit = nearest(outlineHits(rectOutline(PILL, 0, 0), seg.a, seg.b), centre(PILL));
        expect(dist(centre(PILL), sharpHit) - dist(centre(PILL), roundHit)).toBeGreaterThan(10);
    });
});

describe('axis-aligned rays match the sharp answer exactly', () => {
    for (const gap of [0, 8]) {
        test(`rect r=16, gap ${gap}: right/up/left/down rays hit the flat sides`, () => {
            const c = centre(RECT);
            const expected: [number, number, Point][] = [
                [1, 0, { x: 200 + gap, y: 50 }],
                [-1, 0, { x: -gap, y: 50 }],
                [0, -1, { x: 100, y: -gap }],
                [0, 1, { x: 100, y: 100 + gap }],
            ];
            for (const [dx, dy, want] of expected) {
                const seg = ray(c, dx, dy);
                const rounded = nearest(outlineHits(rectOutline(RECT, 16, gap), seg.a, seg.b), c);
                const sharp = nearest(outlineHits(rectOutline(RECT, 0, gap), seg.a, seg.b), c);
                close(rounded, want);
                close(rounded, sharp);
            }
        });

        test(`pill, gap ${gap}: the vertical rays still hit the flat top/bottom`, () => {
            const c = centre(PILL);
            const up = ray(c, 0, -1);
            const down = ray(c, 0, 1);
            close(nearest(outlineHits(rectOutline(PILL, 50, gap), up.a, up.b), c), { x: 100, y: -gap });
            close(nearest(outlineHits(rectOutline(PILL, 50, gap), down.a, down.b), c), { x: 100, y: 100 + gap });
        });
    }
});

describe('gap inflation: an inflated rounded shape has radius r + gap', () => {
    test('rect: the gap-8 outline sits exactly 8 outside the gap-0 outline along every ray', () => {
        const c = centre(RECT);
        for (let deg = 0; deg < 360; deg += 7) {
            const seg = ray(c, Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));
            const inner = nearest(outlineHits(rectOutline(RECT, 24, 0), seg.a, seg.b), c);
            const outer = nearest(outlineHits(rectOutline(RECT, 24, 8), seg.a, seg.b), c);
            // both docks lie on the same ray; the outward offset along the ray is >= 8 (= 8 on flats,
            // exactly 8 on arcs too, since the arc centre is unchanged and only the radius grows)
            expect(dist(c, outer) - dist(c, inner)).toBeGreaterThan(7.99);
        }
    });

    test('diamond: an arc hit is exactly r + gap from its core vertex', () => {
        const c = centre(DIA);
        const r = 8;
        const core = diamondCoreOf(DIA, r);
        const seg = ray(c, 1, 0);
        const hit = nearest(outlineHits(diamondOutline(DIA, r, 8), seg.a, seg.b), c);
        const nearestVertex = core.reduce((best: Point, v: Point) => (dist(v, hit) < dist(best, hit) ? v : best));
        expect(dist(hit, nearestVertex)).toBeCloseTo(r + 8, 6);
    });
});

describe('a rounded diamond docks inside the sharp diamond outline', () => {
    for (const gap of [0, 8]) {
        test(`gap ${gap}: never further out than sharp, strictly inside near the vertices`, () => {
            const c = centre(DIA);
            const sharpPoly = sharpDiamondOffset(DIA, gap);
            let strictlyInside = 0;
            for (let deg = 5; deg < 360; deg += 10) {
                const seg = ray(c, Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));
                const rounded = nearest(outlineHits(diamondOutline(DIA, 12, gap), seg.a, seg.b), c);
                const sharp = nearest(outlineHits(diamondOutline(DIA, 0, gap), seg.a, seg.b), c);
                expect(dist(c, rounded)).toBeLessThanOrEqual(dist(c, sharp) + 1e-9);
                if (pointInPolygon(rounded, sharpPoly)) strictlyInside++;
            }
            expect(strictlyInside).toBeGreaterThan(15);
        });

        test(`gap ${gap}: the flats COINCIDE with the sharp inflated edges`, () => {
            // A rounded edge is the core edge pushed out by r + gap; the core edge is the diamond edge
            // pulled in by r — so the two offsets cancel and the flat lies on the sharp inflated edge line.
            const c = centre(DIA);
            const edgeNormalDeg = (Math.atan2(50, 30) * 180) / Math.PI; // outward normal of the top-right edge
            const seg = ray(c, Math.cos((edgeNormalDeg * Math.PI) / 180), Math.sin((edgeNormalDeg * Math.PI) / 180));
            close(
                nearest(outlineHits(diamondOutline(DIA, 12, gap), seg.a, seg.b), c),
                nearest(outlineHits(diamondOutline(DIA, 0, gap), seg.a, seg.b), c),
            );
        });

        test(`gap ${gap}: a vertex-directed ray is cut short by the arc`, () => {
            const c = centre(DIA);
            const seg = ray(c, 1, 0); // straight at the right vertex
            const rounded = nearest(outlineHits(diamondOutline(DIA, 12, gap), seg.a, seg.b), c);
            const sharp = nearest(outlineHits(diamondOutline(DIA, 0, gap), seg.a, seg.b), c);
            expect(pointInPolygon(rounded, sharpDiamondOffset(DIA, gap))).toBe(true);
            expect(dist(c, sharp) - dist(c, rounded)).toBeGreaterThan(5);
        });
    }

    test('at the round radius the diamond IS the inscribed circle', () => {
        const c = centre(DIA);
        const r = inradius(DIA, 'diamond');
        for (let deg = 0; deg < 360; deg += 13) {
            const seg = ray(c, Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));
            expect(dist(c, nearest(outlineHits(diamondOutline(DIA, r, 4), seg.a, seg.b), c))).toBeCloseTo(r + 4, 6);
        }
    });
});

describe('4-corner symmetry', () => {
    const SQ: OutlineBox = { x: -50, y: -50, width: 100, height: 100 };
    for (const [name, outline] of [
        ['rectangle', rectOutline],
        ['diamond', diamondOutline],
    ] as const) {
        test(`${name}: the four 45° rays are mirror images`, () => {
            const c = centre(SQ);
            const quads = [
                [1, 1],
                [-1, 1],
                [-1, -1],
                [1, -1],
            ];
            const docks = quads.map(([dx, dy]) => {
                const seg = ray(c, dx, dy);
                return nearest(outlineHits(outline(SQ, 18, 6), seg.a, seg.b), c);
            });
            const r0 = dist(c, docks[0]);
            for (const d of docks) expect(dist(c, d)).toBeCloseTo(r0, 9);
            expect(docks[1].x).toBeCloseTo(-docks[0].x, 9);
            expect(docks[1].y).toBeCloseTo(docks[0].y, 9);
            expect(docks[2].x).toBeCloseTo(-docks[0].x, 9);
            expect(docks[2].y).toBeCloseTo(-docks[0].y, 9);
            expect(docks[3].x).toBeCloseTo(docks[0].x, 9);
            expect(docks[3].y).toBeCloseTo(-docks[0].y, 9);
        });
    }
});

describe('radius 0 equals the SHIPPED sharp answer (real outlineIntersections)', () => {
    for (const type of ['rectangle', 'diamond'] as const) {
        for (const gap of [0, 6, 8]) {
            test(`${type}, gap ${gap}: identical hit sets over 72 rays`, () => {
                const shape = shapeEl({ id: 's', type, x: 5, y: -20, width: 120, height: 70 });
                const box: OutlineBox = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
                const c = centre(box);
                let compared = 0;
                for (let deg = 0; deg < 360; deg += 5) {
                    const seg = ray(c, Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180));
                    const real = outlineIntersections(shape, seg.a, seg.b, gap);
                    const mine =
                        type === 'rectangle'
                            ? outlineHits(rectOutline(box, 0, gap), seg.a, seg.b)
                            : outlineHits(diamondOutline(box, 0, gap), seg.a, seg.b);
                    expect(mine.length).toBe(real.length);
                    for (let i = 0; i < real.length; i++) close(mine[i], real[i]);
                    compared++;
                }
                expect(compared).toBe(72);
            });
        }
    }
});

describe('every returned hit is genuinely on the outline (level-set fuzz)', () => {
    test('no spurious hits from the offset lines or full circles', () => {
        let checked = 0;
        for (const [box, radius] of [
            [RECT, 24],
            [PILL, 50],
            [DIA, 12],
            [{ x: -30, y: 10, width: 40, height: 140 }, 15],
        ] as const) {
            for (let deg = 0; deg < 360; deg += 3) {
                const c = centre(box);
                const from = {
                    x: c.x + Math.cos((deg * Math.PI) / 180) * 400,
                    y: c.y + Math.sin((deg * Math.PI) / 180) * 400,
                };
                const seg = ray(from, c.x - from.x, c.y - from.y);
                for (const [hits, core, rEff] of [
                    [
                        outlineHits(rectOutline(box, radius, 6), seg.a, seg.b),
                        rectCoreOf(box, radius),
                        Math.min(radius, inradius(box, 'rectangle')),
                    ],
                    [
                        outlineHits(diamondOutline(box, radius, 6), seg.a, seg.b),
                        diamondCoreOf(box, radius),
                        Math.min(radius, inradius(box, 'diamond')),
                    ],
                ] as const) {
                    expect(hits.length).toBeGreaterThan(0);
                    for (const h of hits) {
                        let d = Number.POSITIVE_INFINITY;
                        for (let i = 0; i < core.length; i++) {
                            const a = core[i];
                            const b = core[(i + 1) % core.length];
                            const dx = b.x - a.x;
                            const dy = b.y - a.y;
                            const l2 = dx * dx + dy * dy;
                            const t =
                                l2 === 0 ? 0 : Math.max(0, Math.min(1, ((h.x - a.x) * dx + (h.y - a.y) * dy) / l2));
                            d = Math.min(d, Math.hypot(h.x - (a.x + t * dx), h.y - (a.y + t * dy)));
                        }
                        expect(d).toBeCloseTo(rEff + 6, 5);
                        checked++;
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(500);
    });
});

describe('SVG path strings (the shared outline definition)', () => {
    test('rounded rect: four tangent arcs, endpoints on the box edges', () => {
        const d = roundedRectPath({ x: 0, y: 0, width: 200, height: 100 }, 24);
        expect(d.match(/A /g)).toHaveLength(4);
        expect(d.startsWith('M 24 0 L 176 0 A 24 24 0 0 1 200 24')).toBe(true);
        expect(d.endsWith('L 0 24 A 24 24 0 0 1 24 0 Z')).toBe(true);
    });

    test('rounded diamond: four tangent arcs about the core vertices', () => {
        const d = roundedDiamondPath(DIA, 12);
        expect(d.match(/A /g)).toHaveLength(4);
        expect(d.match(/L /g)).toHaveLength(4);
        expect(d.startsWith('M ')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
    });

    test('diamond at the round radius collapses to the inscribed circle (two half arcs)', () => {
        const d = roundedDiamondPath(DIA, inradius(DIA, 'diamond'));
        expect(d.match(/A /g)).toHaveLength(2);
    });

    test('radius 0 paths are the plain polygons', () => {
        expect(roundedRectPath({ x: 0, y: 0, width: 10, height: 20 }, 0)).toBe('M 0 0 L 10 0 L 10 20 L 0 20 Z');
        expect(roundedDiamondPath({ x: 0, y: 0, width: 10, height: 20 }, 0)).toBe('M 5 0 L 10 10 L 5 20 L 0 10 Z');
    });

    test('the diamond flats lie ON the sharp diamond edges, so the offset is outward', () => {
        // A point r from a core vertex satisfies both signs, so the arc-count and tangency checks above
        // pass for an inward offset too. This pins the direction.
        const sharp = sharpDiamondOffset(DIA, 0);
        for (const [, x, y] of roundedDiamondPath(DIA, 12).matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)) {
            const p = { x: Number(x), y: Number(y) };
            let d = Number.POSITIVE_INFINITY;
            for (let i = 0; i < sharp.length; i++)
                d = Math.min(d, distToSeg(p, sharp[i], sharp[(i + 1) % sharp.length]));
            expect(d).toBeCloseTo(0, 3);
        }
    });

    test('the path sampled by roughjs matches the intersection geometry (arc tangency)', () => {
        // every "L" endpoint of the diamond path is exactly r from its core vertex
        const r = 12;
        const core = diamondCoreOf(DIA, r);
        const nums = roundedDiamondPath(DIA, r).match(/-?\d+(\.\d+)?/g) ?? [];
        const pts: Point[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
        let tangent = 0;
        for (const p of pts) {
            if (core.some((v: Point) => Math.abs(dist(p, v) - r) < 1e-2)) tangent++;
        }
        expect(tangent).toBeGreaterThan(4);
    });
});

describe('cornerRadius', () => {
    test('straight is 0; curved is the adaptive radius capped at 32; round is the inradius', () => {
        expect(cornerRadius({ width: 100, height: 60, corners: 'straight' })).toBe(0);
        expect(cornerRadius({ width: 100, height: 60, corners: 'curved' })).toBe(15);
        expect(cornerRadius({ width: 400, height: 400, corners: 'curved' })).toBe(32);
        expect(cornerRadius({ width: 100, height: 60, corners: 'round' })).toBe(30);
        expect(cornerRadius({ width: 100, height: 60, corners: 'round' }, 'diamond')).toBeCloseTo(
            (100 * 60) / (2 * Math.hypot(100, 60)),
            9,
        );
    });

    test('curved never exceeds the inradius on a thin shape', () => {
        const el = { width: 200, height: 6, corners: 'curved' } as const;
        expect(cornerRadius(el)).toBeLessThanOrEqual(3);
        expect(cornerRadius(el, 'diamond')).toBeLessThanOrEqual((200 * 6) / (2 * Math.hypot(200, 6)));
    });

    test('a zero-extent box has no radius', () => {
        expect(cornerRadius({ width: 0, height: 50, corners: 'round' })).toBe(0);
    });
});

describe('ellipse and polyline outlines', () => {
    test('an ellipse inflates on both radii and is hit twice by a centre line', () => {
        const shape = ellipseOutline({ x: 0, y: 0, width: 100, height: 60 }, 5);
        expect(shape).toEqual({ kind: 'ellipse', cx: 50, cy: 30, rx: 55, ry: 35 });
        expect(outlineHits(shape, { x: -100, y: 30 }, { x: 200, y: 30 })).toHaveLength(2);
    });

    test('a polyline outline is its own segments', () => {
        const shape = polylineOutline([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
        expect(outlineHits(shape, { x: 5, y: -5 }, { x: 5, y: 5 })).toEqual([{ x: 5, y: 0 }]);
    });
});

describe('outlinePath', () => {
    test('radius 0 renders the plain polygon', () => {
        expect(outlinePath(rectOutline({ x: 0, y: 0, width: 10, height: 10 }, 0, 0))).toBe(
            'M 0 0 L 10 0 L 10 10 L 0 10 Z',
        );
    });
});

describe('outlineDistance', () => {
    const box: OutlineBox = { x: 0, y: 0, width: 200, height: 100 };

    test('a sharp polygon measures to its nearest edge, inside or out', () => {
        const shape = rectOutline(box, 0, 0);
        expect(outlineDistance(shape, { x: 100, y: -10 })).toBeCloseTo(10, 9);
        expect(outlineDistance(shape, { x: 100, y: 50 })).toBeCloseTo(50, 9);
        expect(outlineDistance(shape, { x: 220, y: 120 })).toBeCloseTo(Math.hypot(20, 20), 9);
    });

    test('a rounded shape measures to the arc, so a deep point keeps getting further from the edge', () => {
        const shape = rectOutline(box, 25, 0);
        // The centre is inside the inset core: the distance is the core distance (25) PLUS the radius.
        expect(outlineDistance(shape, { x: 100, y: 50 })).toBeCloseTo(50, 9);
        expect(outlineDistance(shape, { x: 100, y: -10 })).toBeCloseTo(10, 9);
        // Diagonally past a corner the rounded edge has pulled AWAY, so the same point sits further out.
        const corner = { x: 210, y: 110 };
        expect(outlineDistance(shape, corner)).toBeCloseTo(Math.hypot(35, 35) - 25, 9);
        expect(outlineDistance(shape, corner)).toBeGreaterThan(outlineDistance(rectOutline(box, 0, 0), corner));
    });

    test('an ellipse measures to its curve', () => {
        const shape = ellipseOutline({ x: 0, y: 0, width: 100, height: 100 }, 0);
        expect(outlineDistance(shape, { x: 150, y: 50 })).toBeCloseTo(50, 6);
        expect(outlineDistance(shape, { x: 50, y: 50 })).toBeCloseTo(50, 6);
    });

    test('an open polyline measures to the path itself, and an empty outline reads 0', () => {
        const path = polylineOutline([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
        ]);
        expect(outlineDistance(path, { x: 5, y: 4 })).toBeCloseTo(4, 9);
        expect(outlineDistance(polylineOutline([]), { x: 5, y: 4 })).toBe(0);
    });
});
