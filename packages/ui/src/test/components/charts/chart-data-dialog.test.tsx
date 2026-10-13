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

// The sample: series Period 1 and Period 2 across row 1, Team 1 to Team 4 down column A.
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

type KeyOptions = { shiftKey?: boolean; metaKey?: boolean };

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
    const find = (selector: string) => {
        const found = dialog().querySelector<HTMLElement>(selector);
        if (!found) throw new Error(`nothing matches ${selector}`);
        return found;
    };
    // Grid coordinates, as the sheet shows them less one: row 0 is the series names (row 1), column 0
    // the categories (column A).
    const cell = (row: number, column: number) =>
        find(`[role="row"][aria-rowindex="${row + 2}"] > [aria-colindex="${column + 2}"]`);
    const columnHeader = (label: string) =>
        [...dialog().querySelectorAll<HTMLElement>('[role="columnheader"]')].find((el) => el.textContent === label);
    const rowHeader = (label: string) =>
        [...dialog().querySelectorAll<HTMLElement>('[role="rowheader"]')].find((el) => el.textContent === label);
    const editor = () => {
        const found = dialog().querySelector('input');
        if (!found) throw new Error('the grid has no cell editor');
        return found;
    };
    // The grid's size as shown: the header strip, then the sheet's rows, the trailing one included.
    const shown = () => {
        const gridEl = find('[role="grid"]');
        return {
            rows: Number(gridEl.getAttribute('aria-rowcount')) - 1,
            columns: Number(gridEl.getAttribute('aria-colcount')) - 1,
        };
    };
    const highlighted = (role: 'columnheader' | 'rowheader') =>
        [...dialog().querySelectorAll<HTMLElement>(`[role="${role}"][aria-selected="true"]`)].map(
            (el) => el.textContent,
        );

    const key = async (name: string, { shiftKey = false, metaKey = false }: KeyOptions = {}) => {
        const event = new KeyboardEvent('keydown', { key: name, shiftKey, metaKey, bubbles: true, cancelable: true });
        await act(async () => editor().dispatchEvent(event));
        return event.defaultPrevented;
    };
    // What a keystroke the browser types into the focused editor looks like to React.
    const type = async (value: string) => {
        const input = editor();
        await act(async () => {
            setValue?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const mouseDown = async (target: HTMLElement | undefined, shiftKey = false) => {
        if (!target) throw new Error('no target');
        await act(async () =>
            target.dispatchEvent(
                new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey, buttons: 1 }),
            ),
        );
    };
    const doubleClick = async (target: HTMLElement) => {
        await act(async () => target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    };
    const select = (row: number, column: number) => mouseDown(cell(row, column));
    const clipboardEvent = (kind: 'copy' | 'paste', data: Record<string, string>) => {
        const event = new Event(kind, { bubbles: true, cancelable: true });
        Object.assign(event, {
            clipboardData: {
                getData: (format: string) => data[format] ?? '',
                setData: (format: string, value: string) => {
                    data[format] = value;
                },
            },
        });
        return event;
    };
    const paste = async (row: number, column: number, data: Record<string, string>) => {
        await select(row, column);
        await act(async () => editor().dispatchEvent(clipboardEvent('paste', data)));
    };
    const copy = async () => {
        const data: Record<string, string> = {};
        await act(async () => editor().dispatchEvent(clipboardEvent('copy', data)));
        return data;
    };
    const button = (label: string) => {
        const found = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
            (el) => el.textContent?.trim() === label,
        );
        if (!found) throw new Error(`no "${label}" button`);
        return found;
    };
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
    return {
        saved,
        openChanges,
        dialog,
        cell,
        columnHeader,
        rowHeader,
        editor,
        shown,
        highlighted,
        key,
        type,
        mouseDown,
        doubleClick,
        select,
        paste,
        copy,
        button,
        click,
        save,
    };
}

describe('ChartDataDialog: the grid', () => {
    test("opens as a sheet of the chart's data: series across row 1, categories down column A", async () => {
        const dialog = await open(sample());
        expect([dialog.cell(0, 1).textContent, dialog.cell(0, 2).textContent]).toEqual(['Period 1', 'Period 2']);
        expect(dialog.cell(1, 0).textContent).toBe('Team 1');
        expect(dialog.cell(1, 1).textContent).toBe('42');
        expect(dialog.cell(0, 0).textContent).toBe('');
        // A trailing row and column to grow into: D and 6.
        expect(dialog.shown()).toEqual({ rows: 6, columns: 4 });
        expect(dialog.columnHeader('D')).toBeDefined();
        expect(dialog.rowHeader('6')).toBeDefined();
    });

    test('the selected cell highlights its row and column headers; Shift extends a range', async () => {
        const dialog = await open(sample());
        await dialog.select(2, 1);
        expect(dialog.editor().getAttribute('aria-label')).toBe('B3');
        expect(dialog.highlighted('columnheader')).toEqual(['B']);
        expect(dialog.highlighted('rowheader')).toEqual(['3']);
        await dialog.key('ArrowRight', { shiftKey: true });
        await dialog.key('ArrowDown', { shiftKey: true });
        expect(dialog.highlighted('columnheader')).toEqual(['B', 'C']);
        expect(dialog.highlighted('rowheader')).toEqual(['3', '4']);
        await dialog.mouseDown(dialog.cell(4, 0), true);
        expect(dialog.highlighted('columnheader')).toEqual(['A', 'B']);
        expect(dialog.highlighted('rowheader')).toEqual(['3', '4', '5']);
    });

    test('Save writes the grid once, Cancel nothing', async () => {
        const dialog = await open(sample());
        await dialog.click(dialog.button('Cancel'));
        expect(dialog.saved).toEqual([]);
        expect(dialog.openChanges).toEqual([false]);

        const again = await open(sample());
        const spec = await again.save();
        expect(again.saved).toHaveLength(1);
        expect(spec.data).toEqual(sample().data);
        expect(spec.title).toBe('Points scored');
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

describe('ChartDataDialog: the keyboard is Sheets', () => {
    test('typing replaces the cell; Enter commits and moves down', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 1);
        await dialog.type('7');
        await dialog.type('75');
        expect(dialog.editor().value).toBe('75');
        expect(await dialog.key('Enter')).toBe(true);
        expect(dialog.cell(1, 1).textContent).toBe('75');
        expect(dialog.editor().getAttribute('aria-label')).toBe('B3');
        expect(dialog.editor().value).toBe('');
        expect((await dialog.save()).data.series[0].values).toEqual([75, 65, 38, 80]);
    });

    test('Tab commits and moves right, Shift+Tab left; arrows move', async () => {
        const dialog = await open(sample());
        await dialog.select(0, 1);
        await dialog.type('First half');
        await dialog.key('Tab');
        expect(dialog.editor().getAttribute('aria-label')).toBe('C1');
        await dialog.type('Second half');
        await dialog.key('Tab', { shiftKey: true });
        expect(dialog.editor().getAttribute('aria-label')).toBe('B1');
        await dialog.key('ArrowDown');
        await dialog.key('ArrowLeft');
        expect(dialog.editor().getAttribute('aria-label')).toBe('A2');
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['First half', 'Second half']);
    });

    test('an arrow commits a typed cell and moves', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 0);
        await dialog.type('Blues');
        await dialog.key('ArrowDown');
        expect(dialog.cell(1, 0).textContent).toBe('Blues');
        expect(dialog.editor().getAttribute('aria-label')).toBe('A3');
    });

    test('F2 and a double-click edit in place, keeping the value', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 1);
        await dialog.key('F2');
        expect(dialog.editor().value).toBe('42');
        // In place, an arrow moves the caret, not the cell.
        expect(await dialog.key('ArrowLeft')).toBe(false);
        await dialog.type('420');
        await dialog.key('Enter');
        expect(dialog.cell(1, 1).textContent).toBe('420');

        await dialog.doubleClick(dialog.cell(2, 2));
        expect(dialog.editor().value).toBe('47');
        expect(dialog.editor().getAttribute('aria-label')).toBe('C3');
    });

    test('Escape cancels the edit and leaves the dialog open; a second Escape closes it', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 1);
        await dialog.type('99');
        await dialog.key('Escape');
        expect(dialog.openChanges).toEqual([]);
        expect(dialog.cell(1, 1).textContent).toBe('42');
        expect(dialog.editor().value).toBe('');
        await dialog.key('Escape');
        expect(dialog.openChanges).toEqual([false]);
    });

    test('Delete and Backspace clear the selected cells to gaps', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 1);
        await dialog.key('ArrowDown', { shiftKey: true });
        await dialog.key('ArrowRight', { shiftKey: true });
        await dialog.key('Delete');
        await dialog.select(1, 0);
        await dialog.key('Backspace');
        const spec = await dialog.save();
        expect(spec.data.series[0].values).toEqual([null, null, 38, 80]);
        expect(spec.data.series[1].values).toEqual([null, null, 71, 63]);
        expect(spec.data.categories).toEqual(['', 'Team 2', 'Team 3', 'Team 4']);
    });

    test('a row header selects the row, and Delete removes it with its slice color', async () => {
        const pie = { ...sample('pie'), sliceColors: ['#000001', '#000002', '#000003', '#000004'] };
        const dialog = await open(pie);
        await dialog.mouseDown(dialog.rowHeader('3'));
        // The pie has one series, so B and the trailing C.
        expect(dialog.highlighted('columnheader')).toEqual(['A', 'B', 'C']);
        await dialog.key('Delete');
        const spec = await dialog.save();
        expect(spec.data.categories).toEqual(['Team 1', 'Team 3', 'Team 4']);
        expect(spec.sliceColors).toEqual(['#000001', '#000003', '#000004']);
    });

    test('a column header selects the column, and Delete removes its series', async () => {
        const dialog = await open(sample());
        await dialog.mouseDown(dialog.columnHeader('B'));
        expect(dialog.highlighted('rowheader')).toEqual(['1', '2', '3', '4', '5', '6']);
        await dialog.key('Delete');
        expect((await dialog.save()).data.series.map((series) => series.name)).toEqual(['Period 2']);
    });

    test('⌘C copies the selection as TSV and an HTML table', async () => {
        const dialog = await open(sample());
        await dialog.select(0, 0);
        await dialog.key('ArrowRight', { shiftKey: true });
        await dialog.key('ArrowDown', { shiftKey: true });
        const data = await dialog.copy();
        expect(data['text/plain']).toBe('\tPeriod 1\nTeam 1\t42');
        expect(data['text/html']).toBe(
            '<table><tr><td></td><td>Period 1</td></tr><tr><td>Team 1</td><td>42</td></tr></table>',
        );
    });
});

describe('ChartDataDialog: growing the grid', () => {
    test('typing in the trailing row adds a category with gaps and a slice color', async () => {
        const dialog = await open(sample('pie'));
        await dialog.select(5, 0);
        await dialog.type('Team 5');
        await dialog.key('Enter');
        expect(dialog.shown()).toEqual({ rows: 7, columns: 3 });
        expect(dialog.editor().getAttribute('aria-label')).toBe('A7');
        const spec = await dialog.save();
        expect(spec.data.categories.at(-1)).toBe('Team 5');
        expect(spec.data.series[0].values.at(-1)).toBeNull();
        expect(spec.sliceColors).toEqual([0, 1, 2, 3, 4].map(chartColor));
    });

    test('typing in the trailing column adds a palette-colored series', async () => {
        const dialog = await open(sample());
        await dialog.select(2, 3);
        await dialog.type('5');
        await dialog.key('Enter');
        expect(dialog.shown()).toEqual({ rows: 6, columns: 5 });
        const spec = await dialog.save();
        expect(spec.data.series[2]).toEqual({
            ...style,
            color: chartColor(2),
            name: '',
            values: [null, 5, null, null],
        });
    });

    test('a trailing cell left empty adds nothing', async () => {
        const dialog = await open(sample());
        await dialog.select(5, 0);
        await dialog.key('F2');
        await dialog.key('Enter');
        expect(dialog.shown()).toEqual({ rows: 6, columns: 4 });
    });

    test('no trailing row or column past the series, category and total limits', async () => {
        const wide = await open(grid(INLINE_GRID_MAX_SERIES, 2));
        expect(wide.shown()).toEqual({ rows: 4, columns: INLINE_GRID_MAX_SERIES + 1 });

        const tall = await open(grid(1, INLINE_GRID_MAX_CATEGORIES));
        expect(tall.shown()).toEqual({ rows: INLINE_GRID_MAX_CATEGORIES + 1, columns: 3 });

        // 11 × 180 = 1,980 cells; one more series would be 2,160, past the 2,000-point limit.
        const full = await open(grid(11, 180));
        expect(full.shown()).toEqual({ rows: 182, columns: 12 });
    });

    test('a value that is not a number is flagged and keeps Save off', async () => {
        const dialog = await open(sample());
        await dialog.select(1, 1);
        await dialog.type('lots');
        await dialog.key('Enter');
        expect(dialog.cell(1, 1).getAttribute('aria-invalid')).toBe('true');
        expect(dialog.button('Save').disabled).toBe(true);
        expect(dialog.dialog().textContent).toContain('Values must be numbers.');
        await dialog.select(1, 1);
        await dialog.type('7');
        await dialog.key('Enter');
        expect(dialog.button('Save').disabled).toBe(false);

        // Save with such a value still open flags it rather than writing it.
        await dialog.select(2, 2);
        await dialog.type('many');
        await dialog.click(dialog.button('Save'));
        expect(dialog.saved).toEqual([]);
        expect(dialog.cell(2, 2).getAttribute('aria-invalid')).toBe('true');
    });
});

describe('ChartDataDialog: paste fits the grid', () => {
    test('pasted TSV fills from the active cell and grows the grid', async () => {
        const dialog = await open(sample());
        await dialog.paste(1, 1, { 'text/plain': '1\t2\t3\n4\t5\t6\n7\t8\t9\n10\t11\t12\n13\t14\t15\n' });
        expect(dialog.shown()).toEqual({ rows: 7, columns: 5 });
        await dialog.paste(0, 1, { 'text/plain': 'A\tB\tC' });
        await dialog.paste(1, 0, { 'text/plain': 'North\r\nSouth' });
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['A', 'B', 'C']);
        expect(spec.data.series[2]).toMatchObject({ color: chartColor(2), values: [3, 6, 9, 12, 15] });
        expect(spec.data.categories).toEqual(['North', 'South', 'Team 3', 'Team 4', '']);
    });

    test("a spreadsheet's HTML table pastes when its plain text has no tabs", async () => {
        const dialog = await open(sample());
        await dialog.paste(0, 0, {
            'text/plain': 'MonthNorthJan10',
            'text/html': '<table><tr><td></td><td>North</td></tr><tr><td>Jan</td><td>10</td></tr></table>',
        });
        const spec = await dialog.save();
        expect(spec.data.series[0]).toMatchObject({ name: 'North', values: [10, 65, 38, 80] });
        expect(spec.data.categories[0]).toBe('Jan');
    });

    test('a single value pastes into the selected cell', async () => {
        const dialog = await open(sample());
        await dialog.paste(1, 1, { 'text/plain': '12' });
        expect(dialog.cell(1, 1).textContent).toBe('12');
    });

    test('a paste stops at the limits and says how much it held', async () => {
        const dialog = await open(sample());
        const names = Array.from({ length: INLINE_GRID_MAX_SERIES + 3 }, (_, i) => `S${i}`).join('\t');
        await dialog.paste(0, 1, { 'text/plain': names });
        expect(dialog.shown().columns).toBe(INLINE_GRID_MAX_SERIES + 1);
        expect(dialog.dialog().textContent).toContain('Pasted 1 row × 15 columns; the chart holds up to 12 series');

        const rows = await open(grid(1, 2));
        const values = Array.from({ length: INLINE_GRID_MAX_CATEGORIES + 5 }, (_, i) => i).join('\n');
        await rows.paste(1, 1, { 'text/plain': values });
        expect(rows.shown().rows).toBe(INLINE_GRID_MAX_CATEGORIES + 1);
        expect(rows.dialog().textContent).toContain('Pasted 205 rows × 1 column;');
    });

    test('a pasted label is cut to the label limit', async () => {
        const dialog = await open(sample());
        await dialog.paste(0, 1, { 'text/plain': `${'x'.repeat(MAX_CHART_LABEL_LENGTH + 50)}\tB` });
        expect((await dialog.save()).data.series[0].name).toHaveLength(MAX_CHART_LABEL_LENGTH);
    });
});
