// The chart overlay on a mounted Workbook: each chart of the current sheet draws its range as SVG, redrawn
// only when a sheet it reads changes; a click selects it, Delete removes it, Escape lets go, and its ⋮ menu
// edits, deletes and downloads it.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const chartData = await import('../../../engine/chart-data');
const download = await import('@workspace/lib/download');
type Sheet = import('../../../state').Sheet;
type Op = import('../../../state').Op;
type ChartEditorState = import('../../../state').ChartEditorState;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const ref = (row: [number, number], column: [number, number]): CellRangeRef => ({ sheetId: 's1', row, column });

const chart: SheetChart = {
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
            categories: ref([1, 2], [0, 0]),
            series: [
                {
                    name: ref([0, 0], [1, 1]),
                    values: ref([1, 2], [1, 1]),
                    color: '#2a78d6',
                    markers: false,
                    smooth: false,
                },
            ],
        },
    }),
};

const cell = (r: number, c: number, v: string | number) => ({ r, c, v: { v, m: String(v) } });

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount(allowEdit = true) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const editors: (ChartEditorState | null)[] = [];
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 20,
            column: 10,
            celldata: [
                cell(0, 0, 'Team'),
                cell(0, 1, 'Points'),
                cell(1, 0, 'Ajax'),
                cell(1, 1, 42),
                cell(2, 0, 'PSV'),
                cell(2, 1, 65),
            ],
            config: {},
            charts: { c1: chart },
        },
        { id: 's2', name: 'Two', order: 1, row: 20, column: 10, celldata: [cell(0, 0, 'x')], config: {} },
    ];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref: workbook,
                data,
                allowEdit,
                showToolbar: false,
                showFormulaBar: false,
                hooks: { onChartEditorChange: (editor) => editors.push(editor) },
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const box = () => container.querySelector<HTMLElement>('[data-chart-id="c1"]');
    const step = (run: (w: WorkbookInstance) => void) =>
        act(async () => {
            if (!workbook.current) throw new Error('workbook did not mount');
            run(workbook.current);
        });
    const charts = () => workbook.current?.getAllSheets()[0].charts;
    return { container, box, step, charts, editors };
}

const press = (target: EventTarget, type: string, init: KeyboardEventInit | PointerEventInit = {}) =>
    act(async () => {
        const event = type.startsWith('key')
            ? new KeyboardEvent(type, { bubbles: true, ...init })
            : new PointerEvent(type, { bubbles: true, button: 0, ...init });
        target.dispatchEvent(event);
    });

const clickCell = (container: HTMLElement) =>
    act(async () => {
        container.querySelector('.sheet-cell-area')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

const peerSets = (sheetId: string, r: number, c: number, v: number): Op[] => [
    { op: 'replace', id: sheetId, path: ['data', r, c], value: { v, m: String(v) } },
];

test('a range chart draws as SVG at its box, labelled from its cells', async () => {
    const { box } = await mount();
    const el = box();
    expect(el?.style.left).toBe('300px');
    expect(el?.style.width).toBe('400px');
    const svg = el?.querySelector('svg')?.outerHTML ?? '';
    for (const label of ['>Scores<', '>Ajax<', '>PSV<', '>Points<']) expect(svg).toContain(label);
    // A double-click opens the editor, so it must not select the drawing's text.
    expect(el?.classList.contains('select-none')).toBe(true);
});

test('a source cell edit redraws the chart; an edit on another sheet or a selection does not', async () => {
    const renders = spyOn(chartData, 'renderSheetChartSvg');
    try {
        const { box, step } = await mount();
        const drawn = renders.mock.calls.length;
        expect(drawn).toBeGreaterThan(0);

        await step((w) => w.applyOp(peerSets('s2', 0, 0, 7)));
        await step((w) => w.setSelection([{ row: [5, 5], column: [5, 5] }]));
        expect(renders.mock.calls.length).toBe(drawn);

        await step((w) => w.applyOp(peerSets('s1', 1, 1, 420)));
        expect(renders.mock.calls.length).toBe(drawn + 1);
        expect(box()?.querySelector('svg')?.outerHTML).toContain('>400<');
    } finally {
        renders.mockRestore();
    }
});

test('a click selects the chart and Delete removes it as one undo step', async () => {
    const { box, charts, step } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await press(el, 'pointerdown');
    await press(el, 'pointerup');
    expect(box()?.getAttribute('data-active')).toBe('true');
    await press(document.activeElement ?? el, 'keydown', { key: 'Delete' });
    expect(charts()).toEqual({});
    await step((w) => w.undo());
    expect(charts()?.c1).toEqual(chart);
});

test('Escape lets go of the selected chart', async () => {
    const { box } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await press(el, 'pointerdown');
    await press(el, 'pointerup');
    await press(document.activeElement ?? el, 'keydown', { key: 'Escape' });
    expect(box()?.getAttribute('data-active')).toBeNull();
});

test('dragging the chart moves it in one write', async () => {
    const { box, charts, step } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await press(el, 'pointerdown', { clientX: 10, clientY: 10 });
    await press(document, 'pointermove', { clientX: 30, clientY: 15 });
    await press(document, 'pointermove', { clientX: 60, clientY: 20 });
    await press(document, 'pointerup', { clientX: 60, clientY: 20 });
    expect(charts()?.c1).toMatchObject({ x: 350, y: 20, width: 400 });
    await step((w) => w.undo());
    expect(charts()?.c1).toMatchObject({ x: 300, y: 10 });
});

test('a cancelled pointer, a touch pan the browser took, moves nothing on the next tap', async () => {
    const { box, container, charts } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await press(el, 'pointerdown', { clientX: 10, clientY: 10, pointerType: 'touch' });
    await press(document, 'pointermove', { clientX: 30, clientY: 40, pointerType: 'touch' });
    await press(document, 'pointercancel', { pointerType: 'touch' });
    expect(box()?.style.left).toBe('300px');
    await press(document, 'pointermove', { clientX: 90, clientY: 90, pointerType: 'touch' });
    await press(document, 'pointerup', { clientX: 90, clientY: 90, pointerType: 'touch' });
    expect(charts()?.c1).toEqual(chart);
    expect(box()?.style.left).toBe('300px');
    // Only the selected chart keeps the browser from panning the grid under a finger.
    expect(box()?.classList.contains('touch-none')).toBe(true);
    await clickCell(container);
    expect(box()?.classList.contains('touch-none')).toBe(false);
});

test('a double-click opens the chart editor, and the editor follows the chart', async () => {
    const { box, container, editors, step } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await act(async () => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(editors.at(-1)).toMatchObject({
        chart: { id: 'c1' },
        sheetId: 's1',
        sheets: [
            { id: 's1', name: 'One' },
            { id: 's2', name: 'Two' },
        ],
    });
    await step((w) => w.updateChartBox('c1', { x: 10 }));
    expect(editors.at(-1)?.chart.x).toBe(10);
    await clickCell(container);
    expect(editors.at(-1)).toBeNull();
});

async function openMenu(el: HTMLElement) {
    const trigger = el.querySelector('button[aria-label="Chart menu"]');
    if (!trigger) throw new Error('no ⋮ button');
    await press(trigger, 'pointerdown');
}

async function pick(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    if (!item) throw new Error(`no ${label} item`);
    await act(async () => item.click());
}

test('⋮ Edit the chart opens the editor, Delete chart removes it', async () => {
    const { box, editors, charts } = await mount();
    const el = box();
    if (!el) throw new Error('no chart');
    await openMenu(el);
    await pick('Edit the chart');
    expect(editors.at(-1)?.chart.id).toBe('c1');
    await openMenu(el);
    await pick('Delete chart');
    expect(charts()).toEqual({});
});

test('⋮ Download chart → SVG saves the painter’s svg on white, for a viewer too', async () => {
    const saved = spyOn(download, 'downloadBlob').mockImplementation(() => {});
    try {
        const { box } = await mount(false);
        const el = box();
        if (!el) throw new Error('no chart');
        await openMenu(el);
        expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual([
            'Download chart',
        ]);
        await act(async () => {
            document
                .querySelector('[role="menuitem"][aria-haspopup="menu"]')
                ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        });
        await act(async () => {
            document
                .querySelector('[role="menuitem"][aria-haspopup="menu"]')
                ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
        await pick('SVG (.svg)');
        expect(saved).toHaveBeenCalledTimes(1);
        const [blob, name] = saved.mock.calls[0];
        expect(name).toBe('Scores.svg');
        expect(blob.type).toBe('image/svg+xml');
        const saved_svg = await blob.text();
        expect(saved_svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"');
        // White under the painter's transparent background, as the export draws it.
        expect(saved_svg).toContain('viewBox="0 0 400 300"><rect width="100%" height="100%" fill="#fff"/>');
        expect(saved_svg).toContain('>Scores<');
    } finally {
        saved.mockRestore();
    }
});
