// Hands the command palette what a Drive listing has selected and the rows it can run on it. In a Drive
// view these are the rows the item's menu draws, in the menu's order: the runner's Drive actions, the
// file actions of a single item and Watch with its live state. A listing with actions of its own, such
// as Trash, hands over its own rows instead. DriveList mounts one beside its rows.

import { useCommandPalette, usePaletteSelection } from '@workspace/lib/command-palette';
import { useWatchToggle } from '@workspace/lib/drive';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath, ExportFormat } from '@workspace/lib/types/drive';
import { Bell, BellRing } from 'lucide-react';
import { inMenuOrder } from '../context-menu/menu-sections';
import type { DriveActionRunner } from './drive-action-runner';
import { useDriveFileActionRunner } from './use-drive-file-action-runner';

type DrivePaletteSelectionProps = {
    items: readonly DrivePath[];
    // The listing the items sit in, in its display order: Quick preview pages through it.
    listing: readonly DrivePath[];
    actions?: DriveActionRunner;
    // The rows of a listing with actions of its own, such as Trash, for the selected items.
    ownActions?: (items: readonly DrivePath[]) => PaletteSelectionAction[];
};

export function DrivePaletteSelection({ items, listing, actions, ownActions }: DrivePaletteSelectionProps) {
    if (actions) return <DriveActionsPalette items={items} listing={listing} actions={actions} />;
    return <OwnActionsPalette items={items} actions={ownActions?.(items) ?? []} />;
}

function DriveActionsPalette({ items, listing, actions }: DrivePaletteSelectionProps & { actions: DriveActionRunner }) {
    // A multi-selection has no file actions and no Watch.
    const single = items.length === 1 ? items[0] : null;
    const runner = useDriveFileActionRunner(single, listing, actions.capabilities.canWrite);
    // The watch state is a request per item, so it is read only while the palette shows it.
    const { open } = useCommandPalette();
    const watched = open ? single : null;
    const watch = useWatchToggle(watched?.ownerId ?? '', watched?.mountId ?? '', watched?.id ?? '');

    const driveRows = actions.actionsFor(items).map((action) => ({
        action,
        run: (format?: ExportFormat) => actions.run(action.id, items, format),
    }));
    const watchRows: PaletteSelectionAction[] = single
        ? [
              {
                  action: {
                      id: 'watch',
                      label: watch.label,
                      icon: watch.direct ? BellRing : Bell,
                      group: 'collaborate',
                  },
                  run: watch.toggle,
              },
          ]
        : [];
    const fileRows = runner.actions.map((action) => ({ action, run: () => runner.run(action) }));
    usePaletteSelection(items, inMenuOrder([...driveRows, ...watchRows, ...fileRows]));

    return runner.dialogs;
}

function OwnActionsPalette({ items, actions }: { items: readonly DrivePath[]; actions: PaletteSelectionAction[] }) {
    usePaletteSelection(items, actions);
    return null;
}
