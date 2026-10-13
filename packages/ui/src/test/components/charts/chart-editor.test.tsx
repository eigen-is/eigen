import { afterEach, describe, expect, test } from 'bun:test';
import { chartColor, sampleChartSpec } from '@workspace/lib/charts';
import { EIGEN_FONT_NAMES } from '@workspace/lib/constants/fonts';
import type { ChartSpec, ChartType } from '@workspace/lib/types/chart';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PropertyGestureContext } = await import('../../../components/properties-panel');
const { ChartEditor } = await import('../../../components/charts');

// React reads an input's value off its own tracker, so the native setter is what a keystroke looks like.
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

// Mounts the editor over `spec`, feeding every change back in as the new spec, as a host does; `resolved` is
// what a sheet passes for a range chart.
async function mount(
    spec: ChartSpec,
    beginGesture?: () => () => void,
    resolved: { categories?: string[]; seriesNames?: string[] } = {},
) {
    const changes: ChartSpec[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let current = spec;
    const draw = async () => {
        const editor = createElement(ChartEditor, {
            spec: current,
            ...resolved,
            onChange: (next: ChartSpec) => {
                changes.push(next);
                current = next;
                void draw();
            },
        });
        await act(async () => {
            root.render(
                beginGesture ? createElement(PropertyGestureContext.Provider, { value: beginGesture }, editor) : editor,
            );
        });
    };
    await draw();
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const sectionTitles = () => [...container.querySelectorAll('h4')].map((h) => h.textContent);
    const rowLabels = () => [...container.querySelectorAll('span.w-14')].map((span) => span.textContent?.trim() ?? '');
    const input = (placeholder: string) => {
        const found = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
        if (!found) throw new Error(`no "${placeholder}" field; saw ${rowLabels().join(', ')}`);
        return found;
    };
    const type = async (placeholder: string, value: string) => {
        const field = input(placeholder);
        await act(async () => {
            field.focus();
            setValue?.call(field, value);
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const blur = async (placeholder: string) => {
        const field = input(placeholder);
        await act(async () => field.dispatchEvent(new Event('focusout', { bubbles: true })));
    };
    // A row's control sits beside its label span.
    const row = (label: string) => {
        const span = [...container.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === label);
        const control = span?.nextElementSibling;
        if (!control) throw new Error(`no "${label}" row; saw ${rowLabels().join(', ')}`);
        return control as HTMLElement;
    };
    const choose = async (label: string, option: string) => {
        const trigger = row(label).querySelector('[data-slot="select-trigger"]');
        if (!trigger) throw new Error(`"${label}" is not a select`);
        await act(async () => {
            trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
        const item = [...(list?.querySelectorAll('[role="option"]') ?? [])].find(
            (el) => el.textContent?.trim() === option,
        );
        if (!item) throw new Error(`no "${option}" option under "${label}"`);
        await act(async () => {
            item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const options = async (label: string) => {
        const trigger = row(label).querySelector('[data-slot="select-trigger"]');
        await act(async () => {
            trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
        const texts = [...(list?.querySelectorAll('[role="option"]') ?? [])].map((el) => el.textContent?.trim());
        await act(async () => {
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        return texts;
    };
    // The Font row is the canvas text box's picker, a dropdown menu of the Eigen fonts.
    const fonts = async () => {
        await act(async () => {
            row('Font')
                .querySelector('button[aria-haspopup="menu"]')
                ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        });
        return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
    };
    const last = () => {
        const change = changes.at(-1);
        if (!change) throw new Error('the editor wrote nothing');
        return change;
    };
    return { changes, last, sectionTitles, rowLabels, input, type, blur, row, choose, options, fonts };
}

const sample = (type: ChartType) => sampleChartSpec(type);

describe('ChartEditor', () => {
    test("offers Google's four types in its Insert order and writes the one chosen", async () => {
        const editor = await mount(sample('column'));
        expect(await editor.options('Type')).toEqual(['Bar', 'Column', 'Line', 'Pie']);
        await editor.choose('Type', 'Bar');
        expect(editor.last().type).toBe('bar');
    });

    test('a switch to pie gives every category a slice color', async () => {
        const editor = await mount(sample('column'));
        await editor.choose('Type', 'Pie');
        expect(editor.last().type).toBe('pie');
        expect(editor.last().sliceColors).toEqual([0, 1, 2, 3].map(chartColor));
    });

    test('stacking shows for column and bar, writes the flag, and is gone for line and pie', async () => {
        const column = await mount(sample('column'));
        expect(column.rowLabels()).toContain('Stacking');
        expect(await column.options('Stacking')).toEqual(['None', 'Stacked']);
        await column.choose('Stacking', 'Stacked');
        expect(column.last().stacked).toBe(true);

        expect((await mount(sample('bar'))).rowLabels()).toContain('Stacking');
        expect((await mount(sample('line'))).rowLabels()).not.toContain('Stacking');
        expect((await mount(sample('pie'))).rowLabels()).not.toContain('Stacking');
    });

    test("the Font row shows the spec's font, offers the Eigen fonts and writes the one picked, once", async () => {
        const editor = await mount({ ...sample('line'), fontFamily: 'Excalifont' });
        expect(editor.row('Font').textContent).toBe('Excalifont');
        const items = await editor.fonts();
        expect(items.map((item) => item.textContent)).toEqual([...EIGEN_FONT_NAMES]);
        const mono = items.find((item) => item.textContent === 'JetBrains Mono');
        await act(async () => mono?.click());
        expect(editor.changes).toEqual([{ ...sample('line'), fontFamily: 'JetBrains Mono' }]);
    });

    test('the chart title writes the title', async () => {
        const editor = await mount(sample('column'));
        await editor.type('Chart title', 'Revenue');
        expect(editor.last().title).toBe('Revenue');
    });

    test('a column chart titles its category axis horizontally and its value axis vertically', async () => {
        const editor = await mount(sample('column'));
        expect(editor.sectionTitles()).toEqual(['Chart', 'Horizontal axis', 'Vertical axis', 'Series']);
        await editor.type('Horizontal axis title', 'Team');
        expect(editor.last().categoryAxis.title).toBe('Team');
        await editor.type('Vertical axis title', 'Points');
        expect(editor.last().valueAxis.title).toBe('Points');
    });

    test('a bar chart turns the axes: its horizontal axis is the value axis', async () => {
        const editor = await mount(sample('bar'));
        await editor.type('Horizontal axis title', 'Points');
        expect(editor.last().valueAxis.title).toBe('Points');
        expect(editor.last().categoryAxis.title).toBe('');
        await editor.type('Vertical axis title', 'Team');
        expect(editor.last().categoryAxis.title).toBe('Team');
    });

    test('min and max sit with the value axis, and an emptied one is auto again', async () => {
        const column = await mount(sample('column'));
        // Vertical for a column chart, so the vertical section holds them.
        expect(column.rowLabels()).toEqual(expect.arrayContaining(['Min', 'Max', 'Gridlines']));
        await column.type('Auto', '10');
        expect(column.last().valueAxis.min).toBe(10);
        await column.type('Auto', '');
        expect(column.last().valueAxis.min).toBeNull();
    });

    test('a max at or below the min is not written', async () => {
        const editor = await mount({ ...sample('line'), valueAxis: { ...sample('line').valueAxis, min: 50 } });
        const max = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Auto"]')].at(-1);
        if (!max) throw new Error('no Max field');
        await act(async () => {
            max.focus();
            setValue?.call(max, '40');
            max.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(editor.changes).toEqual([]);
        await act(async () => {
            setValue?.call(max, '400');
            max.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(editor.last().valueAxis).toMatchObject({ min: 50, max: 400 });
    });

    test('legend positions follow Google, and None hides it', async () => {
        const editor = await mount(sample('column'));
        expect(await editor.options('Legend')).toEqual(['Top', 'Bottom', 'Left', 'Right', 'None']);
        await editor.choose('Legend', 'None');
        expect(editor.last().legend).toBe('none');
    });

    test('the gridlines box turns the value gridlines off', async () => {
        const editor = await mount(sample('column'));
        const box = editor.row('Gridlines').querySelector('button[role="checkbox"]');
        if (!box) throw new Error('no Gridlines checkbox');
        await act(async () => box.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(editor.last().valueAxis.gridlines).toBe(false);
    });

    test('a pie has no axes; it colors its slices by category instead of its series', async () => {
        const editor = await mount(sample('pie'));
        expect(editor.sectionTitles()).toEqual(['Chart', 'Slices']);
        expect(editor.rowLabels()).toEqual(expect.arrayContaining(['Team 1', 'Team 2', 'Team 3', 'Team 4']));
        expect(editor.rowLabels()).not.toContain('Period 1');
    });

    test("a range chart's slices take the categories its sheet resolved", async () => {
        const ref = { sheetId: 's1', row: [1, 3] as [number, number], column: [1, 1] as [number, number] };
        const series = { name: 'Points', values: ref, color: chartColor(0), markers: false, smooth: false };
        const range: ChartSpec = { ...sample('column'), data: { source: 'range', categories: null, series: [series] } };
        const editor = await mount(range, undefined, { categories: ['Ajax', 'PSV', ''] });
        await editor.choose('Type', 'Pie');
        expect(editor.last().sliceColors).toEqual([0, 1, 2].map(chartColor));
        expect(editor.rowLabels()).toEqual(expect.arrayContaining(['Ajax', 'PSV', 'Slice 3']));
    });

    test('a series color row is named for its series and writes that series alone', async () => {
        const editor = await mount(sample('column'));
        expect(editor.rowLabels()).toEqual(expect.arrayContaining(['Period 1', 'Period 2']));
        const trigger = editor.row('Period 2').querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title]');
        if (!swatch) throw new Error('the color popover has no swatch');
        await act(async () => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const [first, second] = editor.last().data.series;
        expect(first.color).toBe(sample('column').data.series[0].color);
        expect(second.color).not.toBe(sample('column').data.series[1].color);
    });

    test("a range chart's series rows take the names its sheet resolved, and a deleted series has none", async () => {
        const ref = (column: number) => ({
            sheetId: 's1',
            row: [1, 4] as [number, number],
            column: [column, column] as [number, number],
        });
        const name = (column: number) => ({ ...ref(column), row: [0, 0] as [number, number] });
        const style = (i: number) => ({ color: chartColor(i), markers: false, smooth: false });
        const range: ChartSpec = {
            ...sample('column'),
            data: {
                source: 'range',
                categories: null,
                series: [
                    { ...style(0), name: name(1), values: ref(1) },
                    { ...style(1), name: '', values: null },
                    { ...style(2), name: name(2), values: ref(2) },
                ],
            },
        };
        const editor = await mount(range, undefined, { seriesNames: ['North', '', 'East'] });
        const series = editor.rowLabels().slice(-2);
        expect(series).toEqual(['North', 'East']);
        const trigger = editor.row('East').querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title]');
        if (!swatch) throw new Error('the color popover has no swatch');
        await act(async () => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(editor.last().data.series.map((s) => s.color)).toEqual([chartColor(0), chartColor(1), swatch.title]);
    });

    test('a title typed letter by letter is one gesture, released when the field is left', async () => {
        let opened = 0;
        let released = 0;
        const editor = await mount(sample('column'), () => {
            opened += 1;
            return () => {
                released += 1;
            };
        });
        for (const typed of ['P', 'Po', 'Poi']) await editor.type('Chart title', typed);
        expect(editor.changes.map((spec) => spec.title)).toEqual(['P', 'Po', 'Poi']);
        expect([opened, released]).toEqual([1, 0]);
        await editor.blur('Chart title');
        expect([opened, released]).toEqual([1, 1]);
    });
});
