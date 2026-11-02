// The menu a Drive listing opens on its rows, by right-click, long-press or a row's ⋮. It acts on the
// whole selection when the clicked row is part of a multi-selection, and on that row alone otherwise.
// DriveTable and DriveGrid mount one each. A listing with actions of its own, such as Trash, gets its own
// rows in their menu groups instead of the Drive item menu.

import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Fragment } from 'react';
import { ContextMenuAnchor } from '../context-menu';
import { inMenuOrder } from '../context-menu/menu-sections';
import { DropdownMenuSeparator } from '../dropdown-menu';
import { DriveActionMenuItem } from './drive-action-menu-item';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveItemMenuItems } from './drive-item-menu';
import { useDriveFileActionRunner } from './use-drive-file-action-runner';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveItemContextMenuProps = {
    controller: ReturnType<typeof useDriveItemController>;
    // The listing behind the menu, in its display order: Quick preview pages through it.
    items: readonly DrivePath[];
    actions?: DriveActionRunner;
    // The rows of a listing with actions of its own, such as Trash, for the items the menu acts on.
    ownActions?: (items: readonly DrivePath[]) => PaletteSelectionAction[];
};

function contextItemsOf({ contextMenu, selection }: DriveItemContextMenuProps['controller']): DrivePath[] {
    if (!contextMenu.item) return [];
    return selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item];
}

export function DriveItemContextMenu({ controller, items, actions, ownActions }: DriveItemContextMenuProps) {
    if (actions) return <DriveItemActionsMenu controller={controller} items={items} actions={actions} />;
    const { contextMenu } = controller;
    const contextItems = contextItemsOf(controller);
    const rows = contextItems.length > 0 ? inMenuOrder(ownActions?.(contextItems) ?? []) : [];
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {rows.map(({ action, run }, index) => (
                <Fragment key={action.id}>
                    {index > 0 && action.group !== rows[index - 1].action.group && <DropdownMenuSeparator />}
                    <DriveActionMenuItem
                        action={action}
                        count={contextItems.length}
                        onClick={() => {
                            run();
                            contextMenu.close();
                        }}
                    />
                </Fragment>
            ))}
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
    const runner = useDriveFileActionRunner(
        contextItems.length === 1 ? contextItems[0] : null,
        items,
        actions.capabilities.canWrite,
    );

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
