// The Delete key runs the listing's delete row and no other destructive row, and the menu key opens the menu at the
// row or tile under the cursor. A folder is a drop target only where the view can move items.
import { expect, test } from 'bun:test';
import { DELETE_HOTKEY } from '@workspace/lib/constants/hotkeys';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveAction, DriveActionId } from '@workspace/lib/types/drive-actions';
import { Trash2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { DriveActionRunner } from '../../../components/drive/drive-action-runner';
import type { UseListSelectionReturn } from '../../../hooks/use-list-selection';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, createRef, useRef } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { useDriveItemController } = await import('../../../components/drive/use-drive-item-controller');

const folder = drivePath({ id: 'folder-1', name: 'Plans', type: 'folder', mimeType: 'inode/directory' });

// No state updates run in a static render, so the selection is a frozen stand-in with the folder selected.
const selection: UseListSelectionReturn<DrivePath> = {
    selectedIds: new Set([folder.id]),
    isSelected: (id) => id === folder.id,
    selectedItems: [folder],
    selectedCount: 1,
    hasSelection: true,
    select: () => {},
    toggle: () => {},
    selectRange: () => {},
    selectAll: () => {},
    setSelection: () => {},
    clearSelection: () => {},
    handleItemClick: () => {},
};

const destructive = (id: DriveActionId): DriveAction => ({
    id,
    label: id,
    icon: Trash2,
    group: 'destructive',
    applies: () => true,
});

// A runner whose rows are the given ones, recording the ids it runs.
function runner(rows: DriveAction[], onMove?: DriveActionRunner['onMove']) {
    const ran: DriveActionId[] = [];
    const actions: DriveActionRunner = {
        capabilities: DRIVE_CAPABILITIES.browse,
        actionsFor: () => rows,
        run: (id) => ran.push(id),
        onMove,
        onCreateEigenDoc: {},
        dialogs: null,
    };
    return { actions, ran };
}

function render(actions: DriveActionRunner) {
    const seen: { controller: ReturnType<typeof useDriveItemController> | null } = { controller: null };
    function Harness() {
        seen.controller = useDriveItemController({
            items: [folder],
            containerRef: createRef<HTMLElement>(),
            selection,
            actions,
        });
        return null;
    }
    renderToStaticMarkup(createElement(Harness));
    if (!seen.controller) throw new Error('the controller did not render');
    return seen.controller;
}

test('Delete and Backspace run the row that shows the delete key, even after another destructive row', () => {
    for (const key of ['Delete', 'Backspace']) {
        const { actions, ran } = runner([destructive('rename'), { ...destructive('trash'), shortcut: DELETE_HOTKEY }]);
        // The key is pressed on the list itself, which the hook checks before it acts.
        const list = document.createElement('div');
        render(actions).handleKeyDown({
            key,
            target: list,
            currentTarget: list,
            preventDefault: () => {},
            stopPropagation: () => {},
        } as unknown as KeyboardEvent<HTMLElement>);
        expect(ran).toEqual(['trash']);
    }
});

test('a folder is a drop target only where the view can move', () => {
    expect(render(runner([]).actions).isValidFolderDrop(folder)).toBe(false);
    expect(render(runner([], () => {}).actions).isValidFolderDrop(folder)).toBe(true);
});

const FILES = ['a', 'b', 'c', 'd'].map((id) =>
    drivePath({ id, name: `${id}.txt`, type: 'file', mimeType: 'text/plain' }),
);

// The listing as the table and the grid draw it: one element per virtual row, carrying data-index, holding its row or
// its tiles. Each item reports a rect of its own, as the browser would lay it out.
async function renderListing(columns: number, cursorId: string) {
    const seen: { controller: ReturnType<typeof useDriveItemController> | null } = { controller: null };
    function Listing() {
        const containerRef = useRef<HTMLDivElement>(null);
        const controller = useDriveItemController({ items: FILES, activeItemId: cursorId, columns, containerRef });
        seen.controller = controller;
        const rows = Array.from({ length: Math.ceil(FILES.length / columns) }, (_, r) =>
            FILES.slice(r * columns, (r + 1) * columns),
        );
        return createElement(
            'div',
            { ref: containerRef, tabIndex: 0, onKeyDown: controller.handleKeyDown },
            rows.map((row, r) =>
                createElement(
                    'div',
                    { key: r, 'data-index': r },
                    row.map((item) => createElement('div', { key: item.id, 'data-item': item.id })),
                ),
            ),
        );
    }
    const { container, unmount } = await renderInDocument(createElement(Listing));
    for (const [i, item] of [...container.querySelectorAll('[data-item]')].entries()) {
        if (item instanceof HTMLElement) item.getBoundingClientRect = () => new DOMRect(i * 100, i * 10, 50, 5);
    }
    const list = container.querySelector('[tabindex]');
    if (!list) throw new Error('no listing');
    await act(async () => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    });
    const menu = seen.controller?.contextMenu;
    await unmount();
    return { item: menu?.item?.id, position: menu?.position };
}

test('the menu key opens the menu at the row under the cursor, in the table and in the grid', async () => {
    // The fourth item: the table's fourth row, the grid's second tile on its second row.
    expect(await renderListing(1, 'd')).toEqual({ item: 'd', position: { x: 350, y: 35 } });
    expect(await renderListing(2, 'd')).toEqual({ item: 'd', position: { x: 350, y: 35 } });
    expect(await renderListing(2, 'c')).toEqual({ item: 'c', position: { x: 250, y: 25 } });
});

// A picker's table, such as DriveBrowser's, mounts no row menu. The key must neither open one nor select the cursor's
// row, which in a multi-select picker would replace the rows the user picked.
test('the menu key does nothing in a view without a row menu', async () => {
    const selected: string[] = [];
    const picked: UseListSelectionReturn<DrivePath> = {
        ...selection,
        isSelected: (id) => id === 'a' || id === 'b',
        select: (id) => selected.push(id),
    };
    const seen: { controller: ReturnType<typeof useDriveItemController> | null } = { controller: null };
    function Picker() {
        const containerRef = useRef<HTMLDivElement>(null);
        seen.controller = useDriveItemController({
            items: FILES,
            activeItemId: 'c',
            containerRef,
            selection: picked,
            hasMenu: false,
        });
        return createElement('div', { ref: containerRef, tabIndex: 0, onKeyDown: seen.controller.handleKeyDown });
    }
    const { container, unmount } = await renderInDocument(createElement(Picker));
    selected.length = 0;
    const list = container.querySelector('[tabindex]');
    if (!list) throw new Error('no listing');
    const event = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
    await act(async () => {
        list.dispatchEvent(event);
    });
    expect([event.defaultPrevented, selected, seen.controller?.contextMenu.item]).toEqual([false, [], null]);
    await unmount();
});
