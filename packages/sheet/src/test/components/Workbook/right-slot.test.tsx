// A host's pane, such as its comments column, sits in the workbook's right slot: under the menu bar, which keeps the
// full width, and beside the formula bar, the grid and the tabs, whose canvas the grid measures. The pane's keys are
// its own: a letter, Delete, Enter or ⌘Z in a field there never reaches the selected cell, and neither does a paste,
// nor a cut or copy of text selected there while a chart is selected.
import { afterEach, expect, test } from 'bun:test';
import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

const resizes: (() => void)[] = [];
installHappyDom({ onResizeObserver: (resize) => resizes.push(resize) });

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const chart = { id: 'c1', index: 'a0', x: 300, y: 10, width: 200, height: 100 };
    const charts = { c1: { ...chart, ...newChartSpecParts(sampleChartSpec('column')) } };
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: 10,
            column: 5,
            celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x' } }],
            charts,
        },
    ];
    const pane = createElement(
        'aside',
        { 'data-testid': 'pane' },
        createElement('textarea'),
        createElement('p', null, 'A reply'),
    );
    const selections: unknown[] = [];
    const hooks = { afterSelectionChange: (_id: string, selection: unknown) => selections.push(selection) };
    await act(async () => {
        root.render(createElement(Workbook, { ref: workbook, data, hooks, rightSlot: pane }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="pane"] textarea');
    if (!input || !field) throw new Error('no cell editor or pane');
    const a1 = () => workbook.current?.getAllSheets()[0]?.data?.[0]?.[0]?.v ?? null;
    const chartCount = () => Object.keys(workbook.current?.getAllSheets()[0]?.charts ?? {}).length;
    return { container, input, field, a1, selections, chartCount };
}

const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });

test('the slot sits under the full-width menu bar, beside the formula bar, the grid and the tabs', async () => {
    const { container } = await mount();
    const pane = container.querySelector('[data-testid="pane"]');
    const bar = container.querySelector('[aria-label="Formatting"]')?.closest('.\\@container');
    const canvas = container.querySelector('canvas');
    const row = canvas?.parentElement?.parentElement?.parentElement;
    if (!pane || !bar || !row) throw new Error('no pane, bar or grid');
    // The pane and the grid share a row; the bar is above that row, not in it.
    expect(row.contains(pane)).toBe(true);
    expect(row.contains(bar)).toBe(false);
    expect(row.previousElementSibling).toBe(bar);
    expect(row.querySelector('[aria-label="New sheet"]')).not.toBeNull();
    expect(row.contains(container.querySelector('.eigen-paper'))).toBe(true);
});

// The grid observes the box its canvas fills, which the slot beside it narrows.
test('the grid sizes its canvas again when the slot beside it changes width', async () => {
    const { container } = await mount();
    const canvas = container.querySelector('canvas');
    const placeholder = canvas?.previousElementSibling;
    const row = container.querySelector('[data-testid="pane"]')?.parentElement?.parentElement;
    if (!canvas || !(placeholder instanceof HTMLElement) || !row) throw new Error('no canvas');
    expect(row.contains(placeholder)).toBe(true);
    for (const width of [900, 644]) {
        Object.defineProperty(placeholder, 'clientWidth', { configurable: true, get: () => width });
        Object.defineProperty(placeholder, 'clientHeight', { configurable: true, get: () => 600 });
        await act(async () => {
            for (const resize of resizes) resize();
        });
        expect(canvas.style.width).toBe(`${width}px`);
    }
});

test.each([
    ['a letter', 'a', {}],
    ['Delete', 'Delete', {}],
    ['Backspace', 'Backspace', {}],
    ['Enter', 'Enter', {}],
    ['an arrow', 'ArrowDown', {}],
])('%s typed in the slot leaves the selected cell alone', async (_, key, init) => {
    const { input, field, a1, selections } = await mount();
    selections.length = 0;
    await act(async () => field.focus());
    await press(field, key, init);
    expect(a1()).toBe('x');
    expect(input.textContent).toBe('');
    expect(selections).toEqual([]);
    expect(document.activeElement).toBe(field);
    // The same key in the grid acts, so the slot's own keys are what the grid skips.
    if (key === 'Delete') {
        await act(async () => input.focus());
        await press(input, key);
        expect(a1()).toBeNull();
    }
});

test('⌘Z in the slot leaves the sheet history alone', async () => {
    const { input, field, a1 } = await mount();
    await act(async () => input.focus());
    await press(input, 'Delete');
    expect(a1()).toBeNull();
    await act(async () => field.focus());
    await press(field, 'z', { metaKey: true });
    await press(field, 'z', { ctrlKey: true });
    expect(a1()).toBeNull();
});

test('a paste in the slot does not paste into the sheet', async () => {
    const { field, a1 } = await mount();
    await act(async () => field.focus());
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'pasted');
    const paste = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    await act(async () => field.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(false);
    expect(a1()).toBe('x');
});

test.each(['copy', 'cut'])('a %s of text selected in the slot leaves the selected chart alone', async (type) => {
    const { container, chartCount } = await mount();
    const box = container.querySelector<HTMLElement>('[data-floating-id="c1"] > *');
    const text = container.querySelector('[data-testid="pane"] p')?.firstChild;
    if (!box || !text) throw new Error('no chart or pane text');
    await act(async () => {
        box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    });
    // A press on the pane's text takes the focus off the chart and selects there.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.getSelection()?.selectAllChildren(text.parentNode ?? text);
    const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(chartCount()).toBe(1);
});

test('a cut after a press on the chart cuts the chart, though text in the slot is still selected', async () => {
    const { container, chartCount } = await mount();
    const frame = container.querySelector<HTMLElement>('[data-floating-id="c1"]');
    const text = container.querySelector('[data-testid="pane"] p')?.firstChild;
    if (!frame || !text) throw new Error('no chart or pane text');
    document.getSelection()?.selectAllChildren(text.parentNode ?? text);
    // Selecting the chart focuses its frame by script, which leaves the document's selection in the slot.
    await act(async () => {
        frame.firstElementChild?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        frame.firstElementChild?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        frame.focus();
    });
    const event = new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(chartCount()).toBe(0);
});
