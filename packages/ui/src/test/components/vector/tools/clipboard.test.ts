import { describe, expect, test } from 'bun:test';
import { CLIPBOARD_SVG_MAX_ELEMENTS, extractClipboardSvgMetadata } from '@workspace/lib/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    readElementsClipboardItem,
    VECTOR_STYLE_DEFAULTS,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { buildSelectionData } from '../../../../components/vector/tools/clipboard';

// A copy carries THREE things: the native `elements` item (whole stored records — a canvas→canvas
// paste restores exactly what was copied), the typed image/text items every other app reads (also the
// cross-mount re-upload manifest), and a self-contained SVG with the items in <metadata>. An
// image-bearing selection references its images BY NAME — `href="eigen-media:<name>"`, never bytes —
// so the sync copy path stays byte-free and the ref resolves against the target's media/ on paste. A
// still-pending upload (no portable path) is left out of the whole payload.

const meta: VectorMeta = { background: 'transparent', gridSize: 20 };

const BASE = { ...DEFAULT_ELEMENT_PROPS, x: 0, y: 0, width: 100, height: 60, angle: 0 };

const rect = (id: string, index: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'rectangle',
    index,
    seed: 1,
});

const image = (id: string, index: string, mediaName: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.image.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'image',
    index,
    y: 100,
    mediaName,
});

const richtext = (id: string, index: string, html = '<p>hello</p>'): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'richtext',
    index,
    y: 200,
    html,
    fontFamily: 'Excalifont',
    fontSize: 20,
    strokeColor: '#111111',
    color: '#e03131',
});

const elbowArrow = (id: string, index: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.arrow.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'arrow',
    index,
    seed: 3,
    points: '[[0,0],[100,80]]',
    elbow: true,
    startBinding: JSON.stringify({ elementId: 'r1', fixedPoint: [0.5, 0.5] }),
});

const mediaPath = {
    id: 'p1',
    parentId: 'm1',
    ownerId: 'o1',
    mountId: 'mt1',
} as DrivePath;

describe('buildSelectionData', () => {
    test('the selection round-trips losslessly through the elements item', () => {
        // Whole stored records ride the wire, so every field of every kind comes back — including the
        // rich-text colour and the arrow's bindings, which the paste remaps across the pasted set.
        const selection = [rect('r1', 'a0'), richtext('t1', 'a1'), elbowArrow('a1', 'a2')];
        const { data } = buildSelectionData(selection, ['r1', 't1', 'a1'], meta, '', () => undefined);
        const read = readElementsClipboardItem(data.items);
        expect(read?.elements).toEqual(selection);
        expect(read?.sourceFrameId).toBe('');
        // Through the svg's <metadata> block too — an SVG that travels alone still restores elements.
        const restored = extractClipboardSvgMetadata(data.svg ?? '')?.items ?? [];
        expect(readElementsClipboardItem(restored)?.elements).toEqual(selection);
    });

    test('the home frame rides along, so a paste knows whether it is landing where it came from', () => {
        const { data } = buildSelectionData([rect('r1', 'a0')], ['r1'], meta, 'frame-1', () => undefined);
        expect(readElementsClipboardItem(data.items)?.sourceFrameId).toBe('frame-1');
    });

    test('a drawn-only selection carries the svg flavour with the items in <metadata>', () => {
        const { data } = buildSelectionData([rect('r1', 'a0')], ['r1'], meta, '', () => undefined);
        expect(data.items).toHaveLength(1);
        expect(data.svg?.startsWith('<svg')).toBe(true);
        expect(extractClipboardSvgMetadata(data.svg ?? '')?.items).toEqual(data.items);
    });

    test('a rich-text box also ships a text item: flattened text and its typography', () => {
        // How a rich host outside the canvas pastes it styled — the canvas itself reads the elements item.
        const { data } = buildSelectionData([richtext('t1', 'a0')], ['t1'], meta, '', () => undefined);
        expect(data.items.some((i) => i.type === 'text')).toBe(true);
        const text = data.items.find((i) => i.type === 'text');
        expect(text?.text).toBe('hello');
        // The FULL modelled set: dropping bold/italic/underline/spacing here is how they stopped
        // surviving a copy into docs.
        expect(text?.typography).toEqual({
            fontFamily: 'Excalifont',
            fontSize: 20,
            textAlign: 'left',
            color: '#e03131',
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            verticalAlign: 'top',
            letterSpacing: 0,
            lineHeight: 1.2,
        });
    });

    test('an image ships the image item beside the elements item, by name and never by bytes', () => {
        const ordered = [rect('r1', 'a0'), image('i1', 'a1', 'photo.png')];
        const { data } = buildSelectionData(ordered, ['r1', 'i1'], meta, '', () => mediaPath);
        // The image item is the cross-mount re-upload manifest the paste keys on by mediaName.
        const item = data.items.find((i) => i.type === 'image');
        expect(item?.mediaName).toBe('photo.png');
        expect(item?.sourcePathId).toBe('p1');
        expect(data.svg).toContain('href="eigen-media:photo.png"');
        expect(data.svg).not.toContain('data:');
        expect(extractClipboardSvgMetadata(data.svg ?? '')?.items).toEqual(data.items);
    });

    test('a still-pending image is omitted from the elements item, the typed items and the svg', () => {
        const pending = image('i1', 'a1', 'pending.png');
        const settled = image('i2', 'a2', 'photo.png');
        // Resolver mirrors the copy path: a settled upload has a portable path, a pending one doesn't.
        const resolve = (name: string): DrivePath | undefined => (name === 'photo.png' ? mediaPath : undefined);
        const { data } = buildSelectionData([pending, settled], ['i1', 'i2'], meta, '', resolve);
        expect(readElementsClipboardItem(data.items)?.elements).toEqual([settled]);
        expect(data.items.filter((i) => i.type === 'image')).toHaveLength(1);
        expect(data.svg).toContain('href="eigen-media:photo.png"');
        expect(data.svg).not.toContain('pending.png');
    });

    test('cut gets back the ids it can actually cut, never the whole selection', () => {
        // The data-loss bug: the copy dropped the unresolvable image, the cut deleted it anyway, and
        // the only copy of it existed nowhere but the undo stack.
        const pending = image('i1', 'a1', 'pending.png');
        const settled = image('i2', 'a2', 'photo.png');
        const resolve = (name: string): DrivePath | undefined => (name === 'photo.png' ? mediaPath : undefined);
        const { serializedIds } = buildSelectionData([pending, settled], ['i1', 'i2'], meta, '', resolve);
        expect(serializedIds).toEqual(['i2']);
    });

    test('pendingImages counts the dropped images, not every id the payload lacks', () => {
        // The cut toast reads this number. A selected id that is no longer in the scene (a peer deleted
        // it) is missing from the payload too, and is nothing to tell the user about.
        const pending = image('i1', 'a1', 'pending.png');
        const resolve = (): DrivePath | undefined => undefined;
        const { data, pendingImages } = buildSelectionData([pending], ['i1', 'gone'], meta, '', resolve);
        expect(pendingImages).toBe(1);
        expect(data.items).toEqual([]);
    });

    test('a text-only selection ships NO svg, so it lands in a document as text and not as a picture', () => {
        // Every foreign host runs its svg rung before the typed items, so an svg here would make a
        // copied text box paste as a flat image with its typography unread.
        const { data } = buildSelectionData([richtext('t1', 'a0')], ['t1'], meta, '', () => undefined);
        expect(data.svg).toBeUndefined();
        expect(data.items.some((i) => i.type === 'text')).toBe(true);
    });

    test('one shape beside the text brings the svg back', () => {
        const { data } = buildSelectionData(
            [rect('r1', 'a0'), richtext('t1', 'a1')],
            ['r1', 't1'],
            meta,
            '',
            () => undefined,
        );
        expect(data.svg?.startsWith('<svg')).toBe(true);
    });

    test('a selection past the element cap ships the typed items alone', () => {
        // The svg is the expensive half of a copy (a 500-shape select-all put ~1.1MB on text/html);
        // the typed items are the lossless half, so they are what survives the cap.
        const many = Array.from({ length: CLIPBOARD_SVG_MAX_ELEMENTS + 1 }, (_, i) => rect(`r${i}`, 'a0'));
        const { data } = buildSelectionData(
            many,
            many.map((el) => el.id),
            meta,
            '',
            () => undefined,
        );
        expect(data.svg).toBeUndefined();
        expect(readElementsClipboardItem(data.items)?.elements).toHaveLength(CLIPBOARD_SVG_MAX_ELEMENTS + 1);
    });

    test('a selection past the byte cap ships the typed items alone', () => {
        const huge = richtext('t1', 'a1', `<p>${'x'.repeat(600_000)}</p>`);
        const { data } = buildSelectionData([rect('r1', 'a0'), huge], ['r1', 't1'], meta, '', () => undefined);
        expect(data.svg).toBeUndefined();
        expect(readElementsClipboardItem(data.items)?.elements).toHaveLength(2);
    });
});
