// Draws the file actions a runner offers as menu rows, such as Quick preview, Download or a convert. Every
// menu that acts on a file draws them through this component, for example a Drive item's menu or a mail
// attachment's, so a new file action shows up in all of them.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { FileActionGroup } from '@workspace/lib/types/file-subject';
import { MenuSections } from '../context-menu/menu-sections';
import { DropdownMenuItem, DropdownMenuShortcut } from '../dropdown-menu';
import type { FileActionRunner } from './use-file-action-runner';

type FileActionMenuItemsProps = {
    // Built by the host with useFileActionRunner, above the menu: the picker a row opens has to
    // outlive the menu content, which unmounts on close.
    runner: FileActionRunner;
    // A host with rows of its own in a group (Drive's Open, Rename, Download ▸) draws each group where it goes.
    group?: FileActionGroup;
    // The host binds the rows' hotkeys, as a Drive listing binds Space to Quick preview, so the menu names them.
    shortcuts?: boolean;
};

// Without a group, every group in its place; with one, that group's rows in the registry's order.
export function FileActionMenuItems({ runner, group, shortcuts }: FileActionMenuItemsProps) {
    if (!group) {
        const rowsOf = (g: FileActionGroup) =>
            runner.actions.some((action) => action.group === g) && (
                <FileActionMenuItems runner={runner} group={g} shortcuts={shortcuts} />
            );
        return <MenuSections open={rowsOf('open')} convert={rowsOf('convert')} output={rowsOf('output')} />;
    }
    return runner.actions
        .filter((action) => action.group === group)
        .map((action) => (
            <DropdownMenuItem key={action.id} disabled={runner.isPending} onClick={() => runner.run(action)}>
                <action.icon className="h-4 w-4" />
                {action.label}
                {shortcuts && action.shortcut && (
                    <DropdownMenuShortcut>{formatForDisplay(action.shortcut)}</DropdownMenuShortcut>
                )}
            </DropdownMenuItem>
        ));
}
