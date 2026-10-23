// The selected image's or chart's one panel, Vector's: its X/Y/W/H/° and Keep aspect ratio, a chart's own sections,
// then Arrange. Delete is the menu's and the keyboard's, so the panel has no button for it. A typed field holds the
// host's gesture, one undo step. A viewer reads the fields and gets nothing that writes.
import { afterEach, describe, expect, test } from 'bun:test';
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
const chart: SheetChart = { id: 'c1', index: 'a1', spec: '{}', ...BOX };

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
