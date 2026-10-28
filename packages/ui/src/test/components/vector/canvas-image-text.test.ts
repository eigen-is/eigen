// Download image writes the text of every element that holds text as SVG text from the browser's own layout: a text
// box's and a shape's alike. happy-dom lays nothing out, so the test gives each character a box of its own.
import { afterEach, expect, mock, test } from 'bun:test';
import type { VectorElement } from '@workspace/lib/vector';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

// Vite's import.meta.glob, which resolves a face's file to its served url, does not exist under bun.
mock.module('../../../components/vector/bundled-font-url', () => ({ bundledFontUrl: (file: string) => `/${file}` }));

const { downloadCanvasImage } = await import('../../../components/vector/canvas-image');

const shape = (html: string): VectorElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    id: 'r1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    index: 'a0',
    seed: 1,
    html,
});

const saved: Blob[] = [];
const realFetch = globalThis.fetch;
const realCreateObjectUrl = URL.createObjectURL;
const rangeProto = Object.getPrototypeOf(document.createRange());
const realClientRects = rangeProto.getClientRects;
Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });

afterEach(() => {
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreateObjectUrl;
    rangeProto.getClientRects = realClientRects;
    saved.length = 0;
});

async function download(elements: VectorElement[]): Promise<string> {
    globalThis.fetch = Object.assign(async () => new Response(new Uint8Array([1])), realFetch);
    URL.createObjectURL = (blob: Blob) => {
        saved.push(blob);
        return 'blob:test';
    };
    // One 8 x 16 box per character, in a row.
    rangeProto.getClientRects = function (this: { startOffset: number }) {
        return [{ left: this.startOffset * 8, top: 0, width: 8, height: 16 }];
    };
    await downloadCanvasImage(elements, { name: 'drawing' });
    return await saved[0].text();
}

test("a shape's text is written as SVG text, in its own face, and not as a foreignObject", async () => {
    const svg = await download([shape('<p>Hello</p>')]);
    expect(svg).toContain('<text');
    expect(svg).toContain('Hello');
    expect(svg).not.toContain('foreignObject');
});

test('a shape with no text is written as its drawing alone', async () => {
    const svg = await download([shape('')]);
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('foreignObject');
});

test('a shape whose list the user emptied is written as its drawing alone, with no stray bullet', async () => {
    const svg = await download([shape('<ul><li><p></p></li></ul>')]);
    expect(svg).not.toContain('<circle');
    expect(svg).not.toContain('foreignObject');
});

test('an empty text box is measured like one with text, so it writes no foreignObject', async () => {
    const box: VectorElement = {
        ...shape(''),
        ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
        type: 'richtext',
    };
    const svg = await download([box]);
    expect(svg).not.toContain('foreignObject');
});
