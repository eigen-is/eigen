import { afterEach, describe, expect, test } from 'bun:test';
import {
    chartColor,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { ChartSpec, InlineChartData } from '@workspace/lib/types/chart';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChartDataDialog } = await import('../../../components/charts');

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const style = { markers: false, smooth: false };

type InlineSpec = ChartSpec & { data: InlineChartData };

function sample(type: 'column' | 'pie' = 'column'): InlineSpec {
    const spec = sampleChartSpec(type);
    if (spec.data.source !== 'inline') throw new Error('the sample is inline');
    return { ...spec, data: spec.data };
}

function grid(seriesCount: number, rows: number): InlineSpec {
    return {
        ...sample(),
        data: {
            source: 'inline',
            categories: Array.from({ length: rows }, (_, i) => `C${i}`),
            series: Array.from({ length: seriesCount }, (_, j) => ({
                ...style,
                color: chartColor(j),
                name: `S${j}`,
                values: Array.from({ length: rows }, (_, i) => i),
            })),
        },
    };
}

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

async function open(spec: InlineSpec) {
    const saved: ChartSpec[] = [];
    const openChanges: boolean[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(ChartDataDialog, {
                spec,
                open: true,
                onOpenChange: (next: boolean) => openChanges.push(next),
                onSave: (next: ChartSpec) => saved.push(next),
            }),
        );
    });
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const dialog = () => {
        const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
        if (!found) throw new Error('the dialog is not open');
        return found;
    };
    const table = () => {
        const found = dialog().querySelector('table');
        if (!found) throw new Error('the dialog has no grid');
        return found;
    };
    // Grid coordinates: row 0 is the series names, column 0 the category names.
    const cell = (row: number, column: number) => {
        const input = table().rows[row]?.cells[column]?.querySelector('input');
        if (!input) throw new Error(`no input at ${row}, ${column}`);
        return input;
    };
    const size = () => ({
        series: table().rows[0].querySelectorAll('input').length,
        rows: table().rows.length - 1,
    });
    const type = async (row: number, column: number, value: string) => {
        const input = cell(row, column);
        await act(async () => {
            input.focus();
            setValue?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const paste = async (row: number, column: number, text: string) => {
        const input = cell(row, column);
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.assign(event, { clipboardData: { getData: (kind: string) => (kind === 'text/plain' ? text : '') } });
        await act(async () => input.dispatchEvent(event));
    };
    const button = (label: string) => {
        const found = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
            (el) => el.textContent?.trim() === label || el.getAttribute('aria-label') === label,
        );
        if (!found) throw new Error(`no "${label}" button`);
        return found;
    };
    const buttons = (label: string) =>
        [...dialog().querySelectorAll<HTMLButtonElement>('button')].filter(
            (el) => el.getAttribute('aria-label') === label,
        );
    const click = async (target: HTMLButtonElement) => {
        await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    };
    const save = async () => {
        await click(button('Save'));
        const last = saved.at(-1);
        if (!last) throw new Error('Save wrote nothing');
        if (last.data.source !== 'inline') throw new Error('Save wrote range data');
        return { ...last, data: last.data };
    };
    return { saved, openChanges, dialog, cell, size, type, paste, button, buttons, click, save };
}

describe('ChartDataDialog', () => {
    test("opens on the chart's data: series across, categories down", async () => {
        const dialog = await open(sample());
        expect(dialog.size()).toEqual({ series: 2, rows: 4 });
        expect([dialog.cell(0, 1).value, dialog.cell(0, 2).value]).toEqual(['Period 1', 'Period 2']);
        expect(dialog.cell(1, 0).value).toBe('Team 1');
        expect(dialog.cell(1, 1).value).toBe('42');
    });

    test('Save writes the edited grid once; an emptied cell is a gap', async () => {
        const dialog = await open(sample());
        await dialog.type(1, 1, '12.5');
        await dialog.type(2, 2, '');
        await dialog.type(0, 1, 'First half');
        await dialog.type(3, 0, 'Blues');
        const spec = await dialog.save();
        expect(dialog.saved).toHaveLength(1);
        expect(spec.data.series[0]).toMatchObject({ name: 'First half', values: [12.5, 65, 38, 80] });
        expect(spec.data.series[1].values).toEqual([58, null, 71, 63]);
        expect(spec.data.categories).toEqual(['Team 1', 'Team 2', 'Blues', 'Team 4']);
        expect(spec.title).toBe('Points scored');
        expect(dialog.openChanges).toEqual([false]);
    });

    test('a value that is not a number is flagged and keeps Save off', async () => {
        const dialog = await open(sample());
        await dialog.type(1, 1, 'lots');
        expect(dialog.cell(1, 1).getAttribute('aria-invalid')).toBe('true');
        expect(dialog.button('Save').disabled).toBe(true);
        await dialog.type(1, 1, '7');
        expect(dialog.button('Save').disabled).toBe(false);
    });

    test('Cancel closes and writes nothing', async () => {
        const dialog = await open(sample());
        await dialog.type(1, 1, '99');
        await dialog.click(dialog.button('Cancel'));
        expect(dialog.saved).toEqual([]);
        expect(dialog.openChanges).toEqual([false]);
    });

    test('a new row is an empty category with gaps and a slice color; a new column a palette-colored series', async () => {
        const dialog = await open(sample('pie'));
        await dialog.click(dialog.button('Add row'));
        await dialog.click(dialog.button('Add column'));
        expect(dialog.size()).toEqual({ series: 2, rows: 5 });
        const spec = await dialog.save();
        expect(spec.data.categories.at(-1)).toBe('');
        expect(spec.data.series[0].values.at(-1)).toBeNull();
        expect(spec.data.series[1]).toEqual({ ...style, color: chartColor(1), name: '', values: Array(5).fill(null) });
        expect(spec.sliceColors).toEqual([0, 1, 2, 3, 4].map(chartColor));
    });

    test('removing a row takes its slice color with it; removing a column its series', async () => {
        const pie = { ...sample('pie'), sliceColors: ['#000001', '#000002', '#000003', '#000004'] };
        const dialog = await open(pie);
        await dialog.click(dialog.buttons('Remove row')[1]);
        const spec = await dialog.save();
        expect(spec.data.categories).toEqual(['Team 1', 'Team 3', 'Team 4']);
        expect(spec.sliceColors).toEqual(['#000001', '#000003', '#000004']);

        const columns = await open(sample());
        await columns.click(columns.buttons('Remove column')[0]);
        expect((await columns.save()).data.series.map((series) => series.name)).toEqual(['Period 2']);
    });

    test('pasted tab-separated text fills the grid from the cell and grows it', async () => {
        const dialog = await open(sample());
        await dialog.paste(1, 1, '1\t2\t3\n4\t5\t6\n7\t8\t9\n10\t11\t12\n13\t14\t15\n');
        expect(dialog.size()).toEqual({ series: 3, rows: 5 });
        await dialog.paste(0, 1, 'A\tB\tC');
        await dialog.paste(1, 0, 'North\r\nSouth');
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['A', 'B', 'C']);
        expect(spec.data.series[2]).toMatchObject({ color: chartColor(2), values: [3, 6, 9, 12, 15] });
        expect(spec.data.categories).toEqual(['North', 'South', 'Team 3', 'Team 4', '']);
    });

    test('a paste stops at the series and category limits and says so', async () => {
        const dialog = await open(sample());
        const names = Array.from({ length: INLINE_GRID_MAX_SERIES + 3 }, (_, i) => `S${i}`).join('\t');
        await dialog.paste(0, 1, names);
        expect(dialog.size().series).toBe(INLINE_GRID_MAX_SERIES);
        expect(dialog.dialog().textContent).toContain("Some pasted cells didn't fit");

        const rows = await open(grid(1, 2));
        await rows.paste(1, 1, Array.from({ length: INLINE_GRID_MAX_CATEGORIES + 5 }, (_, i) => i).join('\n'));
        expect(rows.size().rows).toBe(INLINE_GRID_MAX_CATEGORIES);
    });

    test('Add column and Add row stop at the series, category and total limits', async () => {
        const wide = await open(grid(INLINE_GRID_MAX_SERIES, 2));
        expect(wide.button('Add column').disabled).toBe(true);
        expect(wide.button('Add row').disabled).toBe(false);

        const tall = await open(grid(1, INLINE_GRID_MAX_CATEGORIES));
        expect(tall.button('Add row').disabled).toBe(true);
        expect(tall.button('Add column').disabled).toBe(false);

        // 11 × 180 = 1,980 cells; one more series would be 2,160, past the 2,000-point limit.
        const full = await open(grid(11, 180));
        expect(full.button('Add column').disabled).toBe(true);
        expect(full.button('Add row').disabled).toBe(false);
    });

    test('a pasted label is cut to the label limit', async () => {
        const dialog = await open(sample());
        await dialog.paste(0, 1, `${'x'.repeat(MAX_CHART_LABEL_LENGTH + 50)}\tB`);
        expect((await dialog.save()).data.series[0].name).toHaveLength(MAX_CHART_LABEL_LENGTH);
    });

    test('a chart past the grid limits opens read-only with a note', async () => {
        const dialog = await open(grid(INLINE_GRID_MAX_SERIES + 1, 3));
        expect(dialog.dialog().querySelectorAll('input')).toHaveLength(0);
        expect(dialog.dialog().textContent).toContain('read-only');
        expect(dialog.dialog().textContent).toContain('S12');
        expect([...dialog.dialog().querySelectorAll('button')].map((el) => el.textContent?.trim())).not.toContain(
            'Save',
        );
    });
});
