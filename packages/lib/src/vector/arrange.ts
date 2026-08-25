// Align / distribute / match-size, shared by slides + vector (U7a). Pure geometry over the minimal
// {id, x, y, width, height} shape (angle-agnostic — align uses the axis-aligned box, matching slides'
// behavior), so both hosts feed their own element type in and apply the returned patches.

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
export type ArrangeItem = { id: string; x: number; y: number; width: number; height: number };

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function arrangeBoundingBox(items: ArrangeItem[]): Bounds {
    return {
        minX: Math.min(...items.map((o) => o.x)),
        minY: Math.min(...items.map((o) => o.y)),
        maxX: Math.max(...items.map((o) => o.x + o.width)),
        maxY: Math.max(...items.map((o) => o.y + o.height)),
    };
}

export function computeArrange(items: ArrangeItem[], op: ArrangeOp): ArrangePatch[] {
    if (items.length < 2) return [];
    const { minX, minY, maxX, maxY } = arrangeBoundingBox(items);

    switch (op) {
        case 'align-left':
            return items.map((o) => ({ id: o.id, x: Math.round(minX) }));
        case 'align-h-center': {
            const cx = (minX + maxX) / 2;
            return items.map((o) => ({ id: o.id, x: Math.round(cx - o.width / 2) }));
        }
        case 'align-right':
            return items.map((o) => ({ id: o.id, x: Math.round(maxX - o.width) }));
        case 'align-top':
            return items.map((o) => ({ id: o.id, y: Math.round(minY) }));
        case 'align-v-center': {
            const cy = (minY + maxY) / 2;
            return items.map((o) => ({ id: o.id, y: Math.round(cy - o.height / 2) }));
        }
        case 'align-bottom':
            return items.map((o) => ({ id: o.id, y: Math.round(maxY - o.height) }));
        case 'match-width': {
            const width = Math.max(...items.map((o) => o.width));
            return items.map((o) => ({ id: o.id, width }));
        }
        case 'match-height': {
            const height = Math.max(...items.map((o) => o.height));
            return items.map((o) => ({ id: o.id, height }));
        }
        case 'distribute-h':
            return distribute(items, 'h');
        case 'distribute-v':
            return distribute(items, 'v');
    }
}

// Equalize gaps between adjacent items, keeping the two outermost fixed.
function distribute(items: ArrangeItem[], axis: 'h' | 'v'): ArrangePatch[] {
    if (items.length < 3) return [];
    const pos = (o: ArrangeItem) => (axis === 'h' ? o.x : o.y);
    const size = (o: ArrangeItem) => (axis === 'h' ? o.width : o.height);

    const sorted = [...items].sort((a, b) => pos(a) - pos(b));
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
