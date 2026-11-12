// A document's versions in its File menu: Save version now, and a Version history submenu whose pick asks to restore
// that version, ending with Delete history for an owner of the drive, grayed out until there is a version. Their
// dialogs live outside the menu, and the same versions show as buttons on the screen a document opens to when its
// storage is gone.

import { SWEEP_GRACE_DAYS } from '@workspace/lib/constants/sweep';
import { formatDateTime } from '@workspace/lib/date';
import { useIsEffectiveOwner } from '@workspace/lib/drive';
import { formatFileSize } from '@workspace/lib/format';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { useDeleteVersions, useRestoreVersion, useSaveVersion, useVersions } from '@workspace/lib/versioning';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { History, Save, Trash2 } from 'lucide-react';
import { Button } from '../../button';
import { ConfirmDialog } from '../../confirm-dialog';
import { DeleteDialog } from '../../delete/delete-dialog';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../../dropdown-menu';

// Only the menu rows. Its owner renders RestoreVersionDialog and DeleteHistoryDialog outside the menu's content,
// where Radix would unmount them the moment the menu closes.
export function VersionHistoryMenu({
    path,
    onRequestRestore,
    onRequestDeleteHistory,
}: {
    path: DrivePath;
    onRequestRestore: (snap: Snapshot) => void;
    // The size of the listed versions, which the dialog says it frees.
    onRequestDeleteHistory: (size: number) => void;
}) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const save = useSaveVersion(path.ownerId, path.mountId, path.id);
    const isEffectiveOwner = useIsEffectiveOwner(path.ownerId);

    return (
        <>
            <DropdownMenuItem onSelect={() => save.mutate()} disabled={save.isPending}>
                <Save className="h-4 w-4" /> Save version now
            </DropdownMenuItem>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <History className="h-4 w-4" /> Version history
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[240px]">
                    {/* Only the list scrolls, so Delete history stays in view below a long one. */}
                    <div className="max-h-64 overflow-y-auto">
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
                    </div>
                    {isEffectiveOwner && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={!data || data.length === 0}
                                onSelect={() =>
                                    onRequestDeleteHistory((data ?? []).reduce((sum, snap) => sum + snap.size, 0))
                                }
                            >
                                <Trash2 className="h-4 w-4" /> Delete history…
                            </DropdownMenuItem>
                        </>
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
    open,
    onOpenChange,
}: {
    path: DrivePath;
    snapshot: Snapshot;
    // The document's stored data is missing: there is no current state to save first, and nothing loaded to update.
    storageGone?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const restore = useRestoreVersion(path.ownerId, path.mountId, path.id);

    return (
        <ConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Restore this version?"
            description={
                storageGone
                    ? `Rebuild the document from the ${formatDateTime(snapshot.createdAt)} version. ` +
                      `Comments go back with the text they're on. Their replies stay as they are now.`
                    : `Replace current contents with the ${formatDateTime(snapshot.createdAt)} version. ` +
                      `Comments go back with the text they're on. Their replies stay as they are now. The current state ` +
                      `is saved as a new version first, so you can undo this by restoring it.`
            }
            confirmText="Restore"
            onConfirm={async () => {
                await restore.mutateAsync(snapshot.name);
                if (storageGone) window.location.reload();
            }}
        />
    );
}

// `size` is the total size of the versions the menu listed. The comment threads' versions are deleted too, but their
// size is not counted.
export function DeleteHistoryDialog({
    path,
    size,
    open,
    onOpenChange,
}: {
    path: DrivePath;
    size: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const deleteVersions = useDeleteVersions(path.ownerId, path.mountId, path.id);

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Delete version history?"
            description={
                `Frees ${formatFileSize(size)}. Earlier versions of this document and its comments can't be ` +
                `restored after this. Images and comments you deleted are removed now, except those added or ` +
                `replied to in the last ${SWEEP_GRACE_DAYS} days.`
            }
            deleteText="Delete history"
            onDelete={() => deleteVersions.mutateAsync()}
        />
    );
}

// VersionHistoryMenu's rows as plain buttons, for the gone screen outside any menu.
export function StorageGoneVersions({ path }: { path: DrivePath }) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const restoreDialog = useDialogValue<Snapshot>();

    if (!data || data.length === 0) return null;

    return (
        <>
            <div className="mt-2 flex max-h-64 min-w-[240px] flex-col overflow-y-auto">
                {data.map((snap) => (
                    <Button
                        key={snap.id}
                        variant="ghost"
                        className="justify-between gap-4"
                        onClick={() => restoreDialog.openDialog(snap)}
                    >
                        <span>{formatDateTime(snap.createdAt)}</span>
                        <span className="text-xs text-muted-foreground">Restore</span>
                    </Button>
                ))}
            </div>
            {restoreDialog.value && (
                <RestoreVersionDialog
                    path={path}
                    snapshot={restoreDialog.value}
                    storageGone
                    open={restoreDialog.open}
                    onOpenChange={restoreDialog.setOpen}
                />
            )}
        </>
    );
}
