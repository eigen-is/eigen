import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { useRestoreVersion, useSaveVersion, useVersions } from '@workspace/lib/versioning';
import { History, Save } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../dropdown-menu';
import { ConfirmDialog } from '../confirm-dialog';

// VersionHistoryMenu renders only the dropdown rows. Pair it with
// RestoreVersionDialog rendered OUTSIDE the parent <DropdownMenuContent>.
// If the dialog lives inside the dropdown's React subtree, Radix unmounts it
// the moment the dropdown closes — the dialog flashes and disappears.
export function VersionHistoryMenu({
    path,
    onRequestRestore,
}: {
    path: DrivePath;
    onRequestRestore: (snap: Snapshot) => void;
}) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const save = useSaveVersion(path.ownerId, path.mountId, path.id);

    return (
        <>
            <DropdownMenuItem onSelect={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4 mr-2" /> Save version now
            </DropdownMenuItem>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <History className="h-4 w-4 mr-2" /> Version history
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-64 overflow-y-auto min-w-[240px]">
                    {data && data.length > 0 ? (
                        data.map((snap) => (
                            <DropdownMenuItem
                                key={snap.id}
                                className="flex items-center justify-between gap-4"
                                onSelect={() => onRequestRestore(snap)}
                            >
                                <span>{formatDateTime(snap.createdAt)}</span>
                                <span className="text-xs text-muted-foreground">Restore</span>
                            </DropdownMenuItem>
                        ))
                    ) : (
                        <DropdownMenuItem disabled>No versions yet</DropdownMenuItem>
                    )}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        </>
    );
}

export function RestoreVersionDialog({
    path,
    snapshot,
    onClose,
}: {
    path: DrivePath;
    snapshot: Snapshot | null;
    onClose: () => void;
}) {
    const restore = useRestoreVersion(path.ownerId, path.mountId, path.id);

    return (
        <ConfirmDialog
            open={!!snapshot}
            onOpenChange={(open) => !open && onClose()}
            title="Restore this version?"
            description={
                snapshot
                    ? `Replace current contents with the ${formatDateTime(snapshot.createdAt)} version. ` +
                      `Comments and attachments are not rolled back. The current state is saved as a new ` +
                      `version first, so you can undo this by restoring it.`
                    : ''
            }
            confirmText="Restore"
            onConfirm={() => {
                if (!snapshot) return;
                return restore.mutateAsync(snapshot.name);
            }}
        />
    );
}
