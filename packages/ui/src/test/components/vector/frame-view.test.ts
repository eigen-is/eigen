import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SKETCH_PROPS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    solidFill,
    type VectorFrame,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FrameView, sameThumbnail } from '../../../components/vector/frame-view';

const frame = (over: Partial<VectorFrame> = {}): VectorFrame => ({
    id: 'f1',
    index: 'a0',
    name: 'Slide 1',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    background: '',
    ...over,
});

const rect = (over: Partial<VectorShapeElement> = {}): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...DEFAULT_SKETCH_PROPS,
    id: 'r1',
    type: 'rectangle',
    fill: solidFill('#dddddd'),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    seed: 1,
    index: 'a0',
    corners: 'straight',
    frameId: 'f1',
    ...over,
});

describe('FrameView', () => {
    test('the page keeps the frame aspect ratio and paints the frame background', () => {
        const html = renderToStaticMarkup(
            createElement(FrameView, { frame: frame({ background: solidFill('#ff0000') }), elements: [] }),
        );
        expect(html).toContain('aspect-ratio:1920/1080');
        expect(html).toContain('background-color:#ff0000');
    });

    test('the page clips what overhangs it and swallows pointer events unless interactive', () => {
        const props = { frame: frame(), elements: [rect()] };
        expect(renderToStaticMarkup(createElement(FrameView, props))).toContain('pointer-events-none');
        expect(renderToStaticMarkup(createElement(FrameView, { ...props, interactive: true }))).not.toContain(
            'pointer-events-none',
        );
        expect(renderToStaticMarkup(createElement(FrameView, props))).toContain('overflow-hidden');
    });

    test('the scaled page is sized in frame pixels, so its contents are authored at frame scale', () => {
        const html = renderToStaticMarkup(createElement(FrameView, { frame: frame(), elements: [] }));
        expect(html).toContain('width:1920px');
        expect(html).toContain('height:1080px');
    });
});

describe('sameThumbnail', () => {
    const base = { frame: frame(), elements: [rect()], index: 0, active: false, onClick: () => undefined };

    test('the same slice and the same frame skip the re-render', () => {
        expect(sameThumbnail(base, { ...base, elements: [...base.elements] })).toBe(true);
    });

    test('a re-materialised element in this frame re-renders', () => {
        expect(sameThumbnail(base, { ...base, elements: [rect()] })).toBe(false);
    });

    test('an added or removed element re-renders', () => {
        expect(sameThumbnail(base, { ...base, elements: [] })).toBe(false);
    });

    test('the rail state re-renders: position, activation, a search hit', () => {
        expect(sameThumbnail(base, { ...base, index: 1 })).toBe(false);
        expect(sameThumbnail(base, { ...base, active: true })).toBe(false);
        expect(sameThumbnail(base, { ...base, matched: true })).toBe(false);
    });

    test('a repainted frame background re-renders', () => {
        expect(sameThumbnail(base, { ...base, frame: frame({ background: solidFill('#123456') }) })).toBe(false);
    });

    test('a fresh click handler re-renders, so the row cannot activate a stale slide', () => {
        expect(sameThumbnail(base, { ...base, onClick: () => undefined })).toBe(false);
    });
});
