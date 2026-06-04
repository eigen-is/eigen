import { describe, expect, test } from 'bun:test';
import { applyResize, normalizeAngle, resizeRotatedRect, rotateVec, snapAngle } from './transform-geometry';

// World position of a rect corner under rotation about its center.
// sx/sy in {-1,+1} select the corner (nw = -1,-1; se = +1,+1).
function worldCorner(rect: { x: number; y: number; w: number; h: number }, rotation: number, sx: number, sy: number) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const local = rotateVec((sx * rect.w) / 2, (sy * rect.h) / 2, rotation);
    return { x: cx + local.x, y: cy + local.y };
}

describe('snapAngle', () => {
    test('snaps to the nearest 15 degrees', () => {
        expect(snapAngle(7)).toBe(0);
        expect(snapAngle(8)).toBe(15);
        expect(snapAngle(44)).toBe(45);
        expect(snapAngle(-8)).toBe(-15);
    });
});

describe('normalizeAngle', () => {
    test('wraps into [0, 360)', () => {
        expect(normalizeAngle(0)).toBe(0);
        expect(normalizeAngle(370)).toBe(10);
        expect(normalizeAngle(-90)).toBe(270);
        expect(normalizeAngle(720)).toBe(0);
    });
});

describe('rotateVec', () => {
    test('rotates (1,0) by 90 degrees to (0,1) (CSS y-down convention)', () => {
        const r = rotateVec(1, 0, 90);
        expect(r.x).toBeCloseTo(0, 9);
        expect(r.y).toBeCloseTo(1, 9);
    });
});

describe('resizeRotatedRect', () => {
    const start = { x: 100, y: 100, w: 200, h: 100 };

    test('rotation 0 is identical to applyResize', () => {
        const opts = { fromCenter: false, keepAspect: false };
        const a = applyResize('resize-se', 40, 20, start, opts);
        const b = resizeRotatedRect('resize-se', 40, 20, start, 0, opts);
        expect(b).toEqual(a);
    });

    test('se drag at rotation 0 grows w/h by the delta, top-left fixed', () => {
        const r = resizeRotatedRect('resize-se', 40, 20, start, 0, { fromCenter: false, keepAspect: false });
        expect(r).toEqual({ x: 100, y: 100, w: 240, h: 120 });
    });

    test('fromCenter keeps the center fixed at any rotation', () => {
        const cx = start.x + start.w / 2;
        const cy = start.y + start.h / 2;
        const r = resizeRotatedRect('resize-se', 40, 20, start, 37, { fromCenter: true, keepAspect: false });
        expect(r.x + r.w / 2).toBeCloseTo(cx, 6);
        expect(r.y + r.h / 2).toBeCloseTo(cy, 6);
    });

    test('at 90 degrees the opposite (nw) corner stays fixed in world space', () => {
        const nwBefore = worldCorner(start, 90, -1, -1);
        const r = resizeRotatedRect('resize-se', 30, -25, start, 90, { fromCenter: false, keepAspect: false });
        const nwAfter = worldCorner(r, 90, -1, -1);
        expect(nwAfter.x).toBeCloseTo(nwBefore.x, 6);
        expect(nwAfter.y).toBeCloseTo(nwBefore.y, 6);
    });

    test('keepAspect on a corner preserves the aspect ratio', () => {
        const r = resizeRotatedRect('resize-se', 100, 0, start, 0, { fromCenter: false, keepAspect: true });
        expect(r.w / r.h).toBeCloseTo(start.w / start.h, 6);
    });
});
