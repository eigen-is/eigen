// The Delete key runs the listing's delete row and no other destructive row. A folder is a drop target
// only where the view can move items.
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

installHappyDom();

const { createElement, createRef } = await import('react');
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
        render(actions).handleKeyDown({
            key,
            preventDefault: () => {},
            stopPropagation: () => {},
        } as unknown as KeyboardEvent<HTMLElement>);
        expect(ran).toEqual(['trash']);
    }
});

test('a folder is a drop target only where the view can move', () => {
    expect(render(runner([]).actions).isValidFolderDrop(folder)).toBe(false);
    expect(render(runner([], async () => {}).actions).isValidFolderDrop(folder)).toBe(true);
});
