// A selected chart on the clipboard: ⌘C writes one chart item with its ranges read into inline data and marks no
// cells copied, ⌘X deletes it too, and ⌘V with a chart focused pastes one, linked to its cells in the workbook it
// was copied from and inline anywhere else.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { FLAT_CHART_LOOK, parseChartSpec, readChartLook, sampleChartSpec } from '@workspace/lib/charts';
import { buildChartClipboardItem, readEigenClipboard, writeEigenClipboard } from '@workspace/lib/clipboard';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartLook } from '@workspace/lib/types/chart';
import { serializeFill } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const copyModule = await import('../../../state/events/copy');
const clipboardModule = await import('../../../state/modules/clipboard');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const ref = (row: [number, number], column: [number, number]): CellRangeRef => ({ sheetId: 's1', row, column });

const rangeSpec = (values: CellRangeRef) =>
    JSON.stringify({
        ...sampleChartSpec('column'),
        title: 'Scores',
        data: {
            source: 'range',
            categories: ref([1, 2], [0, 0]),
            series: [{ name: ref([0, 0], [1, 1]), values, color: null, markers: false, smooth: false }],
        },
    });

const chart: SheetChart = {
    id: 'c1',
    index: 'a0',
    x: 300,
    y: 10,
    width: 400,
    height: 300,
    spec: rangeSpec(ref([1, 2], [1, 1])),
};

const cell = (r: number, c: number, v: string | number) => ({ r, c, v: { v, m: String(v) } });

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

// A rough, hatched look as Vector stores it on a chart element.
const ROUGH: ChartLook = {
    fill: serializeFill({ type: 'solid', color: '#ffeeaa', style: 'cross-hatch' }),
    color: '#334455',
    strokeColor: '#556677',
    strokeWidth: 3,
    strokeStyle: 'dashed',
    roughness: 2,
    seed: 4242,
};

async function mount({ allowEdit = true, spec = chart.spec, look = {} as Partial<ChartLook> } = {}) {
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
            celldata: [
                cell(0, 0, 'Team'),
                cell(0, 1, 'Points'),
                cell(1, 0, 'Ajax'),
                cell(1, 1, 42),
                cell(2, 0, 'PSV'),
                cell(2, 1, 65),
            ],
            config: {},
            charts: { c1: { ...chart, spec, ...look } },
        },
    ];
    await act(async () => {
        root.render(
            createElement(Workbook, { ref: workbook, data, allowEdit, showToolbar: false, showFormulaBar: false }),
        );
    });
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    const charts = () => Object.values(workbook.current?.getAllSheets()[0].charts ?? {});
    const select = async () => {
        const box = container.querySelector<HTMLElement>('[data-floating-id="c1"] > *');
        if (!box) throw new Error('no chart');
        await act(async () => {
            box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        });
        return box;
    };
    const undo = () => act(async () => workbook.current?.undo());
    return { charts, select, undo };
}

// The key as the workbook sees it, then the native event the browser fires after it.
async function shortcut(code: 'KeyC' | 'KeyX' | 'KeyV', clipboardData = new DataTransfer()) {
    const target = document.activeElement ?? document.body;
    const type = { KeyC: 'copy', KeyX: 'cut', KeyV: 'paste' }[code];
    const event = new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true });
    await act(async () => {
        target.dispatchEvent(
            new KeyboardEvent('keydown', { code, key: code.at(-1)?.toLowerCase(), metaKey: true, bubbles: true }),
        );
        target.dispatchEvent(event);
    });
    return { event, clipboardData };
}

test('⌘C on a selected chart writes the chart with its cells as inline data, and marks no cells copied', async () => {
    const copied = spyOn(copyModule, 'handleCopy');
    try {
        const { select } = await mount();
        await select();
        const { event, clipboardData } = await shortcut('KeyC');
        expect(event.defaultPrevented).toBe(true);
        expect(copied).not.toHaveBeenCalled();
        expect(clipboardModule.consumePendingCopy()).toBeNull();
        expect(clipboardData.getData('text/plain')).toBe('');
        const [item, ...rest] = readEigenClipboard(clipboardData)?.items ?? [];
        expect(rest).toEqual([]);
        expect(item).toMatchObject({ type: 'chart', width: 400, height: 300 });
        expect(item?.type === 'chart' && parseChartSpec(item.spec)?.data).toEqual({
            source: 'inline',
            categories: ['Ajax', 'PSV'],
            series: [{ name: 'Points', values: [42, 65], color: null, markers: false, smooth: false }],
        });
    } finally {
        copied.mockRestore();
    }
});

test('a chart showing #REF! copies nothing', async () => {
    const { select } = await mount({ spec: rangeSpec(ref([1, 2], [0, 1])) });
    await select();
    const { event, clipboardData } = await shortcut('KeyC');
    expect(event.defaultPrevented).toBe(false);
    expect(readEigenClipboard(clipboardData)).toBeNull();
});

test('⌘C in a text field while a chart is selected leaves the copy to the field', async () => {
    const { select } = await mount();
    await select();
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    await act(async () => field.dispatchEvent(event));
    field.remove();
    expect(event.defaultPrevented).toBe(false);
});

test('⌘X copies the chart and deletes it as one undo step; a viewer’s only copies', async () => {
    const { select, charts, undo } = await mount();
    await select();
    const { clipboardData } = await shortcut('KeyX');
    expect(readEigenClipboard(clipboardData)?.items).toHaveLength(1);
    expect(charts()).toEqual([]);
    await undo();
    expect(charts()).toEqual([chart]);

    const viewer = await mount({ allowEdit: false });
    await viewer.select();
    const cut = await shortcut('KeyX');
    expect(readEigenClipboard(cut.clipboardData)?.items).toHaveLength(1);
    expect(viewer.charts()).toEqual([chart]);
});

test('⌘V in the workbook the chart came from pastes a duplicate linked to its cells, one undo step', async () => {
    const { select, charts, undo } = await mount();
    await select();
    const { clipboardData } = await shortcut('KeyC');
    const { event } = await shortcut('KeyV', clipboardData);
    expect(event.defaultPrevented).toBe(true);
    const pasted = charts().find((c) => c.id !== 'c1');
    expect(pasted).toMatchObject({ width: 400, height: 300, spec: chart.spec });
    await undo();
    expect(charts()).toEqual([chart]);
});

test('⌘X then ⌘V in the same workbook moves the chart and keeps its ranges', async () => {
    const { select, charts } = await mount();
    await select();
    const { clipboardData } = await shortcut('KeyX');
    expect(charts()).toEqual([]);
    // The cut chart's focus went with it; the cell input takes the paste.
    (document.querySelector<HTMLElement>('#sheet-rich-text-editor') ?? document.body).focus();
    const { event } = await shortcut('KeyV', clipboardData);
    expect(event.defaultPrevented).toBe(true);
    expect(charts().map((c) => c.spec)).toEqual([chart.spec]);
});

test('⌘V in another workbook pastes the inline chart', async () => {
    const source = await mount();
    await source.select();
    const { clipboardData } = await shortcut('KeyC');
    const inline = readEigenClipboard(clipboardData)?.items[0];
    await cleanups.shift()?.();

    const target = await mount();
    await target.select();
    await shortcut('KeyV', clipboardData);
    const pasted = target.charts().find((c) => c.id !== 'c1');
    expect(inline?.type === 'chart' && pasted?.spec).toBe(inline?.type === 'chart' ? inline.spec : '');
});

test('a chart item another app wrote pastes as an inline chart at its size', async () => {
    const spec = JSON.stringify(sampleChartSpec('pie'));
    const item = buildChartClipboardItem({ spec, box: { width: 320.5, height: 200 }, look: {} });
    if (!item) throw new Error('no item');
    const clipboardData = new DataTransfer();
    writeEigenClipboard(new ClipboardEvent('copy', { clipboardData }), { version: 1, items: [item] });
    const { select, charts } = await mount();
    await select();
    await shortcut('KeyV', clipboardData);
    expect(charts().find((c) => c.id !== 'c1')).toMatchObject({ spec, width: 320.5, height: 200 });
});

test('⌘C carries the look the chart stores, and a chart storing none copies flat', async () => {
    const rough = await mount({ look: ROUGH });
    await rough.select();
    const { clipboardData } = await shortcut('KeyC');
    expect(readEigenClipboard(clipboardData)?.items[0]).toMatchObject({ type: 'chart', look: ROUGH });
    await cleanups.shift()?.();

    const flat = await mount();
    await flat.select();
    const copied = await shortcut('KeyC');
    expect(readEigenClipboard(copied.clipboardData)?.items[0]).toMatchObject({ look: FLAT_CHART_LOOK });
});

test('a chart from Docs or Vector pastes with its look and copies back out with it', async () => {
    const spec = JSON.stringify(sampleChartSpec('column'));
    const item = buildChartClipboardItem({ spec, box: { width: 320, height: 200 }, look: ROUGH });
    if (!item) throw new Error('no item');
    const clipboardData = new DataTransfer();
    writeEigenClipboard(new ClipboardEvent('copy', { clipboardData }), { version: 1, items: [item] });
    const { select, charts } = await mount();
    await select();
    await shortcut('KeyV', clipboardData);
    const pasted = charts().find((c) => c.id !== 'c1');
    expect(pasted && readChartLook(pasted)).toEqual(ROUGH);

    const back = await shortcut('KeyC');
    expect(readEigenClipboard(back.clipboardData)?.items[0]).toMatchObject({ type: 'chart', spec, look: ROUGH });
});
