// The menu a Drive listing opens on its rows, by right-click, long-press or a row's ⋮. It acts on the
// whole selection when the clicked row is part of a multi-selection, and on that row alone otherwise.
// DriveTable and DriveGrid mount one each; a listing with its own actions, such as Trash, draws its own body.

import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types';
import type React from 'react';
import { useMemo } from 'react';
import { ContextMenuAnchor } from '../context-menu';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveItemMenuItems } from './drive-item-menu';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveItemContextMenuProps = {
    controller: ReturnType<typeof useDriveItemController>;
    // The listing behind the menu, in its display order: Quick preview pages through it.
    items: DrivePath[];
    actions?: DriveActionRunner;
    // Replaces the default menu body, for a listing with actions of its own (Trash).
    renderItems?: (items: DrivePath[], close: () => void) => React.ReactNode;
};

function contextItemsOf({ contextMenu, selection }: DriveItemContextMenuProps['controller']): DrivePath[] {
    if (!contextMenu.item) return [];
    return selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item];
}

export function DriveItemContextMenu({ controller, items, actions, renderItems }: DriveItemContextMenuProps) {
    // Separate components: a listing with its own body (Trash) draws no registry row, so it must not mount the runner.
    if (actions) return <DriveItemActionsMenu controller={controller} items={items} actions={actions} />;
    const { contextMenu } = controller;
    const contextItems = contextItemsOf(controller);
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {contextItems.length > 0 && renderItems?.(contextItems, contextMenu.close)}
        </ContextMenuAnchor>
    );
}

function DriveItemActionsMenu({
    controller,
    items,
    actions,
}: DriveItemContextMenuProps & { actions: DriveActionRunner }) {
    const { contextMenu } = controller;
    const contextItems = contextItemsOf(controller);
    const { canWrite } = actions.capabilities;

    // A multi-selection has no file actions, so its runner has no subject.
    const single = contextItems.length === 1 ? contextItems[0] : null;
    const subject = useMemo(() => (single ? subjectFromPath(single, canWrite) : null), [single, canWrite]);
    // Mapped only while the menu is open: a folder listing can run to thousands of rows.
    const siblings = useMemo(
        () => (single ? items.map((item) => subjectFromPath(item, canWrite)) : []),
        [single, items, canWrite],
    );
    const runner = useFileActionRunner(subject, siblings);

    return (
        <>
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
                {contextItems.length > 0 && (
                    <DriveItemMenuItems items={contextItems} actions={actions} runner={runner} />
                )}
            </ContextMenuAnchor>
            {runner.dialogs}
        </>
    );
}
