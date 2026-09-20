import { DropdownMenuItem } from '../dropdown-menu';
import type { FileActionRunner } from './use-file-action-runner';

type FileActionMenuItemsProps = {
    // Built by the host with useFileActionRunner, above the menu: the picker a row opens has to
    // outlive the menu content, which unmounts on close.
    runner: FileActionRunner;
};

// The one place a file action is drawn as a menu row, in the registry's order. A surface that adds
// a row to FILE_ACTIONS gets it in every menu without editing one.
export function FileActionMenuItems({ runner }: FileActionMenuItemsProps) {
    return (
        <>
            {runner.actions.map((action) => (
                <DropdownMenuItem
                    key={action.id}
                    disabled={runner.isPending}
                    onClick={() => runner.run(action)}
                    className="flex items-center"
                >
                    <action.icon className="h-4 w-4 mr-2" />
                    {action.label}
                </DropdownMenuItem>
            ))}
        </>
    );
}
