// The menu rows for one Drive item or a multi-selection, drawn by the row's context menu and the detail
// column's ⋮. It draws the Drive actions the runner offers for the items beside the shared file actions,
// each in its menu group. The caller wraps it in ContextMenuAnchor or DropdownMenuContent.

import type { DrivePath } from '@workspace/lib/types/drive';
import { exportFormatsFor } from '@workspace/lib/types/drive';
import type { DriveAction, DriveActionGroup } from '@workspace/lib/types/drive-actions';
import { EXPORT_FORMAT_LABELS } from '@workspace/lib/types/drive-convert';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { UserRoundPlus } from 'lucide-react';
import { MenuSections } from '../context-menu/menu-sections';
import { FileActionMenuItems } from '../file-actions/file-action-menu-items';
import type { FileActionRunner } from '../file-actions/use-file-action-runner';
import { WatchMenuItem } from '../layout/toolbar/watch-toggle-button';
import { DriveActionMenuItem } from './drive-action-menu-item';
import type { DriveActionRunner } from './drive-action-runner';

type DriveItemMenuItemsProps = {
    items: readonly DrivePath[];
    actions: DriveActionRunner;
    // Built by the host on the single item, or on null for a multi-selection, which has no file actions.
    runner: FileActionRunner;
    // The host is the listing, whose keys run the rows, so the menu names them. The detail column's ⋮ isn't.
    shortcuts?: boolean;
};

export function DriveItemMenuItems({ items, actions, runner, shortcuts = false }: DriveItemMenuItemsProps) {
    const rows = actions.actionsFor(items);
    const [item] = items;

    const rowFor = (action: DriveAction) => (
        <DriveActionMenuItem
            key={action.id}
            action={action}
            count={items.length}
            shortcut={shortcuts ? action.shortcut : undefined}
            onClick={() => actions.run(action.id, items)}
        />
    );
    const rowsIn = (group: DriveActionGroup) => rows.filter((action) => action.group === group).map(rowFor);

    // Download picks a format, and one item's sharing rows sit together in a Share submenu.
    const downloadAs = rows.find((action) => action.id === 'download-as');
    const shareRows = rows.filter((action) => action.group === 'collaborate');

    return (
        <MenuSections
            open={
                <>
                    {rowsIn('open')}
                    <FileActionMenuItems runner={runner} group="open" shortcuts={shortcuts} />
                </>
            }
            create={rowsIn('create')}
            organize={rowsIn('organize')}
            convert={<FileActionMenuItems runner={runner} group="convert" />}
            output={
                <>
                    {downloadAs && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <downloadAs.icon className="h-4 w-4" />
                                {downloadAs.label}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {exportFormatsFor(item.type).map((format) => (
                                    <DropdownMenuItem
                                        key={format}
                                        onClick={() => actions.run('download-as', items, format)}
                                    >
                                        {EXPORT_FORMAT_LABELS[format]}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    <FileActionMenuItems runner={runner} group="output" />
                </>
            }
            collaborate={
                <>
                    {items.length === 1 && shareRows.length > 0 ? (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <UserRoundPlus className="h-4 w-4" />
                                Share
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>{shareRows.map(rowFor)}</DropdownMenuSubContent>
                        </DropdownMenuSub>
                    ) : (
                        shareRows.map(rowFor)
                    )}
                    {items.length === 1 && (
                        <WatchMenuItem ownerId={item.ownerId} mountId={item.mountId} pathId={item.id} />
                    )}
                </>
            }
            destructive={rowsIn('destructive')}
        />
    );
}
