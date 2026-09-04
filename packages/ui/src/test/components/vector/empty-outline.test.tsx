import { describe, expect, test } from 'bun:test';
import {
    type Box,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SKETCH_PROPS,
    ELEMENT_KINDS,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
    type VectorRichTextElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyOutlines } from '../../../components/vector/empty-outline';

const boxToStyle = (box: Box) => ({ left: box.x, top: box.y, width: box.width, height: box.height });

const richtext = (over: Partial<VectorRichTextElement> = {}): VectorRichTextElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
    id: 't1',
    type: 'richtext',
    strokeColor: 'transparent',
    x: 10,
    y: 20,
    width: 200,
    height: 40,
    angle: 0,
    index: 'a0',
    html: '',
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
    ...over,
});

describe('EmptyOutlines', () => {
    test('rings an empty text box, at its own screen box', () => {
        const html = renderToStaticMarkup(<EmptyOutlines elements={[richtext()]} boxToStyle={boxToStyle} />);
        expect(html).toContain('eigen-empty-outline');
        expect(html).toContain('left:10px');
        expect(html).toContain('width:200px');
    });

    test('leaves a painted rectangle alone', () => {
        const html = renderToStaticMarkup(<EmptyOutlines elements={[rect()]} boxToStyle={boxToStyle} />);
        expect(html).not.toContain('eigen-empty-outline');
    });

    test('a box with text is painted, so it is not ringed', () => {
        const html = renderToStaticMarkup(
            <EmptyOutlines elements={[richtext({ html: '<p>hello</p>' })]} boxToStyle={boxToStyle} />,
        );
        expect(html).not.toContain('eigen-empty-outline');
    });

    test('the ring follows the element rotation', () => {
        const html = renderToStaticMarkup(
            <EmptyOutlines elements={[richtext({ angle: 30 })]} boxToStyle={boxToStyle} />,
        );
        expect(html).toContain('rotate(30deg)');
    });
});
