import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_SKETCH_POINTS, sampleChartSpec } from '@workspace/lib/charts';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
    type VectorChartElement,
    type VectorElement,
    type VectorPathElement,
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

async function renderPanel(el: VectorElement, selected: VectorElement[] = [el]) {
    const writes: { id: string; fields: Record<string, unknown> }[][] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(CanvasPropertiesPanel, {
                elements: selected,
                selectedElements: selected,
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
        const { sections } = await renderPanel(chart(), [chart(), path()]);
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
