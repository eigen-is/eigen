// The selected chart's sections over a mounted Workbook, wired the way the Sheets app wires its panel: a click
// selects the chart and shows them, the data range reads the chart's block back from its refs and rewrites them,
// the Customise rows write the spec, each change one undo step.
import { afterEach, expect, test } from 'bun:test';
import { MAX_SKETCH_POINTS, parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { parseFill } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const { PropertyGestureContext } = await import('@workspace/ui/components/properties-panel');
const { ChartPanelSections } = await import('../../../components/ChartPanelSections');
const { CHART_RANGE_REFUSALS } = await import('../../../engine/chart-range');
type Sheet = import('../../../state').Sheet;
type ChartPanelState = import('../../../state').ChartPanelState;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const ref = (row: [number, number], column: [number, number], sheetId = 's1'): CellRangeRef => ({
    sheetId,
    row,
    column,
});

const rangeChart = (): SheetChart => ({
    id: 'c1',
    index: 'a0',
    x: 300,
    y: 10,
    width: 400,
    height: 300,
    spec: JSON.stringify({
        ...sampleChartSpec('column'),
        title: 'Scores',
        data: {
            source: 'range',
            categories: ref([1, 3], [0, 0]),
            series: [
                {
                    id: 's-1',
                    name: ref([0, 0], [1, 1]),
                    values: ref([1, 3], [1, 1]),
                    color: '#000000',
                    markers: false,
                    smooth: false,
                },
            ],
        },
    }),
});

const inlineChart = (): SheetChart => ({ ...rangeChart(), spec: JSON.stringify(sampleChartSpec('column')) });

const cell = (r: number, c: number, v: string | number) => ({ r, c, v: { v, m: String(v) } });
const table = [cell(0, 0, 'Team'), cell(0, 1, 'Points'), cell(1, 0, 'Ajax'), cell(1, 1, 42)];
const rows = [cell(2, 0, 'PSV'), cell(2, 1, 65), cell(3, 0, 'AZ'), cell(3, 1, 30)];

// React reads an input's value off its own tracker, so the native setter is what a keystroke looks like.
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount(chart: SheetChart) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 20,
            column: 10,
            celldata: [...table, ...rows],
            config: {},
            charts: { c1: chart },
        },
        { id: 's2', name: 'Two', order: 1, row: 20, column: 10, celldata: [...table, ...rows], config: {} },
    ];
    function Host() {
        const [panel, setPanel] = useState<ChartPanelState | null>(null);
        return createElement(
            'div',
            null,
            createElement(Workbook, {
                ref: workbook,
                data,
                showToolbar: false,
                showFormulaBar: false,
                hooks: { onChartPanelChange: setPanel },
            }),
            panel &&
                createElement(
                    PropertyGestureContext.Provider,
                    { value: () => workbook.current?.beginGesture() ?? (() => {}) },
                    createElement(ChartPanelSections, { key: panel.chart.id, panel, workbook }),
                ),
        );
    }
    await act(async () => root.render(createElement(Host)));
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };

    const box = container.querySelector('[data-floating-id="c1"] > *');
    if (!box) throw new Error('no chart');
    // One click: the sections show for a selected chart, with no editor to open.
    await act(async () => box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    await act(async () => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })));

    const spec = (): ChartSpec | null => parseChartSpec(workbook.current?.getAllSheets()[0].charts?.c1.spec ?? '');
    const field = (selector: string) => {
        const found = container.querySelector<HTMLInputElement>(selector);
        if (!found) throw new Error(`no ${selector}`);
        return found;
    };
    const type = async (selector: string, value: string, end: 'Enter' | 'blur') => {
        const input = field(selector);
        await act(async () => {
            input.focus();
            input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            setValue?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            if (end === 'Enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            else input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
    };
    const toggle = (label: string) => {
        const found = [...container.querySelectorAll('label')].find((el) => el.textContent?.trim() === label);
        if (!found)
            throw new Error(
                `no "${label}"; saw ${[...container.querySelectorAll('label')].map((el) => el.textContent).join(', ')}`,
            );
        return found.querySelector<HTMLButtonElement>('button[role="checkbox"]');
    };
    const undo = () => act(async () => workbook.current?.undo());
    const stored = () => workbook.current?.getAllSheets()[0].charts?.c1;
    const drawn = () => container.querySelector('[data-floating-id="c1"] svg')?.innerHTML;
    // A section's select, beside its label.
    const choose = async (section: string, label: string, option: string) => {
        const heading = [...container.querySelectorAll('h4')].find((h) => h.textContent === section);
        const span = [...(heading?.parentElement?.querySelectorAll('span.w-14') ?? [])].find(
            (el) => el.textContent?.trim() === label,
        );
        const trigger = span?.nextElementSibling?.querySelector('[data-slot="select-trigger"]');
        if (!trigger) throw new Error(`no ${section} › ${label} row`);
        await act(async () => {
            trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
        const item = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
            (el) => el.textContent?.trim() === option,
        );
        if (!item) throw new Error(`no "${option}" under ${section} › ${label}`);
        await act(async () => {
            item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    return { container, workbook, spec, field, type, toggle, undo, stored, drawn, choose };
}

test('a selected chart shows the shared sections, its data range rows inside the Chart section', async () => {
    const { container, field } = await mount(rangeChart());
    const headings = [...container.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings).toEqual([
        'Chart',
        'Horizontal axis',
        'Vertical axis',
        'Series',
        'Labels',
        'Fill',
        'Stroke',
        'Sketch',
    ]);
    const section = field('input[aria-label="Data range"]').closest('.border-b');
    expect(section?.querySelector('h4')?.textContent).toBe('Chart');
});

test('the data range shows the chart’s block and how it reads', async () => {
    const { field, toggle } = await mount(rangeChart());
    expect(field('input[aria-label="Data range"]').value).toBe('A1:B4');
    expect(toggle('Switch rows/columns')?.getAttribute('aria-checked')).toBe('false');
    expect(toggle('Use row 1 as headers')?.getAttribute('aria-checked')).toBe('true');
    expect(toggle('Use column A as labels')?.getAttribute('aria-checked')).toBe('true');
});

test('a series row is named by its name cell, as the chart’s legend is', async () => {
    const { container } = await mount(rangeChart());
    const labels = [...container.querySelectorAll('span.w-14')].map((span) => span.textContent?.trim());
    expect(labels).toContain('Points');
    expect(labels).not.toContain('Series 1');
});

test('a range typed on another sheet points the refs at that sheet by id, the series keeping its color', async () => {
    const { spec, type } = await mount(rangeChart());
    await type('input[aria-label="Data range"]', 'Two!A1:B3', 'Enter');
    expect(spec()?.data).toMatchObject({
        source: 'range',
        categories: ref([1, 2], [0, 0], 's2'),
        series: [{ name: ref([0, 0], [1, 1], 's2'), values: ref([1, 2], [1, 1], 's2'), color: '#000000' }],
    });
});

test('an invalid range says so and writes nothing', async () => {
    const { container, spec, type } = await mount(rangeChart());
    const before = spec();
    await type('input[aria-label="Data range"]', 'Nowhere!A1:B3', 'blur');
    expect(container.textContent).toContain('Enter a range such as A1:D10');
    expect(spec()).toEqual(before);
});

test('a range with too much data or too many series says which and writes nothing', async () => {
    const { container, spec, type } = await mount(rangeChart());
    const before = spec();
    await type('input[aria-label="Data range"]', 'A1:B3000', 'Enter');
    expect(container.textContent).toContain(CHART_RANGE_REFUSALS['too-many-points']);
    expect(spec()).toEqual(before);
    await type('input[aria-label="Data range"]', 'A1:AJ40', 'Enter');
    expect(container.textContent).toContain(CHART_RANGE_REFUSALS['too-many-series']);
    expect(spec()).toEqual(before);
});

test('Switch rows/columns re-derives the refs from the block, one undo step', async () => {
    const { spec, toggle, undo } = await mount(rangeChart());
    const before = spec();
    await act(async () => toggle('Switch rows/columns')?.click());
    expect(spec()?.data).toMatchObject({
        categories: ref([0, 0], [1, 1]),
        series: [
            { name: ref([1, 1], [0, 0]), values: ref([1, 1], [1, 1]), color: '#000000' },
            { name: ref([2, 2], [0, 0]), values: ref([2, 2], [1, 1]) },
            { name: ref([3, 3], [0, 0]), values: ref([3, 3], [1, 1]) },
        ],
    });
    await undo();
    expect(spec()).toEqual(before);
});

test("a Setup toggle keeps what this build doesn't know: a key on the spec, the data and a series, and a legend", async () => {
    const chart = rangeChart();
    const raw = JSON.parse(chart.spec);
    const series = raw.data.series.map((s: object) => ({ ...s, dash: 'dot' }));
    const newer = { ...raw, future: 1, legend: 'inside', data: { ...raw.data, future: 2, series } };
    const { stored, toggle } = await mount({ ...chart, spec: JSON.stringify(newer) });
    await act(async () => toggle('Switch rows/columns')?.click());
    const written = JSON.parse(stored()?.spec ?? '{}');
    expect(written.data.categories).toEqual(ref([0, 0], [1, 1]));
    expect([written.future, written.legend, written.data.future]).toEqual([1, 'inside', 2]);
    expect(written.data.series[0]).toMatchObject({ id: 's-1', dash: 'dot', color: '#000000' });
});

test('a title typed letter by letter is one undo step', async () => {
    const { spec, field, undo } = await mount(rangeChart());
    const title = field('input[placeholder="Chart title"]');
    await act(async () => {
        title.focus();
        title.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    for (const text of ['P', 'Po', 'Pos']) {
        await act(async () => {
            setValue?.call(title, text);
            title.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(spec()?.title).toBe('Pos');
    await undo();
    expect(spec()?.title).toBe('Scores');
});

test('an inline chart edits its data in the grid dialog instead of a data range', async () => {
    const { container } = await mount(inlineChart());
    expect(container.querySelector('input[aria-label="Data range"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Edit data'))).toBe(
        true,
    );
});

test("Edit data's Save keeps a peer's colours and title written while it was open", async () => {
    const { container, workbook, spec } = await mount(inlineChart());
    const click = (target: Element | undefined) =>
        act(async () => target?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const buttonIn = (scope: ParentNode | undefined, label: string) =>
        [...(scope?.querySelectorAll('button') ?? [])].find((el) => el.textContent?.trim() === label);
    await click(buttonIn(container, 'Edit data'));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
    const series = sampleChartSpec('column').data.series.map((s, i) => (i === 1 ? { ...s, color: '#00ff00' } : s));
    await act(async () =>
        workbook.current?.setChartSpec('c1', [
            { op: 'set', path: ['title'], value: 'Peer title' },
            { op: 'set', path: ['sliceColors'], value: [null, '#000002'] },
            { op: 'set', path: ['data', 'series'], value: series },
        ]),
    );
    const b2 = dialog?.querySelector('[role="row"][aria-rowindex="3"] > [aria-colindex="3"]');
    await act(async () => b2?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    const input = dialog?.querySelector<HTMLInputElement>('input[data-cell-editor]');
    await act(async () => {
        if (!input) throw new Error('no cell editor');
        setValue?.call(input, '7');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonIn(dialog, 'Save'));
    const saved = spec();
    expect(saved?.title).toBe('Peer title');
    expect(saved?.sliceColors).toEqual([null, '#000002']);
    expect(saved?.data.series.map((s) => s.color)).toEqual([null, '#00ff00', null]);
    expect(saved?.data.source === 'inline' && saved.data.series[0].values[0]).toBe(7);
});

test("the paint rows write the chart's own look fields, each one undo step, and the chart draws them", async () => {
    const { container, spec, stored, drawn, choose, undo } = await mount(rangeChart());
    const sections = [...container.querySelectorAll('h4')].map((h) => h.textContent);
    expect(sections).toEqual(expect.arrayContaining(['Labels', 'Fill', 'Stroke', 'Sketch']));
    const before = spec();
    const flat = drawn();

    await choose('Sketch', 'Style', 'Cartoonist');
    expect(stored()?.roughness).toBe(2);
    expect(drawn()).not.toBe(flat);
    await choose('Fill', 'Style', 'Cross-hatch');
    expect(parseFill(stored()?.fill ?? '').style).toBe('cross-hatch');
    expect(spec()).toEqual(before);

    await undo();
    expect(stored()?.fill).toBeUndefined();
    expect(stored()?.roughness).toBe(2);
    await undo();
    expect(stored()?.roughness).toBeUndefined();
    expect(drawn()).toBe(flat);
});

test('a range chart past the sketch cap says so under Sketch', async () => {
    const chart = rangeChart();
    const many = JSON.stringify({
        ...JSON.parse(chart.spec),
        data: {
            source: 'range',
            categories: null,
            series: [
                {
                    id: 's-1',
                    name: 'Points',
                    values: ref([1, MAX_SKETCH_POINTS + 1], [1, 1]),
                    color: null,
                    markers: false,
                    smooth: false,
                },
            ],
        },
    });
    const capped = await mount({ ...chart, spec: many });
    expect(capped.container.textContent).toContain(`Past ${MAX_SKETCH_POINTS} points`);
    await cleanup?.();
    cleanup = undefined;
    const small = await mount(rangeChart());
    expect(small.container.textContent).not.toContain(`Past ${MAX_SKETCH_POINTS} points`);
});
