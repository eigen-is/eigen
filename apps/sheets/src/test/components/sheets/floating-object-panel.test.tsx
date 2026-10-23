// The selected image's or chart's panel: its X/Y/W/H/°, Keep aspect ratio, Arrange and Delete, and for a chart Edit
// chart. A viewer reads the fields and gets nothing that writes.
import { afterEach, describe, expect, test } from 'bun:test';
import type { SheetChart, SheetFloatingItem, SheetImage } from '@workspace/lib/sheets';
import type { ZOp } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { FloatingObjectPanel } = await import('../../../components/sheets/floating-object-panel');

const BOX = { x: 12.4, y: 30, width: 200, height: 100, angle: 45 };
const image: SheetImage = { id: 'i1', index: 'a0', mediaName: 'cat.png', ...BOX };
const chart: SheetChart = { id: 'c1', index: 'a1', spec: '{}', ...BOX };

let unmount = async () => {};
afterEach(() => unmount());

const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

async function render(item: SheetFloatingItem, canWrite = true) {
    const heard: unknown[] = [];
    ({ unmount } = await renderInDocument(
        createElement(FloatingObjectPanel, {
            item,
            canWrite,
            aspectLocked: item.kind === 'image',
            onAspectLockChange: (locked: boolean) => heard.push({ locked }),
            onChange: (fields: object) => heard.push(fields),
            onArrange: (op: ZOp) => heard.push(op),
            onEditChart: () => heard.push('edit'),
            onDelete: () => heard.push('delete'),
        }),
    ));
    const buttons = () => [...document.querySelectorAll('button')];
    const button = (label: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label);
    const click = (label: string) =>
        act(async () => {
            const target = button(label);
            if (!target) throw new Error(`no ${label}`);
            target.click();
        });
    return { heard, buttons, button, click };
}

describe.each([
    { item: { kind: 'image', object: image } satisfies SheetFloatingItem, title: 'Image', remove: 'Delete image' },
    { item: { kind: 'chart', object: chart } satisfies SheetFloatingItem, title: 'Chart', remove: 'Delete chart' },
])('the $title panel', ({ item, title, remove }) => {
    test('shows the box and writes a typed field as one change', async () => {
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
        expect(heard).toEqual([{ angle: 90 }]);
    });

    test('Arrange restacks it, Delete removes it, and only a chart has Edit chart', async () => {
        const { heard, click, button } = await render(item);
        await click('Bring to front');
        await click('Send backward');
        await click(remove);
        expect(heard).toEqual(['toFront', 'backward', 'delete']);
        if (item.kind === 'chart') {
            await click('Edit chart');
            expect(heard.at(-1)).toBe('edit');
        } else {
            expect(button('Edit chart')).toBeUndefined();
        }
    });

    test('a viewer reads the fields and gets no Arrange, Edit chart or Delete', async () => {
        const { buttons } = await render(item, false);
        expect([...document.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
        expect(buttons()).toEqual([]);
    });
});
