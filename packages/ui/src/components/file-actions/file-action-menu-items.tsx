import type { FileActionGroup } from '@workspace/lib/types/file-subject';
import { MenuSections } from '../context-menu/menu-sections';
import { DropdownMenuItem } from '../dropdown-menu';
import type { FileActionRunner } from './use-file-action-runner';

type FileActionMenuItemsProps = {
    // Built by the host with useFileActionRunner, above the menu: the picker a row opens has to
    // outlive the menu content, which unmounts on close.
    runner: FileActionRunner;
    // A host with rows of its own in a group (Drive's Open, Rename, Download ▸) draws each group where it goes.
    group?: FileActionGroup;
};

// The one place a file action is drawn as a menu row, in the registry's order within its menu group. A surface that
// adds a row to FILE_ACTIONS gets it in every menu without editing one.
export function FileActionMenuItems({ runner, group }: FileActionMenuItemsProps) {
    if (!group) {
        const rowsOf = (g: FileActionGroup) =>
            runner.actions.some((action) => action.group === g) && <FileActionMenuItems runner={runner} group={g} />;
        return <MenuSections open={rowsOf('open')} convert={rowsOf('convert')} output={rowsOf('output')} />;
    }
    return runner.actions
        .filter((action) => action.group === group)
        .map((action) => (
            <DropdownMenuItem key={action.id} disabled={runner.isPending} onClick={() => runner.run(action)}>
                <action.icon className="h-4 w-4" />
                {action.label}
            </DropdownMenuItem>
        ));
}
