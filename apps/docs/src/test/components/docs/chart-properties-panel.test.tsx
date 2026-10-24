// The Chart panel edits the selected chart's spec and frame through the doc's own undo manager: each change one undo
// step, a typed title too, and Edit data's Save one write.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, useState } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { chartSeriesStyle, parseChartSpec, sampleChartSpec } = await import('@workspace/lib/charts');
const { parseFill } = await import('@workspace/lib/vector');
const { getFontFamily } = await import('@workspace/lib/constants/fonts');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Chart } = await import('../../../components/docs/extensions/chart');
const { createDocUndoManager } = await import('../../../components/docs/page-setup');
const { ChartDataEditor, ChartPropertiesPanel } = await import('../../../components/docs/chart-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

// A collab editor holding one inserted chart, selected, its panel and its Edit data dialog mounted as the editor
// mounts them. Every write past the insert would be its own undo step but for a hold, as captureTimeout is 0.
async function mount() {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['chart'] }),
            Chart,
            Collaboration.configure({ document: doc, yUndoOptions: { undoManager } }),
        ],
    });
    editor.commands.insertChart('column');
    undoManager.stopCapturing();
    undoManager.captureTimeout = 0;
    function Host() {
        const [open, setOpen] = useState(false);
        return createElement(
            'div',
            null,
            createElement('div', { 'data-document': '' }, createElement(EditorContent, { editor })),
            createElement(ChartPropertiesPanel, { editor, undoManager, onEditData: () => setOpen(true) }),
            open && createElement(ChartDataEditor, { editor, undoManager, onClose: () => setOpen(false) }),
        );
    }
    const rendered = await renderInDocument(createElement(Host));
    const page = document.querySelector('[data-document]');
    if (page) Object.defineProperty(page, 'clientWidth', { value: 600 });
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    const stored = () => JSON.parse(editor.state.doc.nodeAt(1)?.attrs.spec ?? '{}');
    const spec = () => parseChartSpec(editor.state.doc.nodeAt(1)?.attrs.spec ?? '');
    // Another tab's write of the node's spec, as the panel and the dialog see it arrive.
    const store = (raw: object) => act(async () => void editor.commands.updateChart({ spec: JSON.stringify(raw) }));
    return { editor, undoManager, spec, stored, store };
}

type Spec = ReturnType<typeof parseChartSpec>;
const colorsOf = (spec: Spec) => spec?.data.series.map(({ id }) => chartSeriesStyle(spec, id).color);

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
const button = (scope: ParentNode | undefined, label: string) => {
    const found = [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (el) => el.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const click = (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
// A row's control sits beside its label span.
const row = (label: string) => {
    const span = [...document.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === label);
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no "${label}" row`);
    return control;
};
const choose = async (label: string, option: string) => {
    const trigger = row(label).querySelector('[data-slot="select-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
    const item = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
        (el) => el.textContent?.trim() === option,
    );
    if (!item) throw new Error(`no "${option}" option under "${label}"`);
    await act(async () => {
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};
// The grid opens on A1, as a sheet does, so B2 is selected before it is typed in.
const typeInB2 = async (value: string) => {
    const b2 = dialog()?.querySelector('[role="row"][aria-rowindex="3"] > [aria-colindex="3"]');
    await act(async () => {
        b2?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await type(dialog()?.querySelector<HTMLInputElement>('input[data-cell-editor]'), value);
};
const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
        if (!input) throw new Error('no field to type in');
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
// A keydown on the field, returned so the test can see whether the browser's own handling of it was prevented.
const press = async (input: HTMLInputElement | null, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => {
        input?.dispatchEvent(event);
    });
    return event;
};

test('a title typed into the panel is one undo step, and the chart stays selected', async () => {
    const { editor, undoManager, spec } = await mount();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
    for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
    await act(async () => {
        input?.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
    expect(spec()?.title.text).toBe('Goal');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });

    undoManager.undo();
    expect(spec()?.title.text).toBe("Where a star's light goes");
});

// The field still holds the caret after typing, so ⌘Z reaches the field, not the editor's keymap. The browser's own
// field undo would walk the text back a character at a time, writing each one.
const fieldTitle = {
    'Chart title': (spec: Spec) => spec?.title.text,
    'Horizontal axis title': (spec: Spec) => spec?.axes.x.title.text,
    'Vertical axis title': (spec: Spec) => spec?.axes.y.title.text,
};
for (const [placeholder, read] of Object.entries(fieldTitle)) {
    test(`⌘Z in the ${placeholder} field takes the typed text back as one step, and ⇧⌘Z puts it back`, async () => {
        const { spec } = await mount();
        const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
        const before = read(spec());
        for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
        expect(read(spec())).toBe('Goal');

        const undo = await press(input, { key: 'z', metaKey: true });
        expect(undo.defaultPrevented).toBe(true);
        expect(read(spec())).toBe(before);
        expect(input?.value).toBe(before ?? '');

        const redo = await press(input, { key: 'z', metaKey: true, shiftKey: true });
        expect(redo.defaultPrevented).toBe(true);
        expect(read(spec())).toBe('Goal');
        expect(input?.value).toBe('Goal');
    });
}

test("a font picked in the Font row is one undo step, and the chart's labels draw in it", async () => {
    const { undoManager, spec } = await mount();
    expect(spec()?.chart.fontFamily).toBe('Inter');
    const label = [...document.querySelectorAll('span.w-14')].find((span) => span.textContent?.trim() === 'Font');
    const trigger = label?.nextElementSibling?.querySelector('button[aria-haspopup="menu"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const serif = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Source Serif 4',
    );
    if (!serif) throw new Error('no Source Serif 4 in the Font menu');
    await click(serif);
    expect(spec()?.chart.fontFamily).toBe('Source Serif 4');
    const fonts = new Set(
        [...document.querySelectorAll('[data-document] svg text')].map((t) => t.getAttribute('font-family')),
    );
    expect(fonts).toEqual(new Set([getFontFamily('Source Serif 4')]));

    undoManager.undo();
    expect(spec()?.chart.fontFamily).toBe('Inter');
});

test("a Style toggle wraps the chart in one undo step and lights it, the spec's rows untouched", async () => {
    const { editor, undoManager, spec } = await mount();
    const before = spec();
    // The Style toggles, own line, wrap left and wrap right, are the panel's first.
    const wrapLeft = document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1];
    expect(wrapLeft.getAttribute('aria-pressed')).toBe('false');
    await click(wrapLeft);
    // Half the 600 px column at most, its shape kept, or nothing wraps beside it.
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ layout: 'wrap-left', width: 300, height: 186 });
    expect(wrapLeft.getAttribute('aria-pressed')).toBe('true');
    expect(spec()).toEqual(before);

    undoManager.undo();
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ layout: 'block', width: 600, height: 371 });
});

test("the sample's colors are Automatic, and a picked color and a Stacking pick are one undo step each", async () => {
    const { undoManager, spec } = await mount();
    expect(row('Sun').textContent).toBe('Automatic');
    expect(row('Bulb (incandescent)').textContent).toBe('Automatic');

    await click(row('Bulb (incandescent)').querySelector('button') ?? document.body);
    const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title^="#"]');
    if (!swatch) throw new Error('the color popover has no swatch');
    await click(swatch);
    const picked = spec();
    expect(colorsOf(picked)).toEqual([null, swatch.title, null]);
    undoManager.undo();
    expect(colorsOf(spec())).toEqual([null, null, null]);

    await choose('Stacking', '100%');
    expect(spec()?.plots.column.stacking).toBe('percent');
    undoManager.undo();
    expect(spec()?.plots.column.stacking).toBe('none');
});

test('Edit data saves the grid as one undo step', async () => {
    const { undoManager, spec } = await mount();
    await click(button(document.body, 'Edit data'));
    await typeInB2('7');
    await click(button(dialog(), 'Save'));
    const saved = spec();
    expect(saved?.data.source === 'inline' && saved.data.series[0].values[0]).toBe(7);
    expect(dialog()).toBeUndefined();

    undoManager.undo();
    const undone = spec();
    expect(undone?.data.source === 'inline' && undone.data.series[0].values[0]).toBe(13.1);
});

test("a title typed into the panel keeps what this build doesn't know: a key on the spec, on an axis, a legend", async () => {
    const { stored, store } = await mount();
    const { axes } = sampleChartSpec('column');
    const before = stored();
    const raw = {
        ...before,
        legend: { position: 'inside' },
        future: 1,
        axes: { ...before.axes, y: { ...axes.y, logBase: 10 } },
    };
    await store(raw);
    await type(document.querySelector<HTMLInputElement>('input[placeholder="Chart title"]'), 'Goals');
    expect(stored()).toEqual({ ...raw, title: { text: 'Goals' } });
});

test("Edit data's Save applies onto the node as it is then, so a peer's colours and title while it was open stay", async () => {
    const { spec, stored, store } = await mount();
    await click(button(document.body, 'Edit data'));
    const before = stored();
    const series = { ...before.series, 's-2': { ...before.series['s-2'], color: '#00ff00' } };
    const points = { 's-1': { 1: { color: '#000002' } } };
    await store({ ...before, title: { text: 'Peer title' }, series, points });
    await typeInB2('7');
    await click(button(dialog(), 'Save'));
    const saved = spec();
    expect(saved?.title.text).toBe('Peer title');
    expect(saved?.points).toEqual(points);
    expect(colorsOf(saved)).toEqual([null, '#00ff00', null]);
    expect(saved?.data.source === 'inline' && saved.data.series[0].values[0]).toBe(7);
});

// A section's row control, beside its label span: the panel has several Style rows.
const sectionRow = (section: string, label: string) => {
    const heading = [...document.querySelectorAll('h4')].find((h) => h.textContent === section);
    const span = [...(heading?.parentElement?.querySelectorAll('span.w-14') ?? [])].find(
        (s) => s.textContent?.trim() === label,
    );
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no ${section} › ${label} row`);
    return control;
};
const chooseIn = async (section: string, label: string, option: string) => {
    const trigger = sectionRow(section, label).querySelector('[data-slot="select-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

test("the look rows write the chart's own attributes, each one undo step, and the chart draws them", async () => {
    const { editor, undoManager, spec } = await mount();
    const attrs = () => editor.state.doc.nodeAt(1)?.attrs ?? {};
    const sections = [...document.querySelectorAll('h4')].map((h) => h.textContent);
    expect(sections).toEqual(expect.arrayContaining(['Labels', 'Fill', 'Stroke', 'Sketch']));
    // Opacity is a canvas layer's.
    expect(sections).not.toContain('Appearance');
    const before = spec();
    const drawn = () => document.querySelector('[data-document] svg')?.innerHTML;
    const flat = drawn();

    await chooseIn('Sketch', 'Style', 'Cartoonist');
    expect(attrs().roughness).toBe(2);
    expect(drawn()).not.toBe(flat);
    await chooseIn('Fill', 'Style', 'Cross-hatch');
    expect(parseFill(attrs().fill).style).toBe('cross-hatch');
    await chooseIn('Stroke', 'Style', 'Dashed');
    expect(attrs().strokeStyle).toBe('dashed');
    expect(spec()).toEqual(before);

    undoManager.undo();
    expect(attrs().strokeStyle).not.toBe('dashed');
    expect(parseFill(attrs().fill).style).toBe('cross-hatch');
    await act(async () => {
        undoManager.undo();
        undoManager.undo();
    });
    expect(attrs().roughness).toBeNull();
    expect(drawn()).toBe(flat);
});
