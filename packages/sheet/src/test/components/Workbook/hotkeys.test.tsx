// Each sheet shortcut has one definition: the key that runs it and the label its menu row shows both come from it.
// The table below spells every shortcut out, so a changed definition fails a key test and a label test here.
import { afterEach, expect, test } from 'bun:test';
import { formatForDisplay, parseHotkey } from '@tanstack/react-hotkeys';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DocSearchProvider } = await import('@workspace/ui/components/search/doc-search-provider');
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
    const data: Sheet[] = [
        { id: 's1', name: 'One', order: 0, status: 1, row: 10, column: 5, celldata: [], config: {} },
    ];
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {}, canReplace: true };
    await act(async () => {
        root.render(
            createElement(DocSearchProvider, {
                controller,
                children: createElement(Workbook, {
                    ref: workbook,
                    data,
                    showToolbar: true,
                    showFormulaBar: false,
                    hooks: {},
                }),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    input.focus();
    const a1 = () => workbook.current?.getAllSheets()[0]?.data?.[0]?.[0];
    return { container, input, a1 };
}

// A keydown as the hotkey's own keys type it on a QWERTY layout.
async function press(target: HTMLElement, hotkey: string) {
    const { key, ctrl, meta, shift, alt } = parseHotkey(hotkey);
    await act(async () => {
        target.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: shift ? key : key.toLowerCase(),
                code: `Key${key}`,
                ctrlKey: ctrl,
                metaKey: meta,
                shiftKey: shift,
                altKey: alt,
                bubbles: true,
                cancelable: true,
            }),
        );
    });
}

async function openMenu(container: HTMLElement, label: string) {
    const trigger = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

// The last-opened menu's rows that show a shortcut, as [label, shortcut].
const shortcutRows = () =>
    [...([...document.querySelectorAll('[role="menu"]')].at(-1)?.querySelectorAll('[role="menuitem"]') ?? [])].flatMap(
        (row) => {
            const shortcut = row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent;
            return shortcut ? [[row.textContent?.replace(shortcut, '').trim(), shortcut]] : [];
        },
    );

test('the Edit menu shows each shortcut the grid answers to', async () => {
    const { container } = await mount();
    await openMenu(container, 'Edit');
    expect(shortcutRows()).toEqual(
        [
            ['Undo', 'Mod+Z'],
            ['Redo', 'Mod+Shift+Z'],
            ['Cut', 'Mod+X'],
            ['Copy', 'Mod+C'],
            ['Paste', 'Mod+V'],
            ['Find', 'Mod+F'],
            ['Find and replace', 'Mod+Shift+H'],
        ].map(([label, hotkey]) => [label, formatForDisplay(hotkey)]),
    );
});

test('Format › Text shows the bold, italic and underline shortcuts', async () => {
    const { container } = await mount();
    await openMenu(container, 'Format');
    await openSubmenu('Text');
    expect(shortcutRows()).toEqual(
        [
            ['Bold', 'Mod+B'],
            ['Italic', 'Mod+I'],
            ['Underline', 'Mod+U'],
        ].map(([label, hotkey]) => [label, formatForDisplay(hotkey)]),
    );
});

test('⌘Z undoes in the grid, and ⇧⌘Z and ⌘Y redo', async () => {
    const { input, a1 } = await mount();
    await press(input, 'Mod+B');
    expect(a1()?.bl).toBe(1);
    await press(input, 'Mod+Z');
    expect(a1()?.bl).toBeFalsy();
    await press(input, 'Mod+Shift+Z');
    expect(a1()?.bl).toBe(1);
    await press(input, 'Mod+Z');
    await press(input, 'Mod+Y');
    expect(a1()?.bl).toBe(1);
});

// In an open cell editor the browser undoes the typing, as in Google Sheets. The sheet's history stays put.
test('⌘Z, ⇧⌘Z and ⌘Y in an open cell editor leave the sheet history alone', async () => {
    const { input, a1 } = await mount();
    await press(input, 'Mod+B');
    await press(input, 'Mod+I');
    await press(input, 'Mod+Z');
    expect([a1()?.bl, a1()?.it ?? 0]).toEqual([1, 0]);
    await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true }));
    });
    for (const hotkey of ['Mod+Z', 'Mod+Shift+Z', 'Mod+Y']) await press(input, hotkey);
    expect([a1()?.bl, a1()?.it ?? 0]).toEqual([1, 0]);
});
