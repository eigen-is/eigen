// The chart editor sidebar over a mounted Workbook, wired the way the Sheets app wires it: Setup reads the
// chart's block back from its refs and rewrites them, the Customise rows write the spec, each change one
// undo step.
import { afterEach, expect, test } from 'bun:test';
import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const { ChartEditorPanel } = await import('../../../components/ChartEditorPanel');
const { CHART_RANGE_REFUSALS } = await import('../../../engine/chart-range');
type Sheet = import('../../../state').Sheet;
type ChartEditorState = import('../../../state').ChartEditorState;
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
        const [editor, setEditor] = useState<ChartEditorState | null>(null);
        return createElement(
            'div',
            null,
            createElement(Workbook, {
                ref: workbook,
                data,
                showToolbar: false,
                showFormulaBar: false,
                hooks: { onChartEditorChange: setEditor },
            }),
            editor && createElement(ChartEditorPanel, { key: editor.chart.id, editor, workbook }),
        );
    }
    await act(async () => root.render(createElement(Host)));
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };

    const box = container.querySelector('[data-chart-id="c1"]');
    if (!box) throw new Error('no chart');
    await act(async () => box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

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
    return { container, spec, field, type, toggle, undo };
}

test('Setup shows the chart’s block and how it reads', async () => {
    const { field, toggle } = await mount(rangeChart());
    expect(field('input[aria-label="Data range"]').value).toBe('A1:B4');
    expect(toggle('Switch rows/columns')?.getAttribute('aria-checked')).toBe('false');
    expect(toggle('Use row 1 as headers')?.getAttribute('aria-checked')).toBe('true');
    expect(toggle('Use column A as labels')?.getAttribute('aria-checked')).toBe('true');
});

test('a series row is named by its name cell, as the chart’s legend is', async () => {
    const { container } = await mount(rangeChart());
    const labels = [...container.querySelectorAll('span.w-14')].map((span) => span.textContent?.trim());
    expect(labels.at(-1)).toBe('Points');
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
