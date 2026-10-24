// The selected image's or chart's one panel, Vector's: its X/Y/W/H/° and Keep aspect ratio, a chart's own sections,
// then Arrange. Delete is the menu's and the keyboard's, so the panel has no button for it. A typed field holds the
// host's gesture, one undo step. A viewer reads the fields and gets nothing that writes.
import { afterEach, describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart, SheetFloatingItem, SheetImage } from '@workspace/lib/sheets';
import type { ZOp } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { PropertySection } = await import('@workspace/ui/components/properties-panel');
const { FloatingObjectPanel } = await import('../../../components/sheets/floating-object-panel');

const BOX = { x: 12.4, y: 30, width: 200, height: 100, angle: 45 };
const image: SheetImage = { id: 'i1', index: 'a0', mediaName: 'cat.png', ...BOX };
const chart: SheetChart = { id: 'c1', index: 'a1', ...newSheetChartSpecParts(sampleChartSpec('column')), ...BOX };

let unmount = async () => {};
afterEach(() => unmount());

const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

async function render(item: SheetFloatingItem, canWrite = true) {
    const heard: unknown[] = [];
    ({ unmount } = await renderInDocument(
        createElement(
            FloatingObjectPanel,
            {
                item,
                canWrite,
                aspectLocked: item.kind === 'image',
                onAspectLockChange: (locked: boolean) => heard.push({ locked }),
                onChange: (fields: object) => heard.push(fields),
                onArrange: (op: ZOp) => heard.push(op),
                beginGesture: () => {
                    heard.push('hold');
                    return () => heard.push('release');
                },
                history: { undo: () => heard.push('undo'), redo: () => heard.push('redo') },
            },
            // The host's chart sections, as the app passes the sheet's for a chart.
            item.kind === 'chart' && createElement(PropertySection, { title: 'Chart', children: 'rows' }),
        ),
    ));
    const buttons = () => [...document.querySelectorAll('button')];
    const button = (label: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label);
    const click = (label: string) =>
        act(async () => {
            const target = button(label);
            if (!target) throw new Error(`no ${label}`);
            target.click();
        });
    const headings = () => [...document.querySelectorAll('h4')].map((h) => h.textContent);
    return { heard, buttons, button, click, headings };
}

describe.each([
    { item: { kind: 'image', object: image } satisfies SheetFloatingItem, title: 'Image', sections: ['Transform'] },
    {
        item: { kind: 'chart', object: chart } satisfies SheetFloatingItem,
        title: 'Chart',
        sections: ['Transform', 'Chart'],
    },
])('the $title panel', ({ item, title, sections }) => {
    test('shows the box and writes a typed field as one change inside one gesture', async () => {
        const { heard } = await render(item);
        expect(document.body.textContent).toContain(title);
        const inputs = [...document.querySelectorAll('input')];
        expect(inputs.map((input) => input.value).slice(0, 4)).toEqual(['12', '30', '200', '100']);
        expect(inputs.at(-1)?.value).toBe('45');
        const angle = inputs.at(-1);
        await act(async () => {
            angle?.focus();
            nativeValueSetter?.call(angle, '90');
            angle?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(heard).toEqual(['hold', { angle: 90 }]);
    });

    test('its own sections sit between Transform and Arrange, and it has no Edit chart or Delete', async () => {
        const { heard, click, button, headings } = await render(item);
        expect(headings()).toEqual([...sections, 'Arrange']);
        await click('Bring to front');
        await click('Send backward');
        expect(heard).toEqual(['toFront', 'backward']);
        for (const label of ['Edit chart', 'Delete chart', 'Delete image']) expect(button(label)).toBeUndefined();
    });

    test('a viewer reads the fields and gets no Arrange and no chart sections', async () => {
        const { buttons, headings } = await render(item, false);
        expect([...document.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
        expect(buttons()).toEqual([]);
        expect(headings()).toEqual(['Transform']);
    });
});

// Over a mounted workbook, wired as the editor wires it: the caret stays in a typed field, outside the workbook's
// keydown, so the panel hands ⌘Z to the workbook rather than leave the browser's field undo to write each step.
test('⌘Z in a typed chart title takes the whole title back in one step, and ⇧⌘Z brings it back', async () => {
    const { Workbook, ChartPanelSections } = await import('@workspace/sheet');
    const { createRef, useState } = await import('react');
    type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;
    type ChartPanelState = import('@workspace/sheet').ChartPanelState;
    const workbook = createRef<WorkbookInstance>();
    const history = { undo: () => workbook.current?.undo(), redo: () => workbook.current?.redo() };
    function Host() {
        const [panel, setPanel] = useState<ChartPanelState | null>(null);
        return createElement(
            'div',
            null,
            createElement(Workbook, {
                ref: workbook,
                data: [
                    {
                        id: 's1',
                        name: 'One',
                        order: 0,
                        status: 1,
                        row: 20,
                        column: 10,
                        celldata: [],
                        config: {},
                        charts: { c1: chart },
                    },
                ],
                showToolbar: false,
                showFormulaBar: false,
                hooks: { onChartPanelChange: setPanel },
            }),
            panel &&
                createElement(
                    FloatingObjectPanel,
                    {
                        item: { kind: 'chart', object: panel.chart },
                        canWrite: true,
                        aspectLocked: false,
                        onAspectLockChange: () => {},
                        onChange: () => {},
                        onArrange: () => {},
                        beginGesture: () => workbook.current?.beginGesture() ?? (() => {}),
                        history,
                    },
                    createElement(ChartPanelSections, { key: panel.chart.id, panel, workbook }),
                ),
        );
    }
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(createElement(Host)));
    const box = container.querySelector('[data-floating-id="c1"] > *');
    await act(async () => box?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    await act(async () => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })));
    const stored = () => readChartSpec(workbook.current?.getAllSheets()[0].charts?.c1 ?? {}).spec?.title.text;
    const before = sampleChartSpec('column').title.text;
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
    if (!title) throw new Error('no title field');
    await act(async () => {
        title.focus();
        title.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    for (const text of ['U', 'Un', 'Und', 'Undo']) {
        await act(async () => {
            nativeValueSetter?.call(title, text);
            title.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    const press = (shiftKey: boolean) =>
        act(async () => {
            title.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, shiftKey, bubbles: true }),
            );
        });

    await press(false);
    expect(stored()).toBe(before);
    expect(title.value).toBe(before);
    await press(true);
    expect(stored()).toBe('Undo');
    expect(title.value).toBe('Undo');
});
