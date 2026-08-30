import { describe, expect, test } from 'bun:test';
import { extractClipboardSvgMetadata } from '@workspace/lib/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_ELEMENT_PROPS, type VectorElement, type VectorMeta } from '@workspace/lib/vector';
import { buildSelectionData } from '../../../../components/vector/tools/clipboard';

// The svg flavour policy: a drawn-only selection ships a self-contained SVG (element JSON in
// <metadata>); an image-bearing selection ships NO svg — its bytes can't be inlined on the sync copy
// path, and live hrefs (owner-scoped previews, tab-local blob: pendings) break for other viewers.

const meta: VectorMeta = { background: 'transparent', gridSize: 20 };

const rect = (id: string, index: string): VectorElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    seed: 1,
    index,
    roundness: 'sharp',
});

const image = (id: string, index: string): VectorElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id,
    type: 'image',
    x: 0,
    y: 100,
    width: 80,
    height: 80,
    angle: 0,
    seed: 2,
    index,
    mediaName: 'photo.png',
});

const mediaPath = {
    id: 'p1',
    parentId: 'm1',
    ownerId: 'o1',
    mountId: 'mt1',
} as DrivePath;

describe('buildSelectionData', () => {
    test('a drawn-only selection carries the svg flavour with the items in <metadata>', () => {
        const data = buildSelectionData([rect('r1', 'a0')], ['r1'], meta, () => undefined);
        expect(data.items).toHaveLength(1);
        expect(data.svg?.startsWith('<svg')).toBe(true);
        expect(extractClipboardSvgMetadata(data.svg ?? '')?.items).toEqual(data.items);
    });

    test('an image-bearing selection carries typed items only — no svg flavour', () => {
        const ordered = [rect('r1', 'a0'), image('i1', 'a1')];
        const data = buildSelectionData(ordered, ['r1', 'i1'], meta, () => mediaPath);
        expect(data.items).toHaveLength(2);
        expect(data.svg).toBeUndefined();
    });
});
