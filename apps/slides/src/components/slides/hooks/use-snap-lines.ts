import { useMemo } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';

const SNAP_THRESHOLD = 15;

export type SnapLine = {
    orientation: 'horizontal' | 'vertical';
    position: number;
};

type SnapResult = {
    x: number;
    y: number;
    w: number;
    h: number;
    lines: SnapLine[];
};

type Rect = { x: number; y: number; w: number; h: number };

function getEdges(r: Rect) {
    return {
        left: r.x,
        right: r.x + r.w,
        top: r.y,
        bottom: r.y + r.h,
        cx: r.x + r.w / 2,
        cy: r.y + r.h / 2,
    };
}

export function computeSnapLines(
    objects: SlideObject[],
    excludeIds: Set<string>,
): { vSnaps: number[]; hSnaps: number[] } {
    const vSnaps: number[] = [0, SLIDE_BASE_WIDTH / 2, SLIDE_BASE_WIDTH];
    const hSnaps: number[] = [0, SLIDE_BASE_HEIGHT / 2, SLIDE_BASE_HEIGHT];

    for (const obj of objects) {
        if (excludeIds.has(obj.id)) continue;
        // getEdges works on the app-private w/h Rect scratch type; map the canonical object in.
        const e = getEdges({ x: obj.x, y: obj.y, w: obj.width, h: obj.height });
        vSnaps.push(e.left, e.right, e.cx);
        hSnaps.push(e.top, e.bottom, e.cy);
    }

    return { vSnaps, hSnaps };
}

export function snapRect(rect: Rect, vSnaps: number[], hSnaps: number[], mode: string): SnapResult {
    const edges = getEdges(rect);
    const lines: SnapLine[] = [];
    let { x, y, w, h } = rect;

    if (mode === 'move') {
        let bestDx = Infinity;
        let bestDy = Infinity;
        let snapX = x;
        let snapY = y;

        for (const vs of vSnaps) {
            for (const edge of [edges.left, edges.right, edges.cx]) {
                const d = Math.abs(edge - vs);
                if (d < SNAP_THRESHOLD && d < Math.abs(bestDx)) {
                    bestDx = edge - vs;
                    snapX = x - bestDx;
                }
            }
        }

        for (const hs of hSnaps) {
            for (const edge of [edges.top, edges.bottom, edges.cy]) {
                const d = Math.abs(edge - hs);
                if (d < SNAP_THRESHOLD && d < Math.abs(bestDy)) {
                    bestDy = edge - hs;
                    snapY = y - bestDy;
                }
            }
        }

        if (bestDx !== Infinity) {
            x = snapX;
            const snappedEdges = getEdges({ x, y, w, h });
            for (const vs of vSnaps) {
                for (const edge of [snappedEdges.left, snappedEdges.right, snappedEdges.cx]) {
                    if (Math.abs(edge - vs) < 0.1) {
                        lines.push({ orientation: 'vertical', position: vs });
                    }
                }
            }
        }

        if (bestDy !== Infinity) {
            y = snapY;
            const snappedEdges = getEdges({ x, y, w, h });
            for (const hs of hSnaps) {
                for (const edge of [snappedEdges.top, snappedEdges.bottom, snappedEdges.cy]) {
                    if (Math.abs(edge - hs) < 0.1) {
                        lines.push({ orientation: 'horizontal', position: hs });
                    }
                }
            }
        }
    } else {
        // Strip the 'resize-' prefix first — 'resize' itself contains 'e' and 's', poisoning the
        // substring checks (matches applyResize's guard).
        const dir = mode.startsWith('resize-') ? mode.slice('resize-'.length) : mode;
        const isRight = dir.includes('e');
        const isLeft = dir.includes('w');
        const isBottom = dir.includes('s');
        const isTop = dir.includes('n');

        if (isRight) {
            const right = x + w;
            for (const vs of vSnaps) {
                const d = Math.abs(right - vs);
                if (d < SNAP_THRESHOLD) {
                    w = vs - x;
                    lines.push({ orientation: 'vertical', position: vs });
                    break;
                }
            }
        }
        if (isLeft) {
            for (const vs of vSnaps) {
                const d = Math.abs(x - vs);
                if (d < SNAP_THRESHOLD) {
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
                const d = Math.abs(bottom - hs);
                if (d < SNAP_THRESHOLD) {
                    h = hs - y;
                    lines.push({ orientation: 'horizontal', position: hs });
                    break;
                }
            }
        }
        if (isTop) {
            for (const hs of hSnaps) {
                const d = Math.abs(y - hs);
                if (d < SNAP_THRESHOLD) {
                    h = h + (y - hs);
                    y = hs;
                    lines.push({ orientation: 'horizontal', position: hs });
                    break;
                }
            }
        }
    }

    return { x, y, w, h, lines };
}

export function useSnapTargets(objects: SlideObject[], excludeIds: string[]) {
    return useMemo(() => {
        if (excludeIds.length === 0) return { vSnaps: [] as number[], hSnaps: [] as number[] };
        return computeSnapLines(objects, new Set(excludeIds));
    }, [objects, excludeIds]);
}
