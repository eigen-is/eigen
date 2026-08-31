import { describe, expect, test } from 'bun:test';
import { extractClipboardSvgMetadata } from '@workspace/lib/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_ELEMENT_PROPS, type VectorElement, type VectorMeta } from '@workspace/lib/vector';
import { buildSelectionData } from '../../../../components/vector/tools/clipboard';

// The svg flavour policy: every selection ships a self-contained SVG (element JSON in <metadata>). An
// image-bearing selection references its images BY NAME — `href="eigen-media:<name>"`, never bytes —
// so the sync copy path stays byte-free and the ref resolves against the target's media/ on paste. A
// still-pending upload (no portable path) is omitted from BOTH the svg and the typed items.

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

    test('an image-bearing selection carries the svg flavour with an eigen-media href', () => {
        const ordered = [rect('r1', 'a0'), image('i1', 'a1')];
        const data = buildSelectionData(ordered, ['r1', 'i1'], meta, () => mediaPath);
        expect(data.items).toHaveLength(2);
        expect(data.svg?.startsWith('<svg')).toBe(true);
        // The image rides by name, never by bytes — no data: URI, an eigen-media ref instead.
        expect(data.svg).toContain('href="eigen-media:photo.png"');
        expect(data.svg).not.toContain('data:');
        expect(extractClipboardSvgMetadata(data.svg ?? '')?.items).toEqual(data.items);
    });

    test('a still-pending image is omitted from both the svg and the typed items', () => {
        const pending = { ...image('i1', 'a1'), mediaName: 'pending.png' };
        const settled = { ...image('i2', 'a2'), mediaName: 'photo.png' };
        // Resolver mirrors the copy path: a settled upload has a portable path, a pending one doesn't.
        const resolve = (name: string): DrivePath | undefined => (name === 'photo.png' ? mediaPath : undefined);
        const data = buildSelectionData([pending, settled], ['i1', 'i2'], meta, resolve);
        expect(data.items).toHaveLength(1);
        expect(data.svg).toContain('href="eigen-media:photo.png"');
        expect(data.svg).not.toContain('pending.png');
    });

    test('an elbow arrow carries its elbow flag in meta.vector, through the svg round-trip too', () => {
        const arrow: VectorElement = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'a1',
            type: 'arrow',
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            angle: 0,
            seed: 3,
            index: 'a0',
            roundness: 'sharp',
            points: '[[0,0],[100,80]]',
            elbow: true,
            fixedSegments: '',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '',
            endBinding: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        };
        const data = buildSelectionData([arrow], ['a1'], meta, () => undefined);
        const vector = data.items[0]?.meta?.vector as { elbow?: boolean };
        expect(vector.elbow).toBe(true);
        const restored = extractClipboardSvgMetadata(data.svg ?? '')?.items[0]?.meta?.vector as { elbow?: boolean };
        expect(restored.elbow).toBe(true);
    });
});
