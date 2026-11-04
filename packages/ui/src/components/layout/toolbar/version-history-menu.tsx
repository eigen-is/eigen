// A document's versions in its File menu: Save version now, and a Version history submenu whose pick asks to
// restore that version, ending with Delete history (greyed out until there is a version) for an owner of the drive. Their dialogs live outside the
// menu, and the same versions show as buttons on the screen a document opens to when its storage is gone.

import { formatDateTime } from '@workspace/lib/date';
import { useIsEffectiveOwner } from '@workspace/lib/drive';
import { formatFileSize } from '@workspace/lib/format';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { useDeleteVersions, useRestoreVersion, useSaveVersion, useVersions } from '@workspace/lib/versioning';
import { History, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../button';
import { ConfirmDialog } from '../../confirm-dialog';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../../dropdown-menu';

// VersionHistoryMenu renders only the menu rows. Pair it with RestoreVersionDialog and DeleteHistoryDialog
// rendered outside the menu's content: inside it, Radix unmounts the dialog the moment the menu closes, and
// the dialog flashes and disappears.
export function VersionHistoryMenu({
    path,
    onRequestRestore,
    onRequestDeleteHistory,
}: {
    path: DrivePath;
    onRequestRestore: (snap: Snapshot) => void;
    onRequestDeleteHistory: () => void;
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
                                onSelect={onRequestDeleteHistory}
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
    onClose,
}: {
    path: DrivePath;
    snapshot: Snapshot | null;
    // The document's stored data is missing: there is no current state to save first, and nothing loaded to update.
    storageGone?: boolean;
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
                        `Comments go back with the text they're on. Their replies stay as they are now.`
                      : `Replace current contents with the ${formatDateTime(snapshot.createdAt)} version. ` +
                        `Comments go back with the text they're on. Their replies stay as they are now. The current state ` +
                        `is saved as a new version first, so you can undo this by restoring it.`
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

// The size is that of the versions the list shows. The versions of the comment threads go too, uncounted.
export function DeleteHistoryDialog({ path, open, onClose }: { path: DrivePath; open: boolean; onClose: () => void }) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const deleteVersions = useDeleteVersions(path.ownerId, path.mountId, path.id);
    const size = (data ?? []).reduce((sum, snap) => sum + snap.size, 0);

    return (
        <ConfirmDialog
            open={open}
            onOpenChange={(next) => !next && onClose()}
            title="Delete version history?"
            description={
                `Frees ${formatFileSize(size)}. Earlier versions of this document and its comments can't be restored ` +
                `after this. Images and comments you deleted are removed once everyone has closed it, except those ` +
                `from the last 3 days.`
            }
            confirmText="Delete history"
            destructive
            onConfirm={() => deleteVersions.mutateAsync()}
        />
    );
}

// VersionHistoryMenu's rows as plain buttons, for the gone screen outside any menu.
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
