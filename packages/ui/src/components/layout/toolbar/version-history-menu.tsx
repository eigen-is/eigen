import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { useRestoreVersion, useSaveVersion, useVersions } from '@workspace/lib/versioning';
import { History, Save } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../button';
import { ConfirmDialog } from '../../confirm-dialog';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../dropdown-menu';

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
    storageGone,
    onClose,
}: {
    path: DrivePath;
    snapshot: Snapshot | null;
    // The document's stored data is missing: there is no current state to save first, and nothing loaded to update.
    storageGone: boolean;
    onClose: () => void;
}) {
    const restore = useRestoreVersion(path.ownerId, path.mountId, path.id);

    return (
        <ConfirmDialog
            open={!!snapshot}
            onOpenChange={(open) => !open && onClose()}
            title="Restore this version?"
            description={
                !snapshot
                    ? ''
                    : storageGone
                      ? `Rebuild the document from the ${formatDateTime(snapshot.createdAt)} version. ` +
                        `Comments and attachments are not rolled back.`
                      : `Replace current contents with the ${formatDateTime(snapshot.createdAt)} version. ` +
                        `Comments and attachments are not rolled back. The current state is saved as a new ` +
                        `version first, so you can undo this by restoring it.`
            }
            confirmText="Restore"
            onConfirm={async () => {
                if (!snapshot) return;
                await restore.mutateAsync(snapshot.name);
                if (storageGone) window.location.reload();
            }}
        />
    );
}

// VersionHistoryMenu's rows as plain buttons, for the gone screen outside any dropdown.
export function StorageGoneVersions({ path }: { path: DrivePath }) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const [pendingSnapshot, setPendingSnapshot] = useState<Snapshot | null>(null);

    if (!data || data.length === 0) return null;

    return (
        <>
            <div className="mt-2 flex max-h-64 min-w-[240px] flex-col overflow-y-auto">
                {data.map((snap) => (
                    <Button
                        key={snap.id}
                        variant="ghost"
                        className="justify-between gap-4"
                        onClick={() => setPendingSnapshot(snap)}
                    >
                        <span>{formatDateTime(snap.createdAt)}</span>
                        <span className="text-xs text-muted-foreground">Restore</span>
                    </Button>
                ))}
            </div>
            <RestoreVersionDialog
                path={path}
                snapshot={pendingSnapshot}
                storageGone
                onClose={() => setPendingSnapshot(null)}
            />
        </>
    );
}
