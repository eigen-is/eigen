import { describe, expect, test } from 'bun:test';
import type { Box } from '../../vector/geometry';
import { computeSnapTargets, snapBoxToTargets } from '../../vector/snap';

const box = (x: number, y: number, width = 10, height = 10, angle = 0): Box => ({ x, y, width, height, angle });

describe('computeSnapTargets', () => {
    test('unrotated targets contribute left/right/centre; rotated contribute centre only', () => {
        const t = computeSnapTargets([{ id: 'plain', box: box(0, 0, 10, 10) }], new Set());
        expect(t.vSnaps).toEqual([0, 10, 5]);
        expect(t.hSnaps).toEqual([0, 10, 5]);

        const r = computeSnapTargets([{ id: 'rot', box: box(0, 0, 10, 10, 45) }], new Set());
        expect(r.vSnaps).toEqual([5]);
        expect(r.hSnaps).toEqual([5]);
    });

    test('excludeIds skips the dragged object; extras seed the canvas guides', () => {
        const t = computeSnapTargets([{ id: 'a', box: box(0, 0) }], new Set(['a']), [0, 960, 1920], [0, 540, 1080]);
        expect(t.vSnaps).toEqual([0, 960, 1920]);
        expect(t.hSnaps).toEqual([0, 540, 1080]);
    });
});

describe('snapBoxToTargets', () => {
    const targets = { vSnaps: [100], hSnaps: [200] };

    test('move: left edge snaps to a vertical target within threshold, emits a guide line', () => {
        // left edge 103 is 3 from target 100 (closest edge — centre 108 and right 113 are out).
        const { box: snapped, lines } = snapBoxToTargets(box(103, 0, 10, 10), targets, 'move', 8);
        expect(snapped.x).toBe(100);
        expect(lines).toContainEqual({ orientation: 'vertical', position: 100 });
    });

    test('move: nothing within threshold leaves the box and emits no lines', () => {
        const { box: snapped, lines } = snapBoxToTargets(box(50, 50, 10, 10), targets, 'move', 8);
        expect(snapped.x).toBe(50);
        expect(snapped.y).toBe(50);
        expect(lines).toEqual([]);
    });

    test('move centerOnly: only the centre snaps (rotated mover)', () => {
        // centre at x=95 is 5 from target 100 (< 8); left edge at 90 is 10 away and must NOT snap.
        const { box: snapped, lines } = snapBoxToTargets(box(90, 0, 10, 10, 30), targets, 'move', 8, true);
        expect(snapped.x).toBe(95); // centre pulled to 100 → x = 95
        expect(lines).toContainEqual({ orientation: 'vertical', position: 100 });
    });

    test('threshold scales: a wider threshold catches a farther edge', () => {
        // left edge 110 is 10 from target 100 (centre 115 / right 120 are farther).
        expect(snapBoxToTargets(box(110, 0, 10, 10), targets, 'move', 8).box.x).toBe(110); // 10 > 8, no snap
        expect(snapBoxToTargets(box(110, 0, 10, 10), targets, 'move', 15).box.x).toBe(100); // 10 < 15
    });

    test('resize-e: right edge snaps to the target, adjusting width only', () => {
        const { box: snapped, lines } = snapBoxToTargets(box(0, 0, 96, 10), targets, 'resize-e', 8);
        expect(snapped.width).toBe(100); // right edge 96 → 100, x unchanged
        expect(snapped.x).toBe(0);
        expect(lines).toContainEqual({ orientation: 'vertical', position: 100 });
    });
});
