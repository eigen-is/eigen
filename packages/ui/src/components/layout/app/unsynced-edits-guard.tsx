import { LeaveGuard } from './leave-guard';

type UnsyncedEditsGuardProps = {
    // From useCollabDoc's `unsyncedEdits` — edits are waiting for a socket that can carry them.
    active: boolean;
};

// Collab edits live only in the tab's Y.Doc until the server acknowledges them, so leaving drops them.
export function UnsyncedEditsGuard({ active }: UnsyncedEditsGuardProps) {
    return (
        <LeaveGuard
            active={active}
            title="Leave without syncing?"
            description="Edits made while offline have not reached the server yet. If you leave now they are lost."
        />
    );
}
