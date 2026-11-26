// The leave guard of a collaborative editor, such as Docs or Sheets. Edits made while offline live only in the tab's
// document until the server takes them, so leaving the page, reloading it or closing the tab would drop them. A change
// of the page's search, such as opening a comment thread, keeps the editor and its document, so it passes. The editor
// renders it with useCollabDoc's `unsyncedEdits`.

import { LeaveGuard } from './leave-guard';

type UnsyncedEditsGuardProps = {
    active: boolean;
};

export function UnsyncedEditsGuard({ active }: UnsyncedEditsGuardProps) {
    return (
        <LeaveGuard
            active={active}
            allowSearchChange
            question={{
                title: 'Leave without syncing?',
                description:
                    'Edits made while offline have not reached the server yet. If you leave now they are lost.',
                cancelText: 'Stay',
                confirmText: 'Leave',
            }}
        />
    );
}
