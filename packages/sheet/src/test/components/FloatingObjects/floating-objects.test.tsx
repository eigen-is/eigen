// Images and charts on a mounted Workbook go through one frame: each case runs for both kinds. A click selects and
// focuses, a drag moves in one write, a finger pans until a tap selects, Escape lets go, Delete removes, the grips
// resize and rotate, the right-click menu and ⌘[ ⌘] reorder, a viewer only downloads, and Cut and Copy reach the
// clipboard from the keys, the object's menu and Edit. Both kinds draw in one paint order.
import { afterEach, describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import { readEigenClipboard } from '@workspace/lib/clipboard';
import type { SheetChart, SheetFloatingItem, SheetImage } from '@workspace/lib/sheets';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type Op = import('../../../state').Op;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const image: SheetImage = { id: 'i1', index: 'a0', mediaName: 'cat.png', x: 20, y: 30, width: 200, height: 100 };
const chart: SheetChart = {
    id: 'c1',
    index: 'a1',
    x: 400,
    y: 30,
    width: 300,
    height: 200,
    spec: JSON.stringify({
        ...sampleChartSpec('column'),
        data: { source: 'inline', categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2], color: null }] },
    }),
};
const PATH = drivePath({ name: 'cat.png', mimeType: 'image/png' });

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

async function mount({ allowEdit = true, aspectLocked = false, showToolbar = false, images = { i1: image } } = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const reported: (SheetFloatingItem | null)[] = [];
    const ops: Op[][] = [];
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 40,
            column: 20,
            celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x' } }],
            config: {},
            images,
            charts: { c1: chart },
        },
    ];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref: workbook,
                data,
                allowEdit,
                aspectLocked,
                showToolbar,
                showFormulaBar: false,
                onOp: (op) => ops.push(op),
                hooks: {
                    resolveImageUrl: (name) => `blob:${name}`,
                    resolveImagePath: () => PATH,
                    onActiveObjectChange: (item) => reported.push(item),
                },
            }),
        );
    });
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    const frame = (id: string) => container.querySelector<HTMLElement>(`[data-floating-id="${id}"]`);
    const content = (id: string) => {
        const el = frame(id)?.firstElementChild;
        if (!(el instanceof HTMLElement)) throw new Error(`no ${id}`);
        return el;
    };
    const sheet = () => workbook.current?.getAllSheets()[0];
    const record = (id: string) => sheet()?.images?.[id] ?? sheet()?.charts?.[id];
    const order = () =>
        [...container.querySelectorAll('[data-floating-id]')].map((el) => el.getAttribute('data-floating-id'));
    const undo = () => act(async () => workbook.current?.undo());
    return { container, frame, content, record, order, undo, reported, ops };
}

const fire = (target: EventTarget, type: string, init: PointerEventInit = {}) =>
    act(async () => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...init }));
    });

const key = (target: EventTarget, init: KeyboardEventInit) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });

async function click(el: HTMLElement, pointerType = 'mouse') {
    await fire(el, 'pointerdown', { pointerType });
    await fire(el, 'pointerup', { pointerType });
    await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function rightClick(el: HTMLElement) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
}

async function pick(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) =>
            entry.textContent
                ?.replace(entry.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
                .trim() === label,
    );
    if (!item) throw new Error(`no ${label} row`);
    await act(async () => item.click());
}

async function openSub(label: string) {
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    if (!trigger) throw new Error(`no ${label} submenu`);
    await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    });
    await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
}

// The browser fires the clipboard event a key or execCommand asks for at the focused element.
function fakeExecCommand() {
    const written: DataTransfer[] = [];
    Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: (command: string) => {
            const clipboardData = new DataTransfer();
            written.push(clipboardData);
            (document.activeElement ?? document.body).dispatchEvent(
                new ClipboardEvent(command, { clipboardData, bubbles: true, cancelable: true }),
            );
            return true;
        },
    });
    return written;
}

const KINDS: (SheetFloatingItem & { rows: string[]; download: string })[] = [
    {
        kind: 'image',
        object: image,
        rows: ['Cut', 'Copy', '—', 'Duplicate', '—', 'Order', '—', 'Download original image', '—', 'Delete'],
        download: 'Download original image',
    },
    {
        kind: 'chart',
        object: chart,
        rows: ['Cut', 'Copy', '—', 'Duplicate', '—', 'Order', '—', 'Download image', '—', 'Delete'],
        download: 'Download image',
    },
];

describe.each(KINDS)('a floating $kind', ({ rows, download, ...item }) => {
    const { kind, object } = item;
    const { id } = object;

    test('a click selects it, takes the focus and reports it', async () => {
        const { frame, content, reported } = await mount();
        await click(content(id));
        expect(frame(id)?.getAttribute('data-active')).toBe('true');
        expect(document.activeElement).toBe(frame(id));
        expect(reported.at(-1)).toEqual(item);
    });

    test('a drag moves it in one write, one undo step', async () => {
        const { content, record, undo, ops } = await mount();
        await fire(content(id), 'pointerdown', { clientX: 10, clientY: 10 });
        await fire(document, 'pointermove', { clientX: 30, clientY: 15 });
        await fire(document, 'pointermove', { clientX: 60, clientY: 20 });
        await fire(document, 'pointerup', { clientX: 60, clientY: 20 });
        expect(record(id)).toMatchObject({ x: object.x + 50, y: object.y + 10, width: object.width });
        expect(ops.flat().map((op) => op.path.at(-1))).toEqual(['x', 'y']);
        await undo();
        expect(record(id)).toEqual(object);
    });

    test('a finger on it unselected pans the grid; a tap selects it, and a drag then moves it', async () => {
        const { frame, content, record } = await mount();
        await fire(content(id), 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        await fire(document, 'pointermove', { pointerType: 'touch', clientX: 10, clientY: 60 });
        await fire(document, 'pointercancel', { pointerType: 'touch' });
        expect(frame(id)?.getAttribute('data-active')).toBeNull();
        expect(content(id).classList.contains('touch-none')).toBe(false);
        expect(record(id)).toEqual(object);

        await click(content(id), 'touch');
        expect(frame(id)?.getAttribute('data-active')).toBe('true');
        expect(content(id).classList.contains('touch-none')).toBe(true);
        await fire(content(id), 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        await fire(document, 'pointermove', { pointerType: 'touch', clientX: 40, clientY: 10 });
        await fire(document, 'pointerup', { pointerType: 'touch', clientX: 40, clientY: 10 });
        expect(record(id)).toMatchObject({ x: object.x + 30, y: object.y });
    });

    test('a cancelled pointer, a pan the browser took, moves nothing on the next tap', async () => {
        const { content, record, frame } = await mount();
        await click(content(id));
        await fire(content(id), 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
        await fire(document, 'pointermove', { pointerType: 'touch', clientX: 30, clientY: 40 });
        await fire(document, 'pointercancel', { pointerType: 'touch' });
        expect(frame(id)?.style.left).toBe(`${object.x}px`);
        await fire(document, 'pointermove', { pointerType: 'touch', clientX: 90, clientY: 90 });
        await fire(document, 'pointerup', { pointerType: 'touch', clientX: 90, clientY: 90 });
        expect(record(id)).toEqual(object);
    });

    test('Escape lets go of it', async () => {
        const { frame, content, reported } = await mount();
        await click(content(id));
        await key(document.activeElement ?? document.body, { key: 'Escape' });
        expect(frame(id)?.getAttribute('data-active')).toBeNull();
        expect(reported.at(-1)).toBeNull();
    });

    test('Delete removes it as one undo step', async () => {
        const { frame, content, record, undo } = await mount();
        await click(content(id));
        await key(document.activeElement ?? document.body, { key: 'Delete' });
        expect(frame(id)).toBeNull();
        expect(record(id)).toBeUndefined();
        await undo();
        expect(record(id)).toEqual(object);
    });

    test('a corner grip resizes it in one write; Keep aspect ratio locks the corner and Shift frees it', async () => {
        const drag = async (shiftKey: boolean, aspectLocked: boolean) => {
            const { container, content, record, ops } = await mount({ aspectLocked });
            await click(content(id));
            const corner = container.querySelectorAll('.eigen-selection-handle')[3];
            if (!corner) throw new Error('no grip');
            Object.defineProperty(corner, 'setPointerCapture', { value: () => {} });
            await fire(corner, 'pointerdown', { clientX: 0, clientY: 0 });
            await fire(document, 'pointermove', { clientX: 100, clientY: 0, shiftKey });
            await fire(document, 'pointerup', { clientX: 100, clientY: 0, shiftKey });
            const written = ops.flat().map((op) => op.path.at(-1));
            const result = record(id);
            await cleanups.pop()?.();
            return { written, result };
        };
        const free = await drag(false, false);
        expect(free.result).toMatchObject({ width: object.width + 100, height: object.height });
        expect(free.written).toEqual(['width']);
        const locked = await drag(false, true);
        expect(locked.result?.height).toBeGreaterThan(object.height);
        expect(locked.written).toEqual(['width', 'height']);
        expect((await drag(true, true)).result).toMatchObject({ height: object.height });
        expect((await drag(true, false)).result?.height).toBeGreaterThan(object.height);
    });

    test('the rotate grip turns it and writes only its angle', async () => {
        const { container, content, record, ops } = await mount();
        await click(content(id));
        const grip = container.querySelector('.cursor-grab');
        if (!grip) throw new Error('no rotate grip');
        Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
        // happy-dom lays nothing out, so the pivot is (0, 0): from straight above to the right is 90°.
        await fire(grip, 'pointerdown', { clientX: 0, clientY: -10 });
        await fire(document, 'pointermove', { clientX: 10, clientY: 0 });
        expect(content(id).style.transform).toBe('rotate(90deg)');
        await fire(document, 'pointerup', { clientX: 10, clientY: 0 });
        expect(record(id)).toEqual({ ...object, angle: 90 });
        expect(ops.flat().map((op) => op.path.at(-1))).toEqual(['angle']);
    });

    test('a right-click selects it and opens its menu, whose Order rows restack it', async () => {
        const { frame, content, order } = await mount();
        await rightClick(content(id));
        expect(frame(id)?.getAttribute('data-active')).toBe('true');
        expect(menuRows()).toEqual([...rows]);
        expect(document.querySelector('[data-variant="destructive"]')?.textContent?.trim()).toBe('Delete');
        const bottom = order()[0] === id;
        await openSub('Order');
        await pick(bottom ? 'Bring to front' : 'Send to back');
        expect(order().indexOf(id)).toBe(bottom ? 1 : 0);
    });

    test('⌘] and ⌘⇧[ restack the selected one', async () => {
        const { content, order } = await mount();
        await click(content(id));
        const bottom = order()[0] === id;
        await key(document.activeElement ?? document, {
            code: bottom ? 'BracketRight' : 'BracketLeft',
            metaKey: true,
            shiftKey: !bottom,
        });
        expect(order().indexOf(id)).toBe(bottom ? 1 : 0);
    });

    test('Duplicate puts a copy on top, a step down and right, and selects it', async () => {
        const { content, order, record, container } = await mount();
        await rightClick(content(id));
        await pick('Duplicate');
        const copy = order().at(-1);
        expect(copy).not.toBe(id);
        expect(copy && record(copy)).toMatchObject({ x: object.x + 10, y: object.y + 10, width: object.width });
        expect(container.querySelector('[data-active="true"]')?.getAttribute('data-floating-id')).toBe(copy ?? '');
    });

    test('a viewer selects it with no grips, and its menu has only the download row', async () => {
        const { container, frame, content } = await mount({ allowEdit: false });
        await click(content(id));
        expect(frame(id)?.getAttribute('data-active')).toBe('true');
        expect(container.querySelector('.eigen-selection-handle')).toBeNull();
        await rightClick(content(id));
        expect(menuRows()).toEqual([download]);
    });

    test('⌘X writes it to the clipboard and deletes it, one undo step; a viewer’s only copies', async () => {
        for (const allowEdit of [true, false]) {
            const { content, record, undo } = await mount({ allowEdit });
            await click(content(id));
            const target = document.activeElement ?? document.body;
            const clipboardData = new DataTransfer();
            await act(async () => {
                target.dispatchEvent(
                    new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', metaKey: true, bubbles: true }),
                );
                target.dispatchEvent(new ClipboardEvent('cut', { clipboardData, bubbles: true, cancelable: true }));
            });
            expect(readEigenClipboard(clipboardData)?.items.map((item) => item.type)).toEqual([kind]);
            expect(record(id)).toEqual(allowEdit ? undefined : object);
            if (allowEdit) {
                await undo();
                expect(record(id)).toEqual(object);
            }
            await cleanups.pop()?.();
        }
    });

    test('its menu’s Cut and Copy write it as ⌘X and ⌘C do', async () => {
        const written = fakeExecCommand();
        try {
            const { content, record } = await mount();
            await rightClick(content(id));
            await pick('Copy');
            expect(readEigenClipboard(written[0])?.items.map((item) => item.type)).toEqual([kind]);
            expect(record(id)).toEqual(object);
            await rightClick(content(id));
            await pick('Cut');
            expect(readEigenClipboard(written[1])?.items.map((item) => item.type)).toEqual([kind]);
            expect(record(id)).toBeUndefined();
        } finally {
            Reflect.deleteProperty(document, 'execCommand');
        }
    });

    test('Edit › Copy and Cut copy it, not the cells behind it', async () => {
        const written = fakeExecCommand();
        try {
            const { container, content, record } = await mount({ showToolbar: true });
            const openEdit = async () => {
                const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
                if (!trigger) throw new Error('no Edit menu');
                await fire(trigger, 'pointerdown');
            };
            await click(content(id));
            await openEdit();
            await pick('Copy');
            expect(readEigenClipboard(written[0])?.items.map((item) => item.type)).toEqual([kind]);
            await openEdit();
            await pick('Cut');
            expect(readEigenClipboard(written[1])?.items.map((item) => item.type)).toEqual([kind]);
            expect(record(id)).toBeUndefined();
        } finally {
            Reflect.deleteProperty(document, 'execCommand');
        }
    });
});

test('images and charts draw in one paint order, by index', async () => {
    const { order, frame } = await mount({ images: { i1: { ...image, index: 'a2' } } });
    expect(order()).toEqual(['c1', 'i1']);
    expect(frame('c1')?.style.zIndex).toBe(frame('i1')?.style.zIndex);
});

test('the overlay draws the box sheetFloatingBox clamps a stored one to', async () => {
    const { frame } = await mount({ images: { i1: { ...image, x: -50, width: 1e9 } } });
    expect(frame('i1')?.style.left).toBe('0px');
    expect(Number.parseFloat(frame('i1')?.style.width ?? '')).toBeLessThan(1e4);
});

// Selecting keeps an object in its place in the paint order; only its ring draws above every object.
test('a selected lower object stays under the one above it, its ring above both', async () => {
    const { container, content, frame } = await mount();
    await click(content('i1'));
    expect(frame('i1')?.style.zIndex).toBe(frame('c1')?.style.zIndex);
    const ring = container.querySelector('.eigen-selection-ring');
    if (!ring || !frame('c1')) throw new Error('no ring');
    expect(frame('c1')?.compareDocumentPosition(ring)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(frame('i1')?.contains(ring)).toBe(false);
});
