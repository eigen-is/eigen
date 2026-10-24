import { afterEach, describe, expect, test } from 'bun:test';
import {
    applyChartSpecChange,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    parseChartSpec,
    readChartSpec,
} from '@workspace/lib/charts';
import type { ChartSpec, ChartSpecChange, InlineChartData, StoredChartSpec } from '@workspace/lib/types/chart';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChartDataDialog } = await import('../../../components/charts');

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

type InlineSpec = ChartSpec & { data: InlineChartData };

// The grid's own data, not Insert → Chart's sample: series Period 1 and Period 2 across row 1, Team 1 to Team 4
// down column A, A1 empty. A pie keeps the first series, as a new pie does.
function scores(type: 'column' | 'pie' = 'column'): InlineSpec {
    const periods = [
        { id: 's-1', name: 'Period 1', values: [42, 65, 38, 80] },
        { id: 's-2', name: 'Period 2', values: [58, 47, 71, 63] },
    ];
    const data: InlineChartData = {
        source: 'inline',
        categories: ['Team 1', 'Team 2', 'Team 3', 'Team 4'],
        series: type === 'pie' ? periods.slice(0, 1) : periods,
    };
    return { ...defaultChartSpec(type, data), title: { text: 'Points scored' }, data };
}

// The scores with a category axis title, which A1 shows.
function titled(text: string): InlineSpec {
    const spec = scores();
    return { ...spec, axes: { ...spec.axes, x: { ...spec.axes.x, title: { text } } } };
}

// A pie whose slices each have a color, beside a key this build doesn't know.
function coloredPie(): InlineSpec {
    const colors = ['#000001', '#000002', '#000003', '#000004'];
    return {
        ...scores('pie'),
        points: { 's-1': Object.fromEntries(colors.map((color, i) => [i, { color, future: color }])) },
    };
}

function grid(seriesCount: number, rows: number): InlineSpec {
    const data: InlineChartData = {
        source: 'inline',
        categories: Array.from({ length: rows }, (_, i) => `C${i}`),
        series: Array.from({ length: seriesCount }, (_, j) => ({
            id: `s-${j}`,
            name: `S${j}`,
            values: Array.from({ length: rows }, (_, i) => i),
        })),
    };
    return { ...scores(), series: defaultChartSpec('column', data).series, data };
}

type KeyOptions = { shiftKey?: boolean; metaKey?: boolean };

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

// The dialog over a host that stores `raw`, the spec itself unless a test stores what the type forbids. Save applies
// its change onto what the host stores then, as every host does, and keeps the spec that reads back.
async function open(spec: InlineSpec, raw: object = spec) {
    const saved: ChartSpec[] = [];
    const changes: ChartSpecChange[] = [];
    const openChanges: boolean[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let stored: StoredChartSpec = readChartSpec(JSON.stringify(raw)).stored;
    // A rerender is the host's spec changing under the open dialog, a peer's edit.
    const rerender = async (next: InlineSpec, nextRaw: object = next) => {
        stored = readChartSpec(JSON.stringify(nextRaw)).stored;
        await act(async () => {
            root.render(
                createElement(ChartDataDialog, {
                    spec: next,
                    stored,
                    open: true,
                    onOpenChange: (change: boolean) => openChanges.push(change),
                    onSave: (change: ChartSpecChange) => {
                        changes.push(change);
                        stored = applyChartSpecChange(stored, change);
                        const read = parseChartSpec(JSON.stringify(stored));
                        if (read) saved.push(read);
                    },
                }),
            );
        });
    };
    await rerender(spec, raw);
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
    // happy-dom lays nothing out, so a test sets the scroller's height and scroll offset itself.
    const scroll = async (scrollTop: number, clientHeight: number) => {
        const el = find('[role="grid"]').parentElement;
        if (!el) throw new Error('the grid has no scroller');
        Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
        Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true });
        await act(async () => el.dispatchEvent(new Event('scroll')));
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
        changes,
        stored: () => JSON.parse(JSON.stringify(stored)),
        openChanges,
        rerender,
        dialog,
        cell,
        columnHeader,
        rowHeader,
        editor,
        shown,
        scroll,
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
        const dialog = await open(scores());
        expect([dialog.cell(0, 1).textContent, dialog.cell(0, 2).textContent]).toEqual(['Period 1', 'Period 2']);
        expect(dialog.cell(1, 0).textContent).toBe('Team 1');
        expect(dialog.cell(1, 1).textContent).toBe('42');
        expect(dialog.cell(0, 0).textContent).toBe('');
        // Every column a series can go in, A to M, and a trailing row to grow into.
        expect(dialog.shown()).toEqual({ rows: 6, columns: INLINE_GRID_MAX_SERIES + 1 });
        expect(dialog.columnHeader('M')).toBeDefined();
        expect(dialog.columnHeader('N')).toBeUndefined();
        expect(dialog.rowHeader('6')).toBeDefined();
        // A1 is selected, as a sheet opens.
        expect(dialog.editor().getAttribute('aria-label')).toBe('A1');
    });

    test('empty rows fill the view and more come as it scrolls, up to the category limit', async () => {
        const dialog = await open(scores());
        await dialog.scroll(0, 400);
        // Two views' worth of 20px rows, so there is always more to scroll into.
        expect(dialog.shown()).toEqual({ rows: 40, columns: INLINE_GRID_MAX_SERIES + 1 });
        await dialog.scroll(400, 400);
        expect(dialog.shown().rows).toBe(60);
        await dialog.scroll(10_000, 400);
        expect(dialog.shown().rows).toBe(INLINE_GRID_MAX_CATEGORIES + 1);
    });

    test('the cell editor names the cell and what it holds; the corner is a column header', async () => {
        const dialog = await open(scores());
        await dialog.select(1, 1);
        expect(dialog.editor().getAttribute('aria-label')).toBe('B2: 42');
        await dialog.select(5, 1);
        expect(dialog.editor().getAttribute('aria-label')).toBe('B6');
        const corner = dialog.dialog().querySelector('[role="row"][aria-rowindex="1"] > :first-child');
        expect(corner?.getAttribute('role')).toBe('columnheader');
    });

    test('the selected cell highlights its row and column headers; Shift extends a range', async () => {
        const dialog = await open(scores());
        await dialog.select(2, 1);
        expect(dialog.editor().getAttribute('aria-label')).toBe('B3: 65');
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

    // The header of the categories column, as in Google.
    test('A1 shows the category axis title and types it', async () => {
        const dialog = await open(titled('Teams'));
        expect(dialog.cell(0, 0).textContent).toBe('Teams');
        expect(dialog.editor().getAttribute('aria-label')).toBe('A1: Teams');
        await dialog.type('Squads');
        await dialog.key('Enter');
        expect(dialog.cell(0, 0).textContent).toBe('Squads');
        expect((await dialog.save()).axes.x.title.text).toBe('Squads');
    });

    test("Save leaves a peer's category axis title alone when A1 did not change", async () => {
        const dialog = await open(titled('Teams'));
        await dialog.rerender(titled('Squads'));
        await dialog.select(1, 1);
        await dialog.type('7');
        expect((await dialog.save()).axes.x.title.text).toBe('Squads');
    });

    test('Save writes the grid once, Cancel nothing', async () => {
        const dialog = await open(scores());
        await dialog.click(dialog.button('Cancel'));
        expect(dialog.saved).toEqual([]);
        expect(dialog.openChanges).toEqual([false]);

        const again = await open(scores());
        const spec = await again.save();
        expect(again.saved).toHaveLength(1);
        expect(spec.data).toEqual(scores().data);
        expect(spec.title.text).toBe('Points scored');
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

describe('ChartDataDialog: Save is a change', () => {
    test('Save writes only what the grid changed, so what the chart stores beside it stays', async () => {
        const spec = scores();
        const dialog = await open(spec, { ...spec, future: 1, legend: { position: 'inside' } });
        await dialog.select(1, 1);
        await dialog.type('7');
        await dialog.key('Enter');
        await dialog.click(dialog.button('Save'));
        expect(dialog.changes).toEqual([
            [
                {
                    op: 'set',
                    path: ['data', 'series'],
                    value: [{ ...spec.data.series[0], values: [7, 65, 38, 80] }, spec.data.series[1]],
                },
            ],
        ]);
        expect(dialog.stored()).toMatchObject({ future: 1, legend: { position: 'inside' } });
    });

    test('deleting series 1 keeps series 2 under its id, with its colour', async () => {
        const [, second] = scores().data.series;
        const green = { ...DEFAULT_CHART_SERIES_STYLE, color: '#00ff00' };
        const dialog = await open({ ...scores(), series: { ...scores().series, 's-2': green } });
        await dialog.mouseDown(dialog.columnHeader('B'));
        await dialog.key('Delete');
        const spec = await dialog.save();
        expect(spec.data.series).toEqual([second]);
        expect(spec.series).toEqual({ 's-2': green });
    });

    test('a stored key on the data or on a series this build does not read opens the grid read-only', async () => {
        const spec = scores();
        const sizes = spec.data.series.map((s, i) => (i === 1 ? { ...s, sizes: [1, 2, 3, 4] } : s));
        for (const raw of [
            { ...spec, data: { ...spec.data, series: sizes } },
            { ...spec, data: { ...spec.data, future: 1 } },
        ]) {
            const dialog = await open(spec, raw);
            expect(dialog.dialog().querySelectorAll('input')).toHaveLength(0);
            expect(dialog.dialog().textContent).toContain('made in a newer version of Eigen');
            expect(dialog.dialog().textContent).toContain('Period 2');
        }
        const plain = await open(spec, {
            ...spec,
            future: 1,
            axes: { ...spec.axes, y: { ...spec.axes.y, logBase: 10 } },
        });
        expect(plain.dialog().querySelectorAll('input')).toHaveLength(1);
    });

    test("a peer's series colour, slice colour and title while the dialog is open survive Save", async () => {
        const dialog = await open(scores());
        const peer: InlineSpec = {
            ...scores(),
            title: { text: 'Peer title' },
            series: { ...scores().series, 's-2': { ...DEFAULT_CHART_SERIES_STYLE, color: '#00ff00' } },
            points: { 's-1': { 1: { color: '#000002' } } },
        };
        await dialog.rerender(peer);
        await dialog.select(1, 1);
        await dialog.type('7');
        await dialog.key('Enter');
        const spec = await dialog.save();
        expect(spec.title.text).toBe('Peer title');
        expect(spec.points).toEqual({ 's-1': { 1: { color: '#000002' } } });
        expect(spec.data.series.map((s) => [spec.series[s.id].color, s.values[0]])).toEqual([
            [null, 7],
            ['#00ff00', 58],
        ]);
    });

    test("a peer's slice colour past a deleted row moves with its row", async () => {
        const dialog = await open(scores('pie'));
        await dialog.rerender({ ...scores('pie'), points: { 's-1': { 3: { color: '#000004' } } } });
        await dialog.mouseDown(dialog.rowHeader('2'));
        await dialog.key('Delete');
        const spec = await dialog.save();
        expect(spec.data.categories).toEqual(['Team 2', 'Team 3', 'Team 4']);
        expect(spec.points).toEqual({ 's-1': { 2: { color: '#000004' } } });
    });

    test('a stored point past the rows, or on a series the data does not name, moves with a deleted row', async () => {
        const pie = scores('pie');
        const dialog = await open(pie, { ...pie, points: { 's-1': { 9: { color: '#000009' } }, other: { 1: {} } } });
        await dialog.mouseDown(dialog.rowHeader('2'));
        await dialog.key('Delete');
        await dialog.save();
        expect(dialog.stored().points).toEqual({ 's-1': { 8: { color: '#000009' } }, other: { 0: {} } });
    });
});

describe('ChartDataDialog: the keyboard is Sheets', () => {
    test('typing replaces the cell; Enter commits and moves down', async () => {
        const dialog = await open(scores());
        await dialog.select(1, 1);
        await dialog.type('7');
        await dialog.type('75');
        expect(dialog.editor().value).toBe('75');
        expect(await dialog.key('Enter')).toBe(true);
        expect(dialog.cell(1, 1).textContent).toBe('75');
        expect(dialog.editor().getAttribute('aria-label')).toBe('B3: 65');
        expect(dialog.editor().value).toBe('');
        expect((await dialog.save()).data.series[0].values).toEqual([75, 65, 38, 80]);
    });

    test('Tab commits and moves right, Shift+Tab left; arrows move', async () => {
        const dialog = await open(scores());
        await dialog.select(0, 1);
        await dialog.type('First half');
        await dialog.key('Tab');
        expect(dialog.editor().getAttribute('aria-label')).toBe('C1: Period 2');
        await dialog.type('Second half');
        await dialog.key('Tab', { shiftKey: true });
        expect(dialog.editor().getAttribute('aria-label')).toBe('B1: First half');
        await dialog.key('ArrowDown');
        await dialog.key('ArrowLeft');
        expect(dialog.editor().getAttribute('aria-label')).toBe('A2: Team 1');
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['First half', 'Second half']);
    });

    test('an arrow commits a typed cell and moves', async () => {
        const dialog = await open(scores());
        await dialog.select(1, 0);
        await dialog.type('Blues');
        await dialog.key('ArrowDown');
        expect(dialog.cell(1, 0).textContent).toBe('Blues');
        expect(dialog.editor().getAttribute('aria-label')).toBe('A3: Team 2');
    });

    test('F2 and a double-click edit in place, keeping the value', async () => {
        const dialog = await open(scores());
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
        expect(dialog.editor().getAttribute('aria-label')).toBe('C3: 47');
    });

    test('Escape cancels the edit and leaves the dialog open; a second Escape closes it', async () => {
        const dialog = await open(scores());
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
        const dialog = await open(scores());
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

    test('a row header selects the row, and Delete removes it with its points, the rows after keeping theirs', async () => {
        const dialog = await open(coloredPie());
        await dialog.mouseDown(dialog.rowHeader('3'));
        expect(dialog.highlighted('columnheader')).toEqual(
            Array.from({ length: INLINE_GRID_MAX_SERIES + 1 }, (_, i) => String.fromCharCode(65 + i)),
        );
        await dialog.key('Delete');
        const spec = await dialog.save();
        expect(spec.data.categories).toEqual(['Team 1', 'Team 3', 'Team 4']);
        expect(spec.points).toEqual({
            's-1': { 0: { color: '#000001' }, 1: { color: '#000003' }, 2: { color: '#000004' } },
        });
        // Each point moves whole, so what this build doesn't read on it goes along.
        expect(JSON.parse(JSON.stringify(dialog.stored())).points['s-1']).toEqual({
            0: { color: '#000001', future: '#000001' },
            1: { color: '#000003', future: '#000003' },
            2: { color: '#000004', future: '#000004' },
        });
    });

    test('a column header selects the column, and Delete removes its series', async () => {
        const dialog = await open(scores());
        await dialog.mouseDown(dialog.columnHeader('B'));
        expect(dialog.highlighted('rowheader')).toEqual(['1', '2', '3', '4', '5', '6']);
        await dialog.key('Delete');
        expect((await dialog.save()).data.series.map((series) => series.name)).toEqual(['Period 2']);
    });

    test('⌘C copies the selection as TSV and an HTML table', async () => {
        const dialog = await open(scores());
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
    test('typing in the trailing row adds a category with gaps and an automatic slice color', async () => {
        const dialog = await open(scores('pie'));
        await dialog.select(5, 0);
        await dialog.type('Team 5');
        await dialog.key('Enter');
        expect(dialog.shown().rows).toBe(7);
        expect(dialog.editor().getAttribute('aria-label')).toBe('A7');
        const spec = await dialog.save();
        expect(spec.data.categories.at(-1)).toBe('Team 5');
        expect(spec.data.series[0].values.at(-1)).toBeNull();
        expect(spec.points).toEqual({});
    });

    test('typing in the trailing column adds a series in an automatic color, under a new id', async () => {
        const dialog = await open(scores());
        await dialog.select(2, 3);
        await dialog.type('5');
        await dialog.key('Enter');
        const spec = await dialog.save();
        const { id, ...added } = spec.data.series[2];
        expect(added).toEqual({ name: '', values: [null, 5, null, null] });
        expect(id).toMatch(/^s-[A-Za-z0-9_-]{10}$/);
        expect(spec.series[id]).toEqual(DEFAULT_CHART_SERIES_STYLE);
        expect(spec.data.series.slice(0, 2).map((series) => series.id)).toEqual(['s-1', 's-2']);
    });

    test('a trailing cell left empty adds nothing', async () => {
        const dialog = await open(scores());
        await dialog.select(5, 0);
        await dialog.key('F2');
        await dialog.key('Enter');
        expect(dialog.shown().rows).toBe(6);
        expect((await dialog.save()).data.categories).toHaveLength(4);
    });

    test('typing further down adds the rows between as gaps', async () => {
        const dialog = await open(scores());
        await dialog.scroll(0, 400);
        await dialog.select(9, 0);
        await dialog.type('Team 9');
        await dialog.key('Enter');
        const spec = await dialog.save();
        expect(spec.data.categories).toEqual(['Team 1', 'Team 2', 'Team 3', 'Team 4', '', '', '', '', 'Team 9']);
        expect(spec.data.series[0].values.slice(4)).toEqual([null, null, null, null, null]);
    });

    test('no row past the category limit, and a value past the total limit says it was left out', async () => {
        const tall = await open(grid(1, INLINE_GRID_MAX_CATEGORIES));
        expect(tall.shown()).toEqual({ rows: INLINE_GRID_MAX_CATEGORIES + 1, columns: INLINE_GRID_MAX_SERIES + 1 });

        // 11 × 180 = 1,980 cells; a twelfth series would be 2,160, past the 2,000-point limit.
        const full = await open(grid(11, 180));
        await full.select(1, 12);
        await full.type('5');
        await full.key('Enter');
        expect(full.cell(1, 12).textContent).toBe('');
        expect(full.dialog().textContent).toContain('The chart holds up to 12 series');
        expect((await full.save()).data.series).toHaveLength(11);
    });

    test('a value that is not a number is flagged and keeps Save off', async () => {
        const dialog = await open(scores());
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

describe('ChartDataDialog: numbers as Sheets shows them', () => {
    test('grouping, a leading currency symbol and a trailing percent read as numbers', async () => {
        const dialog = await open(scores());
        await dialog.paste(1, 1, { 'text/plain': '$1,234.00\n1,234\n12%\n-€5.5' });
        expect(dialog.button('Save').disabled).toBe(false);
        expect((await dialog.save()).data.series[0].values).toEqual([1234, 1234, 0.12, -5.5]);
    });

    test('a percent is its share without float noise, and an exponent reads', async () => {
        const dialog = await open(scores());
        // 33.3 / 100 is 0.33299999999999996 in floating point.
        await dialog.paste(1, 1, { 'text/plain': '33.3%\n1.5E3\n-2e-2' });
        expect((await dialog.save()).data.series[0].values.slice(0, 3)).toEqual([0.333, 1500, -0.02]);
    });

    test('anything else is still flagged', async () => {
        for (const text of ['1,23', '12%%', '$', '1.2.3', '12 apples', '%5', '0x10', '0b11', '$0x10', '0x10%']) {
            const dialog = await open(scores());
            await dialog.paste(1, 1, { 'text/plain': text });
            expect(dialog.button('Save').disabled).toBe(true);
        }
    });
});

describe('ChartDataDialog: paste fits the grid', () => {
    test('pasted TSV fills from the active cell and grows the grid', async () => {
        const dialog = await open(scores());
        await dialog.paste(1, 1, { 'text/plain': '1\t2\t3\n4\t5\t6\n7\t8\t9\n10\t11\t12\n13\t14\t15\n' });
        expect(dialog.shown().rows).toBe(7);
        await dialog.paste(0, 1, { 'text/plain': 'A\tB\tC' });
        await dialog.paste(1, 0, { 'text/plain': 'North\r\nSouth' });
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['A', 'B', 'C']);
        expect(spec.data.series[2]).toMatchObject({ values: [3, 6, 9, 12, 15] });
        expect(spec.data.categories).toEqual(['North', 'South', 'Team 3', 'Team 4', '']);
    });

    test("a spreadsheet's HTML table pastes when its plain text has no tabs", async () => {
        const dialog = await open(scores());
        await dialog.paste(0, 0, {
            'text/plain': 'MonthNorthJan10',
            'text/html': '<table><tr><td></td><td>North</td></tr><tr><td>Jan</td><td>10</td></tr></table>',
        });
        const spec = await dialog.save();
        expect(spec.data.series[0]).toMatchObject({ name: 'North', values: [10, 65, 38, 80] });
        expect(spec.data.categories[0]).toBe('Jan');
    });

    test("a Docs table pastes as its HTML table, not as its plain text's lines", async () => {
        const dialog = await open(scores());
        await dialog.paste(0, 1, {
            'text/plain': 'North\n\nSouth\n\n1\n\n2',
            'text/html':
                '<table><tbody><tr><th><p>North</p></th><th><p>South</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>',
        });
        const spec = await dialog.save();
        expect(spec.data.series.map((series) => series.name)).toEqual(['North', 'South']);
        expect(spec.data.series.map((series) => series.values[0])).toEqual([1, 2]);
    });

    test('lines of plain text with no table paste down a column', async () => {
        const dialog = await open(scores());
        await dialog.paste(1, 0, { 'text/plain': 'North\nSouth' });
        expect((await dialog.save()).data.categories.slice(0, 2)).toEqual(['North', 'South']);
    });

    test('a pasted corner header titles the category axis, and shows in A1', async () => {
        const dialog = await open(titled('Teams'));
        await dialog.paste(0, 0, { 'text/plain': 'Month\tNorth\nJan\t10' });
        expect(dialog.cell(0, 0).textContent).toBe('Month');
        const spec = await dialog.save();
        expect(spec.axes.x.title.text).toBe('Month');
        expect(spec.data.series[0]).toMatchObject({ name: 'North', values: [10, 65, 38, 80] });
    });

    test('a single value pastes into the selected cell', async () => {
        const dialog = await open(scores());
        await dialog.paste(1, 1, { 'text/plain': '12' });
        expect(dialog.cell(1, 1).textContent).toBe('12');
    });

    test('a paste stops at the limits and says how much it held', async () => {
        const dialog = await open(scores());
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

    // Past what a spread call holds (Chrome stops near 125,000 arguments, Bun near a million).
    test('a paste of a million rows fills what fits and says how much it held', async () => {
        const dialog = await open(scores());
        const values = Array.from({ length: 1_000_000 }, (_, i) => `${i}\t${i}`).join('\n');
        await dialog.paste(1, 1, { 'text/plain': values });
        expect(dialog.dialog().textContent).toContain('Pasted 1,000,000 rows × 2 columns;');
        const spec = await dialog.save();
        expect(spec.data.categories).toHaveLength(INLINE_GRID_MAX_CATEGORIES);
        expect(spec.data.series[0].values.slice(0, 2)).toEqual([0, 1]);
    });

    test('a pasted label is cut to the label limit', async () => {
        const dialog = await open(scores());
        await dialog.paste(0, 1, { 'text/plain': `${'x'.repeat(MAX_CHART_LABEL_LENGTH + 50)}\tB` });
        expect((await dialog.save()).data.series[0].name).toHaveLength(MAX_CHART_LABEL_LENGTH);
    });
});
