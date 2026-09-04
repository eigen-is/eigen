import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    richTextFitHeight,
    VECTOR_STYLE_DEFAULTS,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { Window } from 'happy-dom';
import { textBodyHeight } from '../../../components/vector/text-fit';

// A DOM at module scope, the element-layer suite's recipe — the measure reads layout properties off
// real nodes, and `instanceof HTMLElement` needs the constructor to be the global one.
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = window.document;
g.HTMLElement = window.HTMLElement;

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
