import { afterAll, describe, expect, test } from 'bun:test';
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

// The rich-text sanitizer parses with DOMParser and builds through document.createElement, and the
// auto-fit tests mount the layer for real, so this file borrows a whole happy-dom window the way the
// text-overlay test next door does and puts every global back afterwards.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const borrowed: string[] = [];
for (const key of Object.getOwnPropertyNames(window)) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    const value = (window as any)[key];
    if (g[key] === undefined && value !== undefined) {
        g[key] = value;
        borrowed.push(key);
    }
}
for (const key of ['DOMParser', 'Event', 'Node', 'Element', 'HTMLElement']) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    g[key] = (window as any)[key];
    borrowed.push(key);
}
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

// The auto-fit re-measures on its ResizeObserver; happy-dom has none, so the test drives the callback
// itself — that is how a measured body reaches the hook after the offsets are defined on it.
let remeasure: (() => void) | null = null;
class FakeResizeObserver {
    constructor(callback: () => void) {
        remeasure = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
}
g.ResizeObserver = FakeResizeObserver;

afterAll(() => {
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.ResizeObserver = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

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
        expect(html).toContain('transform:translate(12.5px,-3.25px)');
    });

    test('a rotated layer composes rotate after translate, pivoting on the default centre origin', () => {
        // transform-origin is the box centre, and translate is origin-independent, so this is the old
        // renderer's `translate(x y) rotate(angle w/2 h/2)` exactly.
        const html = renderToStaticMarkup(<ElementLayer el={rect({ ...box, angle: 30 })} />);
        expect(html).toContain('transform:translate(12.5px,-3.25px) rotate(30deg)');
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

describe('the rich-text auto-fit', () => {
    // The fit is written by the host, and what it writes it as depends on who caused it: the box the
    // user is typing in grows as part of their keystroke's undo step, so ⌘Z takes the text and the
    // height back together. A fit driven by a peer's edit, a load or a panel change is bookkeeping.
    async function fitFor(editing: boolean): Promise<[string, number, boolean]> {
        const calls: [string, number, boolean][] = [];
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const el = richtext('<p>one</p>');
        await act(async () => {
            root.render(
                <ElementLayer el={el} onFitHeight={(id, height, typing) => calls.push([id, height, typing])}>
                    {editing ? (
                        <div>
                            <p>one</p>
                        </div>
                    ) : undefined}
                </ElementLayer>,
            );
        });
        // happy-dom lays nothing out, so the measured block child carries the offsets a browser would.
        const line = container.querySelector('p');
        if (!line) throw new Error('the layer rendered no measurable body');
        Object.defineProperty(line, 'offsetTop', { value: 0 });
        Object.defineProperty(line, 'offsetHeight', { value: 120 });
        await act(async () => remeasure?.());
        await act(async () => root.unmount());
        container.remove();

        const last = calls.at(-1);
        if (!last) throw new Error('the layer never fitted the box');
        return last;
    }

    test("a box with the in-place editor in it fits as the typing user's own edit", async () => {
        const [id, height, typing] = await fitFor(true);
        expect(id).toBe('t1');
        expect(height).toBeGreaterThan(120);
        expect(typing).toBe(true);
    });

    test('a box nobody is editing fits as bookkeeping', async () => {
        const [, , typing] = await fitFor(false);
        expect(typing).toBe(false);
    });
});
