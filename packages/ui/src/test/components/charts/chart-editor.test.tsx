import { afterEach, describe, expect, test } from 'bun:test';
import { chartColor, sampleChartSpec } from '@workspace/lib/charts';
import { EIGEN_FONT_NAMES } from '@workspace/lib/constants/fonts';
import type { ChartSpec, ChartType } from '@workspace/lib/types/chart';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PropertyGestureContext, PropertyHistoryContext } = await import('../../../components/properties-panel');
const { ChartEditor } = await import('../../../components/charts');

// React reads an input's value off its own tracker, so the native setter is what a keystroke looks like.
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

// Mounts the editor over `spec`, feeding every change back in as the new spec, as a host does; `host` is what
// a sheet passes for a range chart, or the Docs app's own Edit data.
async function mount(
    spec: ChartSpec,
    beginGesture?: () => () => void,
    host: { categories?: string[]; seriesNames?: string[]; onEditData?: () => void } = {},
    history: { undo: () => void; redo: () => void } | null = null,
) {
    const changes: ChartSpec[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let current = spec;
    const draw = async () => {
        const editor = createElement(ChartEditor, {
            spec: current,
            ...host,
            onChange: (next: ChartSpec) => {
                changes.push(next);
                current = next;
                void draw();
            },
        });
        await act(async () => {
            const held = createElement(PropertyHistoryContext.Provider, { value: history }, editor);
            root.render(
                beginGesture ? createElement(PropertyGestureContext.Provider, { value: beginGesture }, held) : held,
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
    // A box's label sits beside it, outside the row label column.
    const boxLabels = () =>
        [...container.querySelectorAll('label')]
            .filter((label) => label.querySelector('button[role="checkbox"]'))
            .map((label) => label.textContent?.trim() ?? '');
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
    // The keydown, returned so a test can see whether the browser's own handling of it was prevented.
    const press = async (placeholder: string, init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        await act(async () => input(placeholder).dispatchEvent(event));
        return event;
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
    // The Automatic row of a color row's popover, absent while the color is automatic.
    const automatic = async (label: string) => {
        const trigger = row(label).querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const popover = [...document.querySelectorAll('[data-slot="popover-content"]')].at(-1);
        const found = [...(popover?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
            (button) => button.textContent === 'Automatic',
        );
        if (!found) {
            await act(async () => {
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
        }
        return found;
    };
    const button = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === label);
    const click = async (name: string) => {
        const box = container.querySelector(`button[role="checkbox"][aria-label="${name}"]`);
        if (!box) throw new Error(`no "${name}" checkbox`);
        await act(async () => box.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    };
    const last = () => {
        const change = changes.at(-1);
        if (!change) throw new Error('the editor wrote nothing');
        return change;
    };
    return {
        changes,
        last,
        sectionTitles,
        rowLabels,
        boxLabels,
        input,
        type,
        press,
        blur,
        row,
        choose,
        options,
        fonts,
        automatic,
        button,
        click,
    };
}

const sample = (type: ChartType) => sampleChartSpec(type);

describe('ChartEditor', () => {
    test("offers Google's four types in its Insert order and writes the one chosen", async () => {
        const editor = await mount(sample('column'));
        expect(await editor.options('Type')).toEqual(['Bar', 'Column', 'Line', 'Pie']);
        await editor.choose('Type', 'Bar');
        expect(editor.last().type).toBe('bar');
    });

    test('a switch to pie leaves its slices on the palette', async () => {
        const editor = await mount(sample('column'));
        await editor.choose('Type', 'Pie');
        expect(editor.changes).toEqual([{ ...sample('column'), type: 'pie' }]);
    });

    test("a switch between bar and any other type sets the category axis back to Google's direction, in the same change", async () => {
        const reversed = (type: ChartType): ChartSpec => {
            const spec = sample(type);
            return { ...spec, categoryAxis: { ...spec.categoryAxis, reversed: true } };
        };
        const bar = await mount(reversed('bar'));
        await bar.choose('Type', 'Column');
        expect(bar.changes).toEqual([
            { ...reversed('bar'), type: 'column', categoryAxis: { ...reversed('bar').categoryAxis, reversed: false } },
        ]);
        const column = await mount(reversed('column'));
        await column.choose('Type', 'Bar');
        expect(column.last().categoryAxis.reversed).toBe(false);
        const line = await mount(reversed('column'));
        await line.choose('Type', 'Line');
        expect(line.changes).toEqual([{ ...reversed('column'), type: 'line' }]);
    });

    test('stacking shows for column and bar, writes the grouping, and is gone for line and pie', async () => {
        const column = await mount(sample('column'));
        expect(column.rowLabels()).toContain('Stacking');
        expect(await column.options('Stacking')).toEqual(['None', 'Standard', '100%']);
        await column.choose('Stacking', '100%');
        expect(column.last().stacking).toBe('percent');
        await column.choose('Stacking', 'Standard');
        expect(column.last().stacking).toBe('stacked');
        await column.choose('Stacking', 'None');
        expect(column.last().stacking).toBe('none');

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
        expect(editor.last().categoryAxis.title).toBe('Wavelength (nm)');
        await editor.type('Vertical axis title', 'Team');
        expect(editor.last().categoryAxis.title).toBe('Team');
    });

    test('min and max sit with the value axis, and an emptied one is auto again', async () => {
        const column = await mount(sample('column'));
        // Vertical for a column chart, so the vertical section holds them.
        expect(column.rowLabels()).toEqual(expect.arrayContaining(['Min', 'Max']));
        expect(column.boxLabels()).toContain('Gridlines');
        await column.type('Auto', '10');
        expect(column.last().valueAxis.min).toBe(10);
        await column.type('Auto', '');
        expect(column.last().valueAxis.min).toBeNull();
    });

    // A 100% stack stores its min and max as fractions, Excel's c:min and c:max, and the editor shows percents.
    test('under a 100% stack, min and max read and write as percents', async () => {
        const percent: ChartSpec = {
            ...sample('column'),
            stacking: 'percent',
            valueAxis: { ...sample('column').valueAxis, max: 0.07 },
        };
        const editor = await mount(percent);
        const [min, max] = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Auto"]')];
        expect(max.value).toBe('7');
        await act(async () => {
            max.focus();
            setValue?.call(max, '100');
            max.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(editor.last().valueAxis.max).toBe(1);
        await act(async () => {
            min.focus();
            setValue?.call(min, '-20');
            min.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(editor.last().valueAxis).toMatchObject({ min: -0.2, max: 1 });
        // 33.3 / 100 is 0.33299999999999996 in floating point.
        await act(async () => {
            setValue?.call(max, '33.3');
            max.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(editor.last().valueAxis.max).toBe(0.333);
    });

    // A raw max of 100 would be 10,000% under a 100% stack, and a share of 1 a raw 1 out of it.
    test('a switch to or from a 100% stack sets min and max back to auto, in the same change', async () => {
        const bounded = { ...sample('column').valueAxis, min: 0, max: 100 };
        const raw = await mount({ ...sample('column'), valueAxis: bounded });
        await raw.choose('Stacking', 'Standard');
        expect(raw.last().valueAxis).toMatchObject({ min: 0, max: 100 });
        await raw.choose('Stacking', '100%');
        expect(raw.changes).toHaveLength(2);
        expect(raw.last()).toMatchObject({ stacking: 'percent', valueAxis: { min: null, max: null } });

        const shares = { ...sample('column').valueAxis, min: 0, max: 1 };
        const percent = await mount({ ...sample('column'), stacking: 'percent', valueAxis: shares });
        await percent.choose('Stacking', 'None');
        expect(percent.changes).toHaveLength(1);
        expect(percent.last()).toMatchObject({ stacking: 'none', valueAxis: { min: null, max: null } });
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
        await editor.click('Vertical axis: Gridlines');
        expect(editor.last().valueAxis.gridlines).toBe(false);
    });

    test('each axis section shows or hides its axis, one write a click', async () => {
        const column = await mount(sample('column'));
        await column.click('Horizontal axis: Show axis');
        expect(column.changes).toEqual([
            { ...sample('column'), categoryAxis: { ...sample('column').categoryAxis, visible: false } },
        ]);
        await column.click('Vertical axis: Show axis');
        expect(column.last().valueAxis.visible).toBe(false);
        expect(column.changes).toHaveLength(2);

        // A bar chart lies on its side, so its vertical section holds the category axis.
        const bar = await mount(sample('bar'));
        await bar.click('Vertical axis: Show axis');
        expect(bar.last().categoryAxis.visible).toBe(false);
        await bar.click('Horizontal axis: Show axis');
        expect(bar.last().valueAxis.visible).toBe(false);
    });

    test("the category axis's section reverses its order, one write a click", async () => {
        const column = await mount(sample('column'));
        // Google's words, each beside its box, the category axis's section first.
        expect(column.boxLabels()).toEqual(['Show axis', 'Reverse axis order', 'Show axis', 'Gridlines']);
        await column.click('Horizontal axis: Reverse axis order');
        expect(column.changes).toEqual([
            { ...sample('column'), categoryAxis: { ...sample('column').categoryAxis, reversed: true } },
        ]);
        const bar = await mount(sample('bar'));
        await bar.click('Vertical axis: Reverse axis order');
        expect(bar.last().categoryAxis.reversed).toBe(true);
        expect(bar.boxLabels().filter((label) => label === 'Reverse axis order')).toHaveLength(1);
    });

    test('a pie has no axes; it colors its slices by category instead of its series', async () => {
        const editor = await mount(sample('pie'));
        expect(editor.sectionTitles()).toEqual(['Chart', 'Slices']);
        expect(editor.rowLabels()).toEqual(
            expect.arrayContaining(['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000']),
        );
        expect(editor.rowLabels()).not.toContain('Sun');
    });

    test("inline data offers Edit data, whose Save is one write; a host's own Edit data opens nothing here", async () => {
        const editor = await mount(sample('column'));
        const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
        const press = (target: HTMLElement | null | undefined) =>
            act(async () => target?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await press(editor.button('Edit data'));
        const save = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
            (el) => el.textContent?.trim() === 'Save',
        );
        await press(save);
        expect(editor.changes).toHaveLength(1);
        expect(dialog()).toBeNull();

        let asked = 0;
        const docs = await mount(sample('column'), undefined, {
            onEditData: () => {
                asked += 1;
            },
        });
        await press(docs.button('Edit data'));
        expect(asked).toBe(1);
        expect(dialog()).toBeNull();
    });

    test('range data has no Edit data, as its grid is the sheet', async () => {
        const ref = { sheetId: 's1', row: [1, 3] as [number, number], column: [1, 1] as [number, number] };
        const series = { name: 'Points', values: ref, color: chartColor(0), markers: false, smooth: false };
        const range: ChartSpec = { ...sample('column'), data: { source: 'range', categories: null, series: [series] } };
        expect((await mount(range)).button('Edit data')).toBeUndefined();
    });

    test("a range chart's slices take the categories its sheet resolved", async () => {
        const ref = { sheetId: 's1', row: [1, 3] as [number, number], column: [1, 1] as [number, number] };
        const series = { name: 'Points', values: ref, color: chartColor(0), markers: false, smooth: false };
        const range: ChartSpec = { ...sample('column'), data: { source: 'range', categories: null, series: [series] } };
        const editor = await mount(range, undefined, { categories: ['Ajax', 'PSV', ''] });
        await editor.choose('Type', 'Pie');
        expect(editor.rowLabels()).toEqual(expect.arrayContaining(['Ajax', 'PSV', 'Slice 3']));
    });

    test('a series color row is named for its series and writes that series alone', async () => {
        const editor = await mount(sample('column'));
        expect(editor.rowLabels()).toEqual(expect.arrayContaining(['Sun', 'Bulb (incandescent)', 'Hot star']));
        const trigger = editor.row('Bulb (incandescent)').querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title^="#"]');
        if (!swatch) throw new Error('the color popover has no swatch');
        await act(async () => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const [first, second] = editor.last().data.series;
        expect(first.color).toBeNull();
        expect(second.color).toBe(swatch.title);
    });

    test('an automatic color shows its palette color and says Automatic; a picked one resets to it in one write', async () => {
        const picked = sample('column');
        if (picked.data.source !== 'inline') throw new Error('the sample is inline');
        const [first, second, ...rest] = picked.data.series;
        const spec: ChartSpec = {
            ...picked,
            data: { ...picked.data, series: [first, { ...second, color: '#123456' }, ...rest] },
        };
        const editor = await mount(spec);
        expect(editor.row('Sun').textContent).toBe('Automatic');
        expect(editor.row('Sun').querySelector<HTMLElement>('div')?.style.backgroundColor).toBeTruthy();
        expect(editor.row('Bulb (incandescent)').textContent).toBe('#123456');
        const reset = await editor.automatic('Bulb (incandescent)');
        if (!reset) throw new Error('a picked color offers no Automatic');
        await act(async () => reset.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(editor.changes).toEqual([picked]);
        expect(editor.row('Bulb (incandescent)').textContent).toBe('Automatic');
        expect(await editor.automatic('Sun')).toBeUndefined();
    });

    // Marked as the current color, the palette swatch an automatic color draws in would pin it unseen.
    test("an automatic color's popover marks no swatch as the current one", async () => {
        const editor = await mount(sample('column'));
        const trigger = editor.row('Sun').querySelector('button');
        await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const popover = [...document.querySelectorAll('[data-slot="popover-content"]')].at(-1);
        const swatches = [...(popover?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        expect(swatches.some((swatch) => swatch.style.backgroundColor !== '')).toBe(true);
        const marked = swatches.filter((swatch) => swatch.style.backgroundColor && swatch.querySelector('svg'));
        expect(marked.map((swatch) => swatch.title)).toEqual([]);
    });

    test('a picked slice color resets to the palette in one write', async () => {
        const editor = await mount({ ...sample('pie'), sliceColors: [null, '#123456'] });
        expect(editor.row('400–500').textContent).toBe('#123456');
        expect(editor.row('500–600').textContent).toBe('Automatic');
        const reset = await editor.automatic('400–500');
        await act(async () => reset?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(editor.changes.map((spec) => spec.sliceColors)).toEqual([[null, null, null, null, null, null, null]]);
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
        const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title^="#"]');
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

    test("⌘Z in a typed title ends its gesture and runs the host's undo instead of the field's own", async () => {
        let released = 0;
        const undone: string[] = [];
        const editor = await mount(
            sample('column'),
            () => () => {
                released += 1;
            },
            {},
            { undo: () => undone.push('undo'), redo: () => undone.push('redo') },
        );
        for (const typed of ['P', 'Po', 'Poi']) await editor.type('Chart title', typed);
        expect((await editor.press('Chart title', { key: 'z', metaKey: true })).defaultPrevented).toBe(true);
        expect((await editor.press('Chart title', { key: 'y', ctrlKey: true })).defaultPrevented).toBe(true);
        expect(undone).toEqual(['undo', 'redo']);
        expect(released).toBe(1);
    });

    test("without a host history, the canvas's case, ⌘Z ends the gesture and is left to the page's undo hotkey", async () => {
        let released = 0;
        const editor = await mount(sample('column'), () => () => {
            released += 1;
        });
        for (const typed of ['P', 'Po', 'Poi']) await editor.type('Chart title', typed);
        expect((await editor.press('Chart title', { key: 'z', metaKey: true })).defaultPrevented).toBe(false);
        expect(released).toBe(1);
        // A key that is no undo leaves the gesture alone.
        await editor.type('Chart title', 'Poin');
        await editor.press('Chart title', { key: 'a', metaKey: true });
        expect(released).toBe(1);
    });
});
