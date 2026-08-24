import { computeSnapTargets, type SnapLine, snapBoxToTargets } from '@workspace/lib/vector';
import { useMemo } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';

// Slides' thin adapter over the shared snap core (U7a). The math lives in @workspace/lib/vector; here
// we keep slides' slide-unit threshold and canvas guide targets (edges + centre) so behavior is
// unchanged. Slides has no zoom, so the threshold is a plain constant.
const SNAP_THRESHOLD = 15;

export type { SnapLine };

type SnapResult = { x: number; y: number; w: number; h: number; lines: SnapLine[] };
type Rect = { x: number; y: number; w: number; h: number };

export function computeSnapLines(
    objects: SlideObject[],
    excludeIds: Set<string>,
): { vSnaps: number[]; hSnaps: number[] } {
    return computeSnapTargets(
        objects.map((o) => ({ id: o.id, box: { x: o.x, y: o.y, width: o.width, height: o.height, angle: o.angle } })),
        excludeIds,
        [0, SLIDE_BASE_WIDTH / 2, SLIDE_BASE_WIDTH],
        [0, SLIDE_BASE_HEIGHT / 2, SLIDE_BASE_HEIGHT],
    );
}

// `centerOnly` snaps the box by its centre alone (a rotated mover) — the host passes `angle !== 0`.
export function snapRect(rect: Rect, vSnaps: number[], hSnaps: number[], mode: string, centerOnly = false): SnapResult {
    const { box, lines } = snapBoxToTargets(
        { x: rect.x, y: rect.y, width: rect.w, height: rect.h, angle: 0 },
        { vSnaps, hSnaps },
        mode,
        SNAP_THRESHOLD,
        centerOnly,
    );
    return { x: box.x, y: box.y, w: box.width, h: box.height, lines };
}

export function useSnapTargets(objects: SlideObject[], excludeIds: string[]) {
    return useMemo(() => {
        if (excludeIds.length === 0) return { vSnaps: [] as number[], hSnaps: [] as number[] };
        return computeSnapLines(objects, new Set(excludeIds));
    }, [objects, excludeIds]);
}
