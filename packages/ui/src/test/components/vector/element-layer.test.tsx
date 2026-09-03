import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SKETCH_PROPS,
    ELEMENT_KINDS,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
    type VectorRichTextElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { ElementLayer, sameLayerProps } from '../../../components/vector/element-layer';

// The rich-text sanitizer parses with DOMParser and builds through document.createElement, so the
// markup tests below need a DOM at module scope (the lib clipboard tests' recipe).
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.DOMParser = window.DOMParser;
g.document = window.document;
g.Node = window.Node;

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

const richtext = (html: string): VectorRichTextElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
    id: 't1',
    type: 'richtext',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    angle: 0,
    index: 'a0',
    html,
});

describe('sameLayerProps', () => {
    test('identical field values skip the re-render even for a fresh object', () => {
        expect(sameLayerProps({ el: rect() }, { el: rect() })).toBe(true);
    });

    test('a changed stored field re-renders', () => {
        expect(sameLayerProps({ el: rect() }, { el: rect({ x: 5 }) })).toBe(false);
    });

    test('a new resolveMedia identity re-renders', () => {
        const el = rect();
        expect(sameLayerProps({ el, resolveMedia: () => null }, { el, resolveMedia: () => null })).toBe(false);
    });

    test('an in-place editor mounted in the layer always re-renders', () => {
        const el = rect();
        // children is a fresh React node every parent render; the layer hosting an editor must follow it.
        expect(sameLayerProps({ el }, { el, children: 'editor' })).toBe(false);
        expect(sameLayerProps({ el, children: 'a' }, { el, children: 'b' })).toBe(false);
    });

    test('a new scene map re-renders only when the derived route actually changed', () => {
        const el = rect();
        const a = new Map([[el.id, el]]);
        const b = new Map([[el.id, el]]);
        // A plain rectangle derives no route, so a fresh map identity is not a reason to re-render.
        expect(sameLayerProps({ el, byId: a }, { el, byId: b })).toBe(true);
    });
});

describe('the layer box', () => {
    // The box is pinned with CSS transforms, never fractional left/top: the browser pixel-snaps a box
    // origin before painting the element's svg, which is what shifted every element up to half a pixel
    // off the float coordinates the old single-svg renderer drew at.
    const box = { x: 12.5, y: -3.25, width: 40, height: 20 };

    test('an unrotated layer translates to its box origin and leaves left/top at zero', () => {
        const html = renderToStaticMarkup(<ElementLayer el={rect(box)} />);
        expect(html).toContain('left:0;top:0;width:40px;height:20px');
        expect(html).toContain('transform:translate(12.5px, -3.25px)');
    });

    test('a rotated layer composes rotate after translate, pivoting on the default centre origin', () => {
        // transform-origin is the box centre, and translate is origin-independent, so this is the old
        // renderer's `translate(x y) rotate(angle w/2 h/2)` exactly.
        const html = renderToStaticMarkup(<ElementLayer el={rect({ ...box, angle: 30 })} />);
        expect(html).toContain('transform:translate(12.5px, -3.25px) rotate(30deg)');
    });

    test('opacity rides on the layer, and only below full', () => {
        expect(renderToStaticMarkup(<ElementLayer el={rect({ ...box, opacity: 40 })} />)).toContain('opacity:0.4');
        expect(renderToStaticMarkup(<ElementLayer el={rect({ ...box, opacity: 100 })} />)).not.toContain('opacity');
    });
});

describe('rich text is sanitized at the mount seam', () => {
    // `html` reaches the layer verbatim from the Y.Doc — any peer with write access, or a forged
    // clipboard record, can put anything in it. This is the seam every live/preview/present surface
    // renders through, so a script or an onerror handler must not survive it.
    test('script tags and event handlers are stripped, structure and marks kept', () => {
        const html = renderToStaticMarkup(
            <ElementLayer
                el={richtext(
                    '<p>hello <strong>world</strong></p><script>alert(1)</script><img src=x onerror=alert(1)>',
                )}
            />,
        );
        expect(html).not.toContain('script');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('<img');
        expect(html).toContain('<p>hello <strong>world</strong></p>');
    });

    test('a javascript: link is unwrapped to its text', () => {
        const html = renderToStaticMarkup(
            <ElementLayer el={richtext('<p><a href="javascript:alert(1)">click</a></p>')} />,
        );
        expect(html).not.toContain('javascript:');
        expect(html).toContain('click');
    });
});
