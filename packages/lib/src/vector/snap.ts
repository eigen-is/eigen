import type { Box } from './geometry';

// Guide-line snapping shared by slides + vector (U7a). Pure math over Box in the host's coordinate
// space; the host supplies the threshold in those units (a zoom-aware host divides a screen-px
// threshold by zoom so snapping feels constant at any zoom). The rotated-object rule (Override-24)
// lives here: a rotated box's axis-aligned edges lie about its visual box, so it snaps by CENTRE only
// as a mover (`centerOnly`) and contributes CENTRE only as a target.

// Default screen-space snap radius (px) for zoom-aware hosts: pass SNAP_SCREEN_THRESHOLD / zoom.
export const SNAP_SCREEN_THRESHOLD = 8;

export type SnapLine = { orientation: 'horizontal' | 'vertical'; position: number };
export type SnapTargets = { vSnaps: number[]; hSnaps: number[] };
export type SnapResult = { box: Box; lines: SnapLine[] };

function edgesOf(b: Box) {
    return {
        left: b.x,
        right: b.x + b.width,
        top: b.y,
        bottom: b.y + b.height,
        cx: b.x + b.width / 2,
        cy: b.y + b.height / 2,
    };
}

// Candidate snap coordinates from the other objects (excludeIds skips the ones being dragged) plus any
// host guide lines in `extraV`/`extraH` (slides: canvas edges + centre; vector: none — infinite canvas).
// A rotated target contributes centre only.
export function computeSnapTargets(
    boxes: { id: string; box: Box }[],
    excludeIds: Set<string>,
    extraV: number[] = [],
    extraH: number[] = [],
): SnapTargets {
    const vSnaps = [...extraV];
    const hSnaps = [...extraH];
    for (const { id, box } of boxes) {
        if (excludeIds.has(id)) continue;
        const e = edgesOf(box);
        if (box.angle) {
            vSnaps.push(e.cx);
            hSnaps.push(e.cy);
        } else {
            vSnaps.push(e.left, e.right, e.cx);
            hSnaps.push(e.top, e.bottom, e.cy);
        }
    }
    return { vSnaps, hSnaps };
}

// Snap `box` to the targets. `mode` is 'move' or 'resize-<dir>'. `threshold` is in box units.
// `centerOnly` (move) snaps the box by its centre alone — the rule for a rotated mover, whose edges
// lie but whose centre is rotation-invariant. `lockAxis` (move) is the Shift dominant-axis constraint:
// 'x' keeps x fixed (skip vertical snapping + guides), 'y' keeps y fixed — so a locked axis never
// gets a correction to undo at the call site. Returns the snapped box + the guide lines that matched.
// The post-snap 0.1 line-detection epsilon is a coordinate-exactness check (the snap made the edge
// equal to the target), not a hit radius, so it needs no zoom scaling.
export function snapBoxToTargets(
    box: Box,
    { vSnaps, hSnaps }: SnapTargets,
    mode: string,
    threshold: number,
    centerOnly = false,
    lockAxis?: 'x' | 'y',
): SnapResult {
    const edges = edgesOf(box);
    const lines: SnapLine[] = [];
    let { x, y, width: w, height: h } = box;
    const { angle } = box;

    if (mode === 'move') {
        const vEdges = centerOnly ? [edges.cx] : [edges.left, edges.right, edges.cx];
        const hEdges = centerOnly ? [edges.cy] : [edges.top, edges.bottom, edges.cy];
        let bestDx = Infinity;
        let bestDy = Infinity;
        let snapX = x;
        let snapY = y;

        if (lockAxis !== 'x') {
            for (const vs of vSnaps) {
                for (const edge of vEdges) {
                    const d = Math.abs(edge - vs);
                    if (d < threshold && d < Math.abs(bestDx)) {
                        bestDx = edge - vs;
                        snapX = x - bestDx;
                    }
                }
            }
        }
        if (lockAxis !== 'y') {
            for (const hs of hSnaps) {
                for (const edge of hEdges) {
                    const d = Math.abs(edge - hs);
                    if (d < threshold && d < Math.abs(bestDy)) {
                        bestDy = edge - hs;
                        snapY = y - bestDy;
                    }
                }
            }
        }

        if (bestDx !== Infinity) {
            x = snapX;
            const se = edgesOf({ x, y, width: w, height: h, angle });
            const snapped = centerOnly ? [se.cx] : [se.left, se.right, se.cx];
            for (const vs of vSnaps) {
                for (const edge of snapped) {
                    if (Math.abs(edge - vs) < 0.1) lines.push({ orientation: 'vertical', position: vs });
                }
            }
        }
        if (bestDy !== Infinity) {
            y = snapY;
            const se = edgesOf({ x, y, width: w, height: h, angle });
            const snapped = centerOnly ? [se.cy] : [se.top, se.bottom, se.cy];
            for (const hs of hSnaps) {
                for (const edge of snapped) {
                    if (Math.abs(edge - hs) < 0.1) lines.push({ orientation: 'horizontal', position: hs });
                }
            }
        }
    } else {
        // Strip the 'resize-' prefix first — 'resize' itself contains 'e' and 's'.
        const dir = mode.startsWith('resize-') ? mode.slice('resize-'.length) : mode;
        const isRight = dir.includes('e');
        const isLeft = dir.includes('w');
        const isBottom = dir.includes('s');
        const isTop = dir.includes('n');

        if (isRight) {
            const right = x + w;
            for (const vs of vSnaps) {
                if (Math.abs(right - vs) < threshold) {
                    w = vs - x;
                    lines.push({ orientation: 'vertical', position: vs });
                    break;
                }
            }
        }
        if (isLeft) {
            for (const vs of vSnaps) {
                if (Math.abs(x - vs) < threshold) {
                    w = w + (x - vs);
                    x = vs;
                    lines.push({ orientation: 'vertical', position: vs });
                    break;
                }
            }
        }
        if (isBottom) {
            const bottom = y + h;
            for (const hs of hSnaps) {
                if (Math.abs(bottom - hs) < threshold) {
                    h = hs - y;
                    lines.push({ orientation: 'horizontal', position: hs });
                    break;
                }
            }
        }
        if (isTop) {
            for (const hs of hSnaps) {
                if (Math.abs(y - hs) < threshold) {
                    h = h + (y - hs);
                    y = hs;
                    lines.push({ orientation: 'horizontal', position: hs });
                    break;
                }
            }
        }
    }

    return { box: { x, y, width: w, height: h, angle }, lines };
}
