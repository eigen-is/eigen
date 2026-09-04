import { describe, expect, test } from 'bun:test';
import { distanceToElement, elbowBindPoint, redockBindingsForElbow } from '../../vector/elbow-heading';
import { elbowRoute } from '../../vector/elbow-route';
import { solidFill } from '../../vector/fill';
import {
    bindingAnchor,
    boundEndpoint,
    elbowAnchorScene,
    followBindings,
    linearLocalToScene,
    normalizeFixedPoint,
    type Point,
    parsePoints,
} from '../../vector/geometry';
import {
    type Corners,
    DEFAULT_ELEMENT_PROPS,
    parseBinding,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorRectangleElement,
    type VectorShapeElement,
} from '../../vector/types';

// Spread-only so the ellipse case doesn't trip the excess-property check on `corners`.
const SHAPE_BASE: Omit<VectorRectangleElement, 'id' | 'type'> = {
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    index: 'a0',
    fill: solidFill('transparent'),
    roughness: 1,
    seed: 1,
    corners: 'straight',
    strokeWidth: 2,
};

const shapeEl = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id' | 'type'>): VectorShapeElement => ({
    ...SHAPE_BASE,
    ...over,
});

// An elbow arrow whose two SCENE endpoints are `start` and `end` (box pinned at origin, angle 0 — every
// elbow arrow does, so a local point equals its scene point). `endBinding` binds the end to a shape.
const elbowArrow = (start: Point, end: Point, endBinding: string): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'ar',
    type: 'arrow',
    roughness: 1,
    x: 0,
    y: 0,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    elbow: true,
    fixedSegments: '',
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding,
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    labelWidth: 0,
    points: JSON.stringify([
        [start.x, start.y],
        [end.x, end.y],
    ]),
});

// Reinder's exact scenario: a 200×100 rect, an elbow arrow whose free start sits far to the RIGHT and whose
// end is dragged to the FAR (left) side. The commit must keep the end on the left and never chord-flip it to
// the near (right) side when the other end moves.
describe('elbowBindPoint — far-side dock', () => {
    const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeWidth: 2 });

    test('a cursor past the left edge docks on the left outline+gap, storing a far-side fixedPoint', () => {
        const { dock, fixedPoint } = elbowBindPoint(rect, { x: -10, y: 50 });
        // Left outline + gap(6): dock at x = -6, snapped toward the left side-midpoint (y ≈ centre).
        expect(dock.x).toBeCloseTo(-6);
        expect(dock.y).toBeCloseTo(49.9); // centre carries Excalidraw's -0.1 tie-break nudge
        // fixedPoint is the dock's ratio — a little OUTSIDE [0,1] on x, which is exactly what elbows must store.
        expect(fixedPoint[0]).toBeCloseTo(-0.03);
        expect(fixedPoint[0]).toBeLessThan(0);
        expect(fixedPoint[1]).toBeCloseTo(0.499);
    });

    test('the stored endpoint stays on the far side and never enters a chord with the other end', () => {
        const { dock, fixedPoint } = elbowBindPoint(rect, { x: -10, y: 50 });
        const endBinding = serializeBinding({ elementId: rect.id, fixedPoint });

        // boundEndpoint('end') is the dock regardless of where the free start sits — the other end is not read.
        const startRight = boundEndpoint(elbowArrow({ x: 400, y: 50 }, dock, endBinding), 'end', rect);
        const startLeft = boundEndpoint(elbowArrow({ x: -400, y: 50 }, dock, endBinding), 'end', rect);
        expect(startRight).toEqual(startLeft); // no chord → identical, other end never enters
        expect(startRight).toEqual(elbowAnchorScene(rect, fixedPoint));
        expect(startRight.x).toBeCloseTo(-6); // stays on the LEFT (far) side, not orbited to +206

        // followBindings (the write path bindArrow/shape-move share) also keeps the end on the far side.
        const arrow = elbowArrow({ x: 400, y: 50 }, dock, endBinding);
        const geom = followBindings(arrow, new Map<string, VectorElement>([[rect.id, rect]]));
        const moved: VectorArrowElement = geom ? { ...arrow, ...geom } : arrow;
        const endScene = linearLocalToScene(moved, parsePoints(moved.points).at(-1) ?? { x: 0, y: 0 });
        expect(endScene.x).toBeCloseTo(-6);
        expect(endScene.y).toBeCloseTo(49.9);
    });
});

// snapToMid's band is clamp(tolerance·size, 5, 80) with tolerance 0.05 — a 5%-of-size window floored at 5px
// and capped at 80px. Within the band an endpoint locks to the side midpoint; beyond it, it docks where it is.
describe('elbowBindPoint — snapToMid band = clamp(5%·size, 5, 80)', () => {
    test('the 5px FLOOR: on a short 200×100 rect the vertical band is 5px', () => {
        const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeWidth: 2 });
        // centre.y = 49.9; a cursor 3.1px off it (< 5) snaps to the mid...
        expect(elbowBindPoint(rect, { x: -10, y: 53 }).dock.y).toBeCloseTo(49.9);
        // ...one 7.1px off it (> 5) docks at its own height on the left edge.
        expect(elbowBindPoint(rect, { x: -10, y: 57 }).dock.y).toBeCloseTo(57);
    });

    test('the 80px CAP: on a tall 200×2000 rect the band tops out at 80px, not 5%·2000 = 100px', () => {
        const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 2000, strokeWidth: 2 });
        // centre.y = 999.9; 70px off it (< 80) snaps to the mid...
        expect(elbowBindPoint(rect, { x: -10, y: 929.9 }).dock.y).toBeCloseTo(999.9);
        // ...90px off it (> 80) docks at its own height (the cap held, so it did NOT snap).
        expect(elbowBindPoint(rect, { x: -10, y: 1089.9 }).dock.y).toBeCloseTo(1089.9);
    });
});

// avoidRectangularCorner slides a corner-region cursor onto an adjacent edge before docking, so an elbow end
// dropped past a rectangle corner attaches to a flat side rather than the ambiguous sharp corner.
describe('elbowBindPoint — rectangular corner avoidance', () => {
    const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeWidth: 2 });

    test('a top-left corner cursor docks on a flat inflated side, not the diagonal corner', () => {
        const { dock } = elbowBindPoint(rect, { x: -12, y: -12 });
        // On one of the two inflated sides that meet at the corner: left edge x = -6, or top edge y = -6.
        const onLeft = Math.abs(dock.x - -6) < 1e-6;
        const onTop = Math.abs(dock.y - -6) < 1e-6;
        expect(onLeft || onTop).toBe(true);
        // Not flung far past the corner on both axes at once.
        expect(dock.x).toBeGreaterThanOrEqual(-6);
        expect(dock.y).toBeGreaterThanOrEqual(-6);
    });
});

// elbowRoute takes an optional pre-dock origPoint per end for the heading DISTANCE-gate. At rest it
// defaults to the stored endpoint; a pre-dock point far from the shape switches the gate to the far branch.
describe('elbowRoute — pre-dock origPoint seam', () => {
    test('a far origPoint flips the heading gate off the cone, changing the route', () => {
        // A WIDE rect: its heading cone widens UP/DOWN, so a point just above the top edge but off to the left
        // resolves to UP by the cone, yet to LEFT by the raw centre→point vector the far-distance branch uses —
        // the two branches disagree, so which one the gate picks is observable in the route.
        const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 40, strokeWidth: 2 });
        const start = { x: 10, y: -6 };
        const arrow: VectorArrowElement = {
            ...elbowArrow(start, { x: 300, y: 300 }, ''),
            startBinding: serializeBinding({ elementId: rect.id, fixedPoint: [0.05, -0.15] }),
        };
        const byId = new Map<string, VectorElement>([[rect.id, rect]]);

        const atRest = elbowRoute(arrow, byId); // origStart defaults to the (near) stored start → cone gate → UP
        const preDock = elbowRoute(arrow, byId, { start: { x: 10, y: -500 } }); // far → distance gate opens → LEFT

        // The seam is threaded: a far pre-dock point is accepted and steers the heading, so the routes differ.
        expect(preDock).not.toEqual(atRest);
        // Distance exactly 0 (an endpoint sitting ON the outline) is as NEAR as it gets, so it takes the
        // cone branch like the resting point — not the far branch a falsy test would send it down.
        expect(elbowRoute(arrow, byId, { start: { x: 10, y: 0 } })).toEqual(atRest);
        // Sanity: both still begin exactly on the stored start (unchanged).
        expect(atRest[0]).toEqual(start);
        expect(preDock[0]).toEqual(start);
    });
});

// The commit→resolve round-trip pinned end-to-end: the elbow bind path
// (bindingFor → elbowBindPoint) must store the DOCKED fixedPoint (the outline+gap ratio), and boundEndpoint's
// elbow branch must resolve that stored ratio back to the very same outline point. The two halves are a pair —
// if a commit stored the raw cursor ratio instead of the dock, or the read stopped honouring the fixedPoint,
// the endpoint would float at the cursor instead of sitting on the outline. Nothing pinned that pairing before.
describe('elbow bind → resolve round-trip (commit pin)', () => {
    const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 });
    // A cursor well OUTSIDE the left edge, off the vertical centre so no 0.5 dodge blurs the round-trip.
    const cursor = { x: -50, y: 70 };

    test('the stored fixedPoint is the dock, and boundEndpoint resolves it back to that same outline point', () => {
        const { dock, fixedPoint } = elbowBindPoint(rect, cursor);
        // What the commit stores. A start-bound elbow arrow with a free far end.
        const arrow: VectorArrowElement = {
            ...elbowArrow(dock, { x: 400, y: 70 }, ''),
            startBinding: serializeBinding({ elementId: rect.id, fixedPoint }),
        };

        // Read half: boundEndpoint returns the docked outline point, exactly — the write+read round-trip closes.
        const resolved = boundEndpoint(arrow, 'start', rect);
        expect(resolved.x).toBeCloseTo(dock.x);
        expect(resolved.y).toBeCloseTo(dock.y);
        // The dock sits on the left outline + gap(6), NOT out at the -50 cursor.
        expect(dock.x).toBeCloseTo(-6);
        expect(resolved.x).toBeCloseTo(-6);

        // Why the DOCK (not the raw cursor ratio) is load-bearing: had the commit stored the straight-anchor
        // ratio of the raw cursor, the elbow read would float the endpoint back at the cursor, off the outline.
        const rawStore = normalizeFixedPoint(bindingAnchor(rect, cursor));
        expect(elbowAnchorScene(rect, rawStore).x).toBeCloseTo(cursor.x); // -50 — at the cursor, off the shape
        expect(elbowAnchorScene(rect, rawStore).x).not.toBeCloseTo(dock.x); // ≠ the -6 outline dock
    });
});

// The panel's to-elbow switch must re-dock a bound end whose fixedPoint was stored for the STRAIGHT
// read (bindingAnchor's raw ratio). The elbow read (elbowAnchorScene) maps that ratio straight onto the box, so
// without re-docking the endpoint floats INSIDE the shape (the create-then-toggle drift). redockBindingsForElbow
// converts each bound end's fixedPoint to the outline dock via elbowBindPoint; followBindings then re-glues.
describe('redockBindingsForElbow — to-elbow re-docks a raw-cursor bound end', () => {
    const rect = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 });
    // A cursor INSIDE the rect, near its left side.
    const inside = { x: 20, y: 50 };

    test('the raw inside ratio becomes the outline dock; boundEndpoint then rests on the outline+gap', () => {
        const rawFixed = normalizeFixedPoint(bindingAnchor(rect, inside));
        const arrow = elbowArrow(
            { x: -80, y: 50 },
            inside,
            serializeBinding({ elementId: rect.id, fixedPoint: rawFixed }),
        );
        const byId = new Map<string, VectorElement>([[rect.id, rect]]);

        // Before: the elbow read of the stored raw ratio floats the endpoint back inside, at the cursor.
        expect(elbowAnchorScene(rect, rawFixed).x).toBeCloseTo(inside.x);

        const { endBinding } = redockBindingsForElbow(arrow, byId);
        expect(parseBinding(endBinding)).not.toBeNull();
        // After: boundEndpoint rests on the left outline + gap(6), off the (20,50) inside point.
        const rest = boundEndpoint({ ...arrow, endBinding }, 'end', rect);
        expect(rest.x).toBeCloseTo(-6);
        expect(rest.x).not.toBeCloseTo(inside.x);
    });

    test('an unbound end is left untouched', () => {
        const arrow = elbowArrow({ x: -80, y: 50 }, inside, '');
        const { startBinding, endBinding } = redockBindingsForElbow(arrow, new Map([[rect.id, rect]]));
        expect(startBinding).toBe('');
        expect(endBinding).toBe('');
    });
});

describe('distanceToElement', () => {
    // The base fixture is a 100×100 square: `round` makes its outline the inscribed circle (r 50).
    const square = (corners: Corners) => shapeEl({ id: 's', type: 'rectangle', corners });

    test('measures against the rounded edge, not the sharp corner', () => {
        const diagonal = { x: 140, y: 140 };
        expect(distanceToElement(square('round'), diagonal)).toBeGreaterThan(
            distanceToElement(square('straight'), diagonal),
        );
        expect(distanceToElement(square('round'), { x: 150, y: 50 })).toBeCloseTo(50, 6);
    });

    test('a straight rectangle keeps the sharp-edge answers', () => {
        expect(distanceToElement(square('straight'), { x: 150, y: 50 })).toBeCloseTo(50, 6);
        expect(distanceToElement(square('straight'), { x: 140, y: 140 })).toBeCloseTo(Math.hypot(40, 40), 6);
    });

    // The centre sits INSIDE a curved rect's inset core, where the outline distance is the core distance
    // PLUS the radius — a core distance clamped at 0 would answer the radius (25) instead.
    test('a point inside the shape measures out to the edge', () => {
        expect(distanceToElement(square('straight'), { x: 50, y: 50 })).toBeCloseTo(50, 6);
        expect(distanceToElement(square('curved'), { x: 50, y: 50 })).toBeCloseTo(50, 6);
        expect(distanceToElement(square('round'), { x: 50, y: 50 })).toBeCloseTo(50, 6);
    });
});
