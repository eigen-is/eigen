// While a cell is open, the menu bar works on the editor: the format toolbar shows the run at the caret, and
// a format picked from a menu, a popover or the size box leaves the focus in the editor with its selection,
// so the next keys type there and Enter commits.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, createRef, Fragment } = await import('react');
const { createRoot } = await import('react-dom/client');
const { produce } = await import('immer');
const { WorkbookContext } = await import('../../../context');
const { useCellEditorRefocus } = await import('../../../hooks/useCellEditorRefocus');
const { useEditorSelectionStyle } = await import('../../../hooks/useEditorSelectionStyle');
const { InputBox } = await import('../../../components/SheetOverlay/InputBox');
const { MenuBar } = await import('../../../components/MenuBar');
const { committedRuns, defaultContext, defaultSettings, FormulaCache } = await import('../../../state');
type Context = import('../../../state').Context;

const refs = {
    globalCache: {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set<() => void>(),
        notifyScrollListeners: () => {},
    },
    cellInput: createRef<HTMLDivElement | null>(),
    fxInput: createRef<HTMLDivElement | null>(),
    canvas: createRef<HTMLCanvasElement | null>(),
    cellArea: createRef<HTMLDivElement | null>(),
    workbookContainer: createRef<HTMLDivElement | null>(),
};

// The handler the menu bar gives its menus as they close.
let refocusCellEditor: ((event: Event) => void) | undefined;
function RefocusProbe() {
    refocusCellEditor = useCellEditorRefocus();
    return null;
}

// Every style the hook handed out, so a test sees whether a caret move gave the toolbar a new one.
const caretStyles: unknown[] = [];
function CaretStyleProbe() {
    caretStyles.push(useEditorSelectionStyle());
    return null;
}

// Waits out the timers the editor and Radix run, such as the one on which a closing menu hands back the focus.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

const BIG =
    '<span style="font-weight: bold; font-style: italic; font-size: 18pt; font-family: &quot;Source Serif 4&quot;, sans-serif">big</span>';

// The menu bar and an editor open on A1, their recipes applied the way the Workbook applies them.
async function openEditor(html: string) {
    let context: Context = {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config: {}, data: [[null, null]] }],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [0, 0],
        formulaCache: new FormulaCache(),
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        setContext: (recipe: (ctx: Context) => void) => {
                            context = produce(context, recipe);
                            render();
                        },
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                    },
                },
                createElement(
                    Fragment,
                    null,
                    createElement(MenuBar),
                    createElement(InputBox),
                    createElement(RefocusProbe),
                    createElement(CaretStyleProbe),
                ),
            ),
        );
    await act(async () => render());
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    // The editor puts its caret at the end on a timer as it opens.
    await settle();
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('the cell editor did not render');
    input.innerHTML = html;
    return { container, input };
}

// The point `offset` characters into the editor's text.
function textPoint(root: Node, offset: number): [Node, number] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (left <= length) return [node, left];
        left -= length;
    }
    throw new Error(`offset ${offset} is past the text`);
}

async function select(root: Node, start: number, end = start) {
    await act(async () => {
        const range = document.createRange();
        range.setStart(...textPoint(root, start));
        range.setEnd(...textPoint(root, end));
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
    });
}

// A menu's trigger takes the focus as the user clicks it, as a menu bar button does in the browser.
async function openMenu(container: HTMLElement, label: string) {
    const trigger = [...container.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent?.trim() === label,
    );
    if (!trigger) throw new Error(`no ${label} menu`);
    trigger.focus();
    await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

function selectedText() {
    return document.getSelection()?.toString();
}

const fontButton = (container: HTMLElement) => container.querySelector('button[aria-haspopup="menu"] span.text-xs');
const sizeBox = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
const boldButton = (container: HTMLElement) => container.querySelector('button[aria-label="Bold"]');

test('the toolbar shows the run at the caret, and moves with it', async () => {
    const { container, input } = await openEditor(`hello ${BIG} world`);
    await select(input, 7);
    expect(fontButton(container)?.textContent).toBe('Source Serif 4');
    expect(sizeBox(container)?.value).toBe('18');
    expect(boldButton(container)?.className).toContain('bg-secondary');
    await select(input, 2);
    expect(fontButton(container)?.textContent).toBe('Inter');
    expect(sizeBox(container)?.value).toBe('10');
    expect(boldButton(container)?.className).not.toContain('bg-secondary');
});

// The toolbar and the Format menu re-render only when the style at the caret changes.
test('a caret moved inside one run keeps the style it had', async () => {
    const { input } = await openEditor('hello world');
    await select(input, 1);
    const style = caretStyles.at(-1);
    expect(style).toMatchObject({ bl: 0, fs: 10 });
    await select(input, 3);
    expect(caretStyles.at(-1)).toBe(style);
});

test('a font picked from the toolbar leaves the focus and the selection in the editor', async () => {
    const { container, input } = await openEditor('hello big world');
    await select(input, 6, 9);
    await openMenu(container, 'Inter');
    await clickRow('JetBrains Mono');
    await settle();
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    expect(selectedText()).toBe('big');
    expect(committedRuns(input, null).map(({ v, ff }) => [v, ff])).toEqual([
        ['hello ', 'Inter'],
        ['big', 'JetBrains Mono'],
        [' world', 'Inter'],
    ]);
});

test('Format › Text › Strikethrough leaves the focus and the selection in the editor', async () => {
    const { container, input } = await openEditor('hello big world');
    await select(input, 6, 9);
    await openMenu(container, 'Format');
    await openSubmenu('Text');
    await clickRow('Strikethrough (Alt+Shift+5)');
    await settle();
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    expect(selectedText()).toBe('big');
    expect(committedRuns(input, null).map(({ v, cl }) => [v, cl])).toEqual([
        ['hello ', 0],
        ['big', 1],
        [' world', 0],
    ]);
});

test('a size typed in the box applies on Enter and hands the focus back to the editor', async () => {
    const { container, input } = await openEditor('hello big world');
    await select(input, 6, 9);
    const box = sizeBox(container);
    if (!box) throw new Error('no size box');
    await act(async () => {
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, '18');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
        box.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    expect(selectedText()).toBe('big');
    expect(committedRuns(input, null).map(({ v, fs }) => [v, fs])).toEqual([
        ['hello ', 10],
        ['big', 18],
        [' world', 10],
    ]);
});

test('Enter on an unchanged size still hands the focus back to the editor', async () => {
    const { container, input } = await openEditor('hello big world');
    await select(input, 6, 9);
    const box = sizeBox(container);
    if (!box) throw new Error('no size box');
    await act(async () => {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    expect(selectedText()).toBe('big');
});

// A menu item can open a dialog, such as Data verification, that takes the focus as the menu closes. The
// editor leaves the focus there.
test('a closing menu leaves the focus in a dialog that took it', async () => {
    const { input } = await openEditor('hello big world');
    await select(input, 6, 9);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const field = document.createElement('input');
    dialog.append(field);
    document.body.append(dialog);
    field.focus();
    const close = new Event('focusOutside', { cancelable: true });
    act(() => refocusCellEditor?.(close));
    expect(close.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    dialog.remove();
});
