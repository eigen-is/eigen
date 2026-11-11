// A press of undo or redo that finds nothing left because a peer's batch took it away shows a notice. Driven through the
// real keys and the real Edit menu on a mounted Workbook, with the peer's batch through its applyOp.

import { afterEach, expect, test } from 'bun:test';
import { parseHotkey } from '@tanstack/react-hotkeys';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, openSubmenu } from '@workspace/ui/test/menu-rows';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DocSearchProvider } = await import('@workspace/ui/components/search/doc-search-provider');
const { Workbook } = await import('../../../components/Workbook');
type Op = import('../../../state').Op;
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const CANT_UNDO = "This spreadsheet was replaced or edited by someone else, so this can't be undone anymore.";
const CANT_REDO = "This spreadsheet was replaced or edited by someone else, so this can't be redone anymore.";
// Longer than the delay SheetOverlay shows a notice after.
const NOTICE_DELAY_MS = 300;

// A peer types into a cell far from everything these tests do, in a sheet of ten rows or, after a row delete, of nine.
const peerEditInRow = (r: number): Op[] => [{ op: 'replace', id: 's1', path: ['data', r, 4, 'v'], value: 'peer' }];
const PEER_EDIT = peerEditInRow(8);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: 10,
            column: 5,
            celldata: [
                { r: 8, c: 4, v: { v: 'old', m: 'old' } },
                { r: 9, c: 4, v: { v: 'old', m: 'old' } },
            ],
            config: {},
        },
    ];
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {}, canReplace: true };
    await act(async () => {
        root.render(
            createElement(DocSearchProvider, {
                controller,
                children: createElement(Workbook, { ref, data, hooks: {} }),
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

    const workbook = () => {
        if (!ref.current) throw new Error('workbook did not mount');
        return ref.current;
    };

    const press = async (hotkey: string, target: Element = input) => {
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
    };

    const openEditMenu = async () => {
        const trigger = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
            (button) => button.textContent === 'Edit',
        );
        await act(async () => {
            trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        });
    };

    return {
        workbook,
        openEditMenu,
        undo: () => press('Mod+Z'),
        undoWhereTheFocusIs: () => press('Mod+Z', document.activeElement ?? document.body),
        redo: () => press('Mod+Shift+Z'),
        bold: () => act(async () => workbook().setCellFormat(0, 0, 'bl', 1)),
        a1Bold: () => workbook().getAllSheets()[0]?.data?.[0]?.[0]?.bl,
        rows: () => workbook().getAllSheets()[0]?.data?.length,
        peer: (ops: Op[] = PEER_EDIT) =>
            act(async () => {
                workbook().applyOp(ops);
            }),
        // A structural entry, made as a user makes it.
        deleteRow: async () => {
            await openEditMenu();
            await openSubmenu('Delete');
            await clickRow('Row');
        },
    };
}

const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, NOTICE_DELAY_MS)));

// The message of the notice on screen after the delay, closed with its OK so the next press starts clean; undefined with
// no notice. The wait after OK proves nothing reopens it.
async function takeNotice() {
    await wait();
    const notice = document.querySelector('[role="dialog"]');
    if (!notice) return undefined;
    const message = document.getElementById(notice.getAttribute('aria-describedby') ?? '')?.textContent;
    const ok = [...notice.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === 'OK');
    await act(async () => ok?.click());
    await wait();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    return message;
}

test("a peer's edit, then undo, shows the notice once per press and leaves the grid as it is", async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    expect(sheet.rows()).toBe(9);
    await sheet.peer();

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
    expect(sheet.rows()).toBe(9);
    expect(await takeNotice()).toBeUndefined();

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test("a peer's edit that cuts only the undo stack leaves redo silent", async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.peer();

    await sheet.redo();
    expect(await takeNotice()).toBeUndefined();
});

test("a peer's edit that cuts the redo stack shows the redo notice, and undo stays silent", async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.undo();
    expect(sheet.rows()).toBe(10);
    await sheet.peer();

    await sheet.redo();
    expect(await takeNotice()).toBe(CANT_REDO);
    expect(sheet.rows()).toBe(10);

    await sheet.undo();
    expect(await takeNotice()).toBeUndefined();
});

test('working alone, undo and redo on an empty stack never show a notice', async () => {
    const sheet = await mount();
    await sheet.undo();
    await sheet.redo();
    await sheet.deleteRow();
    await sheet.undo();
    await sheet.undo();
    await sheet.redo();
    await sheet.redo();
    expect(sheet.rows()).toBe(9);
    expect(await takeNotice()).toBeUndefined();
});

test('a new edit of your own clears it', async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.peer();

    await sheet.bold();
    await sheet.undo();
    expect(sheet.a1Bold()).toBeFalsy();
    await sheet.undo();
    expect(await takeNotice()).toBeUndefined();
});

test('a cell entry above the cut undoes with no notice, and the next press shows it', async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.bold();
    await sheet.peer();

    await sheet.undo();
    expect(sheet.a1Bold()).toBeFalsy();
    expect(await takeNotice()).toBeUndefined();

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test('a batch that cuts nothing sets nothing', async () => {
    const sheet = await mount();
    await sheet.bold();
    await sheet.peer();

    await sheet.undo();
    expect(sheet.a1Bold()).toBeFalsy();
    await sheet.undo();
    expect(await takeNotice()).toBeUndefined();
});

test('a later batch that cuts nothing keeps it', async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.peer();
    await sheet.peer();

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test("a peer's batch that fails to apply sets nothing", async () => {
    const sheet = await mount();
    await sheet.deleteRow();
    await sheet.peer([{ op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index: -1 } }]);

    await sheet.undo();
    expect(sheet.rows()).toBe(10);
    expect(await takeNotice()).toBeUndefined();
});

test("a peer's rename takes both stacks, plain cell edits included", async () => {
    const sheet = await mount();
    await sheet.bold();
    await sheet.peer([{ op: 'renameSheet', id: 's1', path: [], value: { name: 'Two' } }]);

    await sheet.undo();
    expect(sheet.a1Bold()).toBe(1);
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test("a peer's delete of the row a cell entry wrote takes that entry", async () => {
    const sheet = await mount();
    await sheet.bold();
    await sheet.peer([{ op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 0, end: 0 } }]);

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test('a late batch that makes the tab apply the log again takes both stacks', async () => {
    const sheet = await mount();
    const base = sheet.workbook().getAllSheets();
    await sheet.bold();
    await act(async () => {
        sheet.workbook().replayOps(base, [PEER_EDIT], new Set([PEER_EDIT]));
    });

    await sheet.undo();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

// An import that replaces the workbook brings sheets with new ids, so the grid moves to the first one and its A1.
test('a new snapshot without the sheet on screen keeps the focus on the grid, so undo shows the notice', async () => {
    const sheet = await mount();
    await sheet.bold();
    const imported: Sheet[] = [{ id: 's9', name: 'Imported', order: 0, row: 10, column: 5, celldata: [], config: {} }];
    await act(async () => {
        sheet.workbook().replayOps(imported, [], new Set());
    });

    await sheet.undoWhereTheFocusIs();
    expect(await takeNotice()).toBe(CANT_UNDO);
});

test('the Edit menu keeps Undo pressable when a peer took it away, and pressing it shows the notice', async () => {
    const sheet = await mount();
    const disabled = (label: string) =>
        [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
            .find((entry) => entry.textContent?.trim().startsWith(label))
            ?.hasAttribute('data-disabled');

    await sheet.openEditMenu();
    expect(disabled('Undo')).toBe(true);
    expect(disabled('Redo')).toBe(true);
    await clickRow('Paint format');

    await sheet.deleteRow();
    await sheet.peer();

    await sheet.openEditMenu();
    expect(disabled('Undo')).toBe(false);
    expect(disabled('Redo')).toBe(true);
    const undoRow = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((entry) =>
        entry.textContent?.trim().startsWith('Undo'),
    );
    await act(async () => undoRow?.click());
    expect(await takeNotice()).toBe(CANT_UNDO);
});
