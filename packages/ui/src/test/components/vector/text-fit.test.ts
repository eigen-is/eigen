import { afterAll, describe, expect, test } from 'bun:test';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    richTextFitHeight,
    VECTOR_STYLE_DEFAULTS,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { Window } from 'happy-dom';
import { type FitHeight, textBodyHeight, useRichTextAutoFit } from '../../../components/vector/text-fit';

// A DOM at module scope, the element-layer suite's recipe — the measure reads layout properties off
// real nodes, and `instanceof HTMLElement` needs the constructor to be the global one.
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = window.document;
g.HTMLElement = window.HTMLElement;
g.window = window;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

// The hook re-measures on its ResizeObserver; happy-dom has none, so the test fires the callback once
// the offsets a browser would have laid out are on the node.
let remeasure: (() => void) | null = null;
class FakeResizeObserver {
    constructor(callback: () => void) {
        remeasure = callback;
    }
    observe() {}
    disconnect() {}
}
g.ResizeObserver = FakeResizeObserver;

afterAll(() => {
    g.document = undefined;
    g.HTMLElement = undefined;
    g.window = undefined;
    g.navigator = undefined;
    g.ResizeObserver = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');

// happy-dom lays nothing out, so each block child carries the offsets a browser would have measured.
function body(lines: { top: number; height: number }[]): HTMLElement {
    const div = document.createElement('div');
    for (const line of lines) {
        const p = document.createElement('p');
        Object.defineProperty(p, 'offsetTop', { value: line.top });
        Object.defineProperty(p, 'offsetHeight', { value: line.height });
        div.append(p);
    }
    return div;
}

const box = (over: Partial<VectorRichTextElement> = {}): VectorRichTextElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
    id: 't1',
    type: 'richtext',
    strokeColor: 'transparent',
    x: 0,
    y: 0,
    width: 200,
    height: 40,
    angle: 0,
    index: 'a0',
    html: '<p>one</p>',
    ...over,
});

describe('textBodyHeight', () => {
    test('spans the first block child to the bottom of the last', () => {
        expect(textBodyHeight(body([{ top: 0, height: 24 }]))).toBe(24);
        expect(
            textBodyHeight(
                body([
                    { top: 0, height: 24 },
                    { top: 24, height: 24 },
                    { top: 48, height: 24 },
                ]),
            ),
        ).toBe(72);
    });

    test('counts the inset the first child is pushed down by only once', () => {
        // The body's own padding offsets every child; it is chrome, added by richTextFitHeight.
        expect(
            textBodyHeight(
                body([
                    { top: 20, height: 24 },
                    { top: 44, height: 24 },
                ]),
            ),
        ).toBe(48);
    });

    test('a body with no block child is not measurable', () => {
        expect(textBodyHeight(body([]))).toBeNull();
    });
});

describe('the fit a measured body drives', () => {
    test('growing text writes the taller box', () => {
        const measured = textBodyHeight(
            body([
                { top: 0, height: 24 },
                { top: 24, height: 24 },
                { top: 48, height: 24 },
            ]),
        );
        expect(measured).not.toBeNull();
        expect(measured === null ? null : richTextFitHeight(box({ height: 40 }), measured)).toBe(72);
    });

    test('deleting lines leaves the box as tall as the user has it', () => {
        const measured = textBodyHeight(body([{ top: 0, height: 24 }]));
        expect(measured === null ? null : richTextFitHeight(box({ height: 72 }), measured)).toBeNull();
    });

    test('an unchanged body writes nothing', () => {
        const measured = textBodyHeight(body([{ top: 0, height: 24 }]));
        expect(measured === null ? null : richTextFitHeight(box({ height: 24 }), measured)).toBeNull();
    });
});

// Only a layout effect picks the node the hook measures, so this mounts it for real. `backdrop` renders
// the <svg> a painted box draws behind its text, which is the sibling the body must not be confused with.
function Harness({ backdrop, onFit }: { backdrop: boolean; onFit: FitHeight }) {
    const host = useRef<HTMLDivElement>(null);
    useRichTextAutoFit(host, box(), onFit, false);
    return createElement(
        'div',
        { ref: host },
        backdrop ? createElement('svg') : null,
        createElement('div', null, createElement('p')),
    );
}

function fittedHeight(backdrop: boolean): number | undefined {
    const heights: number[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Harness, { backdrop, onFit: (_id, height) => heights.push(height) })));
    const line = container.querySelector('p');
    if (!line) throw new Error('the harness rendered no measurable body');
    Object.defineProperty(line, 'offsetTop', { value: 0 });
    Object.defineProperty(line, 'offsetHeight', { value: 120 });
    act(() => remeasure?.());
    act(() => root.unmount());
    return heights.at(-1);
}

describe('the body the hook measures', () => {
    test("is the host's last child, whether or not a backdrop precedes it", () => {
        expect(fittedHeight(true)).toBe(120);
        expect(fittedHeight(false)).toBe(120);
    });
});
