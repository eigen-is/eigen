import { afterEach, describe, expect, test } from 'bun:test';
import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartType } from '@workspace/lib/types/chart';
import type { StyleDefaults, VectorChartElement, VectorElement } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    VECTOR_STYLE_DEFAULTS,
    writeElementInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture, PropertyGestureContext, sealed } = await import('../../../../components/properties-panel');
const { ChartEditDialog, ChartPanelSection, newChartElement } = await import(
    '../../../../components/vector/kinds/chart'
);

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

function chart(id: string, type: ChartType = 'column'): VectorChartElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        id,
        type: 'chart',
        x: 0,
        y: 0,
        width: 640,
        height: 400,
        angle: 0,
        index: 'a0',
        chart: JSON.stringify(sampleChartSpec(type)),
        fill: '{"type":"solid","color":"#ffffff","style":"solid"}',
        color: '#1e1e1e',
    };
}

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

async function render(node: ReturnType<typeof createElement>) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(node));
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    return container;
}

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
// The grid opens on A1, as a sheet does, so B2 is selected first.
const typeInB2 = async (value: string) => {
    const b2 = dialog()?.querySelector('[role="row"][aria-rowindex="3"] > [aria-colindex="3"]');
    await act(async () => b2?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    await type(dialog()?.querySelector<HTMLInputElement>('input[data-cell-editor]') ?? null, value);
};
const buttonIn = (scope: ParentNode | undefined, label: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((el) => el.textContent?.trim() === label);
const click = async (target: HTMLElement | undefined) => {
    if (!target) throw new Error('nothing to click');
    await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const type = async (input: HTMLInputElement | null, value: string) => {
    if (!input) throw new Error('no field to type in');
    await act(async () => {
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('newChartElement', () => {
    // The canvas' insertChart: one sealed addElement of this partial at the viewport center.
    const insert = (type: ChartType, viewport: 'infinite' | 'frame', style: StyleDefaults) => {
        const doc = new Y.Doc();
        const undoManager = new Y.UndoManager(doc.getMap('elements'));
        sealed(undoManager, () =>
            writeElementInDoc(doc, newChartElement(type, { x: 960, y: 540 }, viewport, style), 'a0', style),
        );
        return { doc, undoManager, inserted: readVectorFromDoc(doc).elements };
    };

    test("a drawing's chart is 640 × 400 on the viewport center, rough and in Excalifont, one undo step", () => {
        const { undoManager, inserted, doc } = insert('bar', 'infinite', VECTOR_STYLE_DEFAULTS);
        expect(inserted).toHaveLength(1);
        const [el] = inserted;
        expect(el).toMatchObject({ type: 'chart', x: 640, y: 340, width: 640, height: 400 });
        expect(el.type === 'chart' && parseChartSpec(el.chart)).toEqual({
            ...sampleChartSpec('bar'),
            fontFamily: 'Excalifont',
        });
        expect(el.roughness).toBe(VECTOR_STYLE_DEFAULTS.roughness);
        expect(undoManager.undoStack).toHaveLength(1);
        undoManager.undo();
        expect(readVectorFromDoc(doc).elements).toEqual([]);
    });

    test("a slide's chart is 1200 × 675, flat and in Inter", () => {
        const { inserted } = insert('pie', 'frame', SLIDES_STYLE_DEFAULTS);
        const [el] = inserted;
        expect(el).toMatchObject({ type: 'chart', x: 360, y: 202.5, width: 1200, height: 675 });
        expect(el.type === 'chart' && parseChartSpec(el.chart)).toEqual({
            ...sampleChartSpec('pie'),
            fontFamily: 'Inter',
        });
        expect(el.roughness).toBe(SLIDES_STYLE_DEFAULTS.roughness);
    });
});

describe('ChartPanelSection', () => {
    const section = async (elements: VectorElement[], beginGesture?: () => () => void) => {
        const writes: Record<string, unknown>[] = [];
        const replaced: unknown[][] = [];
        const panel = createElement(ChartPanelSection, {
            elements,
            scene: new Map(elements.map((el) => [el.id, el])),
            onChange: (fields: Record<string, unknown>) => writes.push(fields),
            onChangeEach: () => {},
            onReplace: (shapes: unknown[]) => replaced.push(shapes),
        });
        const container = await render(
            beginGesture ? createElement(PropertyGestureContext.Provider, { value: beginGesture }, panel) : panel,
        );
        return { container, writes, replaced };
    };

    test('one selected chart shows its editor with Edit data', async () => {
        const { container } = await section([chart('c1')]);
        expect([...container.querySelectorAll('h4')].map((h) => h.textContent)).toContain('Chart');
        expect(buttonIn(container, 'Edit data')).toBeDefined();
    });

    test("Convert to shapes replaces the chart with its layout's shapes", async () => {
        const { container, replaced, writes } = await section([chart('c1')]);
        await click(buttonIn(container, 'Convert to shapes'));
        expect(replaced).toHaveLength(1);
        expect(replaced[0].length).toBeGreaterThan(10);
        expect(writes).toEqual([]);
    });

    test('two charts, or one whose spec does not parse, show no chart rows', async () => {
        expect((await section([chart('c1'), chart('c2')])).container.textContent).toBe('');
        expect((await section([{ ...chart('c1'), chart: '{' }])).container.textContent).toBe('');
    });

    test("an edit writes the element's chart field as the next spec", async () => {
        const { container, writes } = await section([chart('c1')]);
        await type(container.querySelector('input[placeholder="Chart title"]'), 'Goals');
        expect(writes).toHaveLength(1);
        const written = writes[0].chart;
        expect(typeof written === 'string' && parseChartSpec(written)?.title).toBe('Goals');
    });

    test('Edit data saves the grid as one write; Cancel writes nothing', async () => {
        const { container, writes } = await section([chart('c1')]);
        await click(buttonIn(container, 'Edit data'));
        await typeInB2('7');
        await click(buttonIn(dialog(), 'Save'));
        expect(writes).toHaveLength(1);
        const written = writes[0].chart;
        const spec = typeof written === 'string' ? parseChartSpec(written) : null;
        expect(spec?.data.source === 'inline' && spec.data.series[0].values[0]).toBe(7);

        await click(buttonIn(container, 'Edit data'));
        await typeInB2('8');
        await click(buttonIn(dialog(), 'Cancel'));
        expect(writes).toHaveLength(1);
    });
});

describe('ChartEditDialog', () => {
    // What a double-click on a chart opens.
    const open = async () => {
        const writes: Record<string, unknown>[] = [];
        let closed = 0;
        await render(
            createElement(ChartEditDialog, {
                element: chart('c1'),
                onChange: (fields: Record<string, unknown>) => writes.push(fields),
                onClose: () => {
                    closed += 1;
                },
            }),
        );
        return { writes, closed: () => closed };
    };

    test('opens the data grid at once; Save writes the chart and closes', async () => {
        const { writes, closed } = await open();
        expect(dialog()?.textContent).toContain('Edit data');
        await click(buttonIn(dialog(), 'Save'));
        expect(writes).toHaveLength(1);
        expect(closed()).toBe(1);
    });

    test('Cancel closes without a write', async () => {
        const { writes, closed } = await open();
        await click(buttonIn(dialog(), 'Cancel'));
        expect(writes).toEqual([]);
        expect(closed()).toBe(1);
    });
});

test('a font picked in the panel is one write of the spec and one undo step', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap<string>('element');
    const undoManager = new Y.UndoManager(element);
    const el = chart('c1');
    const panel = createElement(ChartPanelSection, {
        elements: [el],
        scene: new Map([[el.id, el]]),
        onChange: (fields: Record<string, unknown>) =>
            sealed(undoManager, () => {
                if (typeof fields.chart === 'string') element.set('chart', fields.chart);
            }),
        onChangeEach: () => {},
        onReplace: () => {},
    });
    const container = await render(
        createElement(PropertyGestureContext.Provider, { value: () => holdCapture(undoManager) }, panel),
    );
    const trigger = [...container.querySelectorAll('span.w-14')]
        .find((span) => span.textContent?.trim() === 'Font')
        ?.nextElementSibling?.querySelector('button[aria-haspopup="menu"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const serif = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Source Serif 4',
    );
    await click(serif);
    expect(parseChartSpec(element.get('chart') ?? '')?.fontFamily).toBe('Source Serif 4');
    expect(undoManager.undoStack).toHaveLength(1);
    undoManager.undo();
    expect(element.get('chart')).toBeUndefined();
});

test('a typed chart title through the panel is one undo step', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap<string>('element');
    const undoManager = new Y.UndoManager(element);
    const el = chart('c1');
    const panel = createElement(ChartPanelSection, {
        elements: [el],
        scene: new Map([[el.id, el]]),
        onChange: (fields: Record<string, unknown>) =>
            sealed(undoManager, () => {
                if (typeof fields.chart === 'string') element.set('chart', fields.chart);
            }),
        onChangeEach: () => {},
        onReplace: () => {},
    });
    const container = await render(
        createElement(PropertyGestureContext.Provider, { value: () => holdCapture(undoManager) }, panel),
    );
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
    for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
    await act(async () => input?.dispatchEvent(new Event('focusout', { bubbles: true })));
    expect(parseChartSpec(element.get('chart') ?? '')?.title).toBe('Goal');
    expect(undoManager.undoStack).toHaveLength(1);
});
