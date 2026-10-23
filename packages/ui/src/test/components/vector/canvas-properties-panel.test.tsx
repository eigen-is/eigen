import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_SKETCH_POINTS, sampleChartSpec } from '@workspace/lib/charts';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    SLIDES_STYLE_DEFAULTS,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
    type VectorChartElement,
    type VectorElement,
    type VectorPathElement,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CanvasPropertiesPanel } = await import('../../../components/vector/canvas-properties-panel');

const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

function path(over: Partial<VectorPathElement> = {}): VectorPathElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        ...ELEMENT_KINDS.path.defaults(VECTOR_STYLE_DEFAULTS),
        id: 'p',
        type: 'path',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        angle: 0,
        index: 'a0',
        path: 'M 0 1 C 0 0 1 0 1 1 Z',
        closed: true,
        fill: solidFill('#ff0000'),
        ...over,
    };
}

function textBox(id: string, over: Partial<VectorRichTextElement> = {}): VectorRichTextElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        ...ELEMENT_KINDS.richtext.defaults(SLIDES_STYLE_DEFAULTS),
        id,
        type: 'richtext',
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        angle: 0,
        index: 'a0',
        html: '<p>x</p>',
        ...over,
    };
}

const DEFAULT_SERIES = { color: null, markers: false, smooth: false };

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

function chart(over: Partial<VectorChartElement> = {}): VectorChartElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        ...ELEMENT_KINDS.chart.defaults(VECTOR_STYLE_DEFAULTS),
        id: 'c',
        type: 'chart',
        x: 0,
        y: 0,
        width: 640,
        height: 400,
        angle: 0,
        index: 'a1',
        ...over,
    };
}

// `slideWidth` is a deck's, which Slides passes; a drawing passes none.
async function renderPanel(el: VectorElement | VectorElement[], slideWidth?: number) {
    const selected = Array.isArray(el) ? el : [el];
    const writes: { id: string; fields: Record<string, unknown> }[][] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(CanvasPropertiesPanel, {
                elements: selected,
                selectedElements: selected,
                slideWidth,
                updateElements: (patches) => writes.push(patches),
                reorderElements: () => {},
                replaceElement: () => [],
                setSelectedIds: () => {},
                undoManager: null,
                aspectLocked: false,
                onAspectLockChange: () => {},
            }),
        ),
    );
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    const sections = [...container.querySelectorAll('h4')].map((h) => h.textContent);
    return { container, sections, writes };
}

describe('the panel for a path', () => {
    test('a closed path edits its transform, fill and hatch, stroke, sketch and opacity, with no corners', async () => {
        const { container, sections } = await renderPanel(path());
        const text = container.textContent ?? '';
        expect(text).toContain('Freeform');
        expect(sections).toEqual(['Transform', 'Fill', 'Stroke', 'Sketch', 'Appearance', 'Arrange']);
        // Fill's hatch, Stroke's dash and the Sketch style
        expect(text.match(/Style/g)).toHaveLength(3);
        expect(text).not.toContain('Corners');
        expect(text).not.toContain('Edges');
        expect(text).not.toContain('Convert to shapes');
    });

    test('an open path has no fill to edit', async () => {
        const { sections } = await renderPanel(path({ path: 'M 0 1 C 0 0 1 0 1 1', closed: false }));
        expect(sections).toEqual(['Transform', 'Stroke', 'Sketch', 'Appearance', 'Arrange']);
    });

    test('a typed width resizes the box and leaves the stored path alone', async () => {
        const { container, writes } = await renderPanel(path());
        const width = container.querySelectorAll('input')[2];
        await act(async () => {
            width.focus();
            setValue?.call(width, '300');
            width.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(writes).toEqual([[{ id: 'p', fields: { width: 300 } }]]);
    });
});

// The field of the row a label names.
function rowInput(container: HTMLElement, label: string): HTMLInputElement {
    const name = [...container.querySelectorAll('span')].find((span) => span.textContent === label);
    const input = name?.nextElementSibling?.querySelector('input');
    if (!input) throw new Error(`no ${label} row`);
    return input;
}

async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe("a text box's rows", () => {
    test("a deck shows its size in pt at the deck's width, a drawing in px", async () => {
        const deck = await renderPanel(textBox('a', { fontSize: 88 }), 960);
        expect(rowInput(deck.container, 'Size').value).toBe('44');
        const drawing = await renderPanel(textBox('a', { fontSize: 88 }));
        expect(rowInput(drawing.container, 'Size').value).toBe('88');
    });

    test("a step writes each box's own next size", async () => {
        const { container, writes } = await renderPanel(
            [textBox('a', { fontSize: 88 }), textBox('b', { fontSize: 48 })],
            960,
        );
        const increase = [...container.querySelectorAll('button')].find(
            (button) => button.getAttribute('aria-label') === 'Increase font size',
        );
        if (!increase) throw new Error('no stepper');
        await act(async () => increase.click());
        expect(writes).toEqual([
            [
                { id: 'a', fields: { fontSize: 90 } },
                { id: 'b', fields: { fontSize: 50 } },
            ],
        ]);
    });

    test('a deck shows letter spacing in pt and writes the px it stores, a drawing px', async () => {
        const deck = await renderPanel(textBox('a', { letterSpacing: 3 }), 960);
        const letter = rowInput(deck.container, 'Letter');
        expect(letter.value).toBe('1.5');
        await type(letter, '2');
        expect(deck.writes).toEqual([[{ id: 'a', fields: { letterSpacing: 4 } }]]);
        const drawing = await renderPanel(textBox('b', { letterSpacing: 3 }));
        expect(rowInput(drawing.container, 'Letter').value).toBe('3');
    });

    // A pptx's 0.1 pt tracking on a 10 in deck stores 0.2667 px.
    test('letter spacing shows to the hundredth, and showing it writes nothing', async () => {
        const { container, writes } = await renderPanel(textBox('a', { letterSpacing: 0.26666666666666666 }), 720);
        const letter = rowInput(container, 'Letter');
        expect(letter.value).toBe('0.1');
        await act(async () => {
            letter.focus();
            letter.blur();
        });
        expect(writes).toEqual([]);
    });
});

describe('the stroke width', () => {
    // A pptx's 1 pt line on a 10 in deck.
    test('shows an imported width to the hundredth and takes any typed one', async () => {
        const { container, writes } = await renderPanel(path({ strokeWidth: 2.6666666666666665 }), 720);
        const width = rowInput(container, 'Width');
        expect(width.value).toBe('2.67');
        await type(width, '1.5');
        expect(writes).toEqual([[{ id: 'p', fields: { strokeWidth: 1.5 } }]]);
    });

    test('a selection of unlike widths shows none', async () => {
        const { container } = await renderPanel([path({ strokeWidth: 2 }), path({ id: 'q', strokeWidth: 4 })]);
        expect(rowInput(container, 'Width').value).toBe('');
    });
});

describe('the panel for a chart', () => {
    const rowsOf = (container: HTMLElement, section: string) => {
        const heading = [...container.querySelectorAll('h4')].find((h) => h.textContent === section);
        return [...(heading?.parentElement?.querySelectorAll('span.w-14') ?? [])].map((s) => s.textContent?.trim());
    };

    // The hatch is the bars', so its row shows over a transparent background; the label color is the chart's own.
    test('edits its label color, fill and hatch, stroke and sketch', async () => {
        const { container, sections } = await renderPanel(chart());
        expect(sections.slice(sections.indexOf('Labels'))).toEqual([
            'Labels',
            'Fill',
            'Stroke',
            'Sketch',
            'Appearance',
            'Arrange',
        ]);
        expect(rowsOf(container, 'Labels')).toEqual(['Color']);
        expect(rowsOf(container, 'Fill')).toEqual(['Style']);
        expect(container.textContent).not.toContain(`${MAX_SKETCH_POINTS} points`);
    });

    test('a chart beside a shape shows only the rows they share', async () => {
        const { sections } = await renderPanel([chart(), path()]);
        expect(sections).not.toContain('Labels');
    });

    test('says when its data draws without the sketch', async () => {
        const spec = sampleChartSpec('pie');
        const categories = Array.from({ length: MAX_SKETCH_POINTS + 1 }, (_, i) => `C${i}`);
        const values = categories.map(() => 1);
        const data = { source: 'inline', categories, series: [{ ...DEFAULT_SERIES, name: 'S', values }] };
        const { container } = await renderPanel(chart({ chart: JSON.stringify({ ...spec, data }) }));
        expect(container.textContent).toContain(`${MAX_SKETCH_POINTS} points`);
    });
});
