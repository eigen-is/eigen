import type { SlideObject } from './types';

export type ArrangeOp =
    | 'align-left'
    | 'align-h-center'
    | 'align-right'
    | 'align-top'
    | 'align-v-center'
    | 'align-bottom'
    | 'distribute-h'
    | 'distribute-v'
    | 'match-width'
    | 'match-height';

export type ArrangePatch = { id: string; x?: number; y?: number; width?: number; height?: number };

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function boundingBox(objects: SlideObject[]): Bounds {
    return {
        minX: Math.min(...objects.map((o) => o.x)),
        minY: Math.min(...objects.map((o) => o.y)),
        maxX: Math.max(...objects.map((o) => o.x + o.width)),
        maxY: Math.max(...objects.map((o) => o.y + o.height)),
    };
}

export function computeArrange(objects: SlideObject[], op: ArrangeOp): ArrangePatch[] {
    if (objects.length < 2) return [];
    const { minX, minY, maxX, maxY } = boundingBox(objects);

    switch (op) {
        case 'align-left':
            return objects.map((o) => ({ id: o.id, x: Math.round(minX) }));
        case 'align-h-center': {
            const cx = (minX + maxX) / 2;
            return objects.map((o) => ({ id: o.id, x: Math.round(cx - o.width / 2) }));
        }
        case 'align-right':
            return objects.map((o) => ({ id: o.id, x: Math.round(maxX - o.width) }));
        case 'align-top':
            return objects.map((o) => ({ id: o.id, y: Math.round(minY) }));
        case 'align-v-center': {
            const cy = (minY + maxY) / 2;
            return objects.map((o) => ({ id: o.id, y: Math.round(cy - o.height / 2) }));
        }
        case 'align-bottom':
            return objects.map((o) => ({ id: o.id, y: Math.round(maxY - o.height) }));
        case 'match-width': {
            const width = Math.max(...objects.map((o) => o.width));
            return objects.map((o) => ({ id: o.id, width }));
        }
        case 'match-height': {
            const height = Math.max(...objects.map((o) => o.height));
            return objects.map((o) => ({ id: o.id, height }));
        }
        case 'distribute-h':
            return distribute(objects, 'h');
        case 'distribute-v':
            return distribute(objects, 'v');
    }
}

// Equalize gaps between adjacent objects, keeping the two outermost fixed.
function distribute(objects: SlideObject[], axis: 'h' | 'v'): ArrangePatch[] {
    if (objects.length < 3) return [];
    const pos = (o: SlideObject) => (axis === 'h' ? o.x : o.y);
    const size = (o: SlideObject) => (axis === 'h' ? o.width : o.height);

    const sorted = [...objects].sort((a, b) => pos(a) - pos(b));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const middle = sorted.slice(1, -1);

    const middleSize = middle.reduce((sum, o) => sum + size(o), 0);
    const span = pos(last) - (pos(first) + size(first));
    const gap = (span - middleSize) / (sorted.length - 1);

    const patches: ArrangePatch[] = [];
    let cursor = pos(first) + size(first) + gap;
    for (const o of middle) {
        const coord = Math.round(cursor);
        patches.push(axis === 'h' ? { id: o.id, x: coord } : { id: o.id, y: coord });
        cursor += size(o) + gap;
    }
    return patches;
}
