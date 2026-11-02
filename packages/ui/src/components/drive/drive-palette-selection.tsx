// Hands the command palette what a Drive listing has selected and the rows it can run on it. In a Drive
// view these are the rows the item's menu draws, in the menu's order: the runner's Drive actions, the
// file actions of a single item and Watch with its live state. A listing with actions of its own, such
// as Trash, hands over its own rows instead. DriveList mounts one beside its rows.

import { usePaletteSelection } from '@workspace/lib/command-palette';
import { useWatchToggle } from '@workspace/lib/drive';
import { subjectFromPath } from '@workspace/lib/file-subject';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath, ExportFormat } from '@workspace/lib/types/drive';
import { Bell } from 'lucide-react';
import { useMemo } from 'react';
import { MENU_SECTIONS } from '../context-menu/menu-sections';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import type { DriveActionRunner } from './drive-action-runner';

type DrivePaletteSelectionProps = {
    items: DrivePath[];
    // The listing the items sit in, in its display order: Quick preview pages through it.
    listing: DrivePath[];
    actions?: DriveActionRunner;
    // The rows of a listing with actions of its own (Trash), for the selected items.
    ownActions?: (items: DrivePath[]) => PaletteSelectionAction[];
};

export function DrivePaletteSelection({ items, listing, actions, ownActions }: DrivePaletteSelectionProps) {
    // Separate components: a listing with its own actions (Trash) offers no registry row, so it mounts no runner.
    if (actions) return <DriveActionsPalette items={items} listing={listing} actions={actions} />;
    return <OwnActionsPalette items={items} actions={ownActions?.(items) ?? []} />;
}

function DriveActionsPalette({ items, listing, actions }: DrivePaletteSelectionProps & { actions: DriveActionRunner }) {
    const { canWrite } = actions.capabilities;
    // A multi-selection has no file actions and no Watch, so its runner has no subject.
    const single = items.length === 1 ? items[0] : null;
    const subject = useMemo(() => (single ? subjectFromPath(single, canWrite) : null), [single, canWrite]);
    const siblings = useMemo(
        () => (single ? listing.map((item) => subjectFromPath(item, canWrite)) : []),
        [single, listing, canWrite],
    );
    const runner = useFileActionRunner(subject, siblings);
    const watch = useWatchToggle(single?.ownerId ?? '', single?.mountId ?? '', single?.id ?? '');

    const rows = [
        ...actions
            .actionsFor(items)
            .map((action) => ({ action, run: (format?: ExportFormat) => actions.run(action.id, items, format) })),
        ...(single
            ? [{ action: { id: 'watch', label: watch.label, icon: Bell, group: 'collaborate' }, run: watch.toggle }]
            : []),
        ...runner.actions.map((action) => ({ action, run: () => runner.run(action) })),
    ];
    usePaletteSelection(
        items,
        MENU_SECTIONS.flatMap((section) => rows.filter(({ action }) => action.group === section)),
    );

    return runner.dialogs;
}

function OwnActionsPalette({ items, actions }: { items: DrivePath[]; actions: PaletteSelectionAction[] }) {
    usePaletteSelection(items, actions);
    return null;
}
