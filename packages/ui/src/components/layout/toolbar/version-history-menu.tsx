import { useRestoreVersion, useSaveVersion, useVersions } from '@workspace/lib/core/versioning/hooks';
import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { History, Save } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../confirm-dialog';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../dropdown-menu';

type Props = { path: DrivePath };

export function VersionHistoryMenu({ path }: Props) {
    const [pending, setPending] = useState<Snapshot | null>(null);
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const save = useSaveVersion(path.ownerId, path.mountId, path.id);
    const restore = useRestoreVersion(path.ownerId, path.mountId, path.id);

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
                                // Defer until after the dropdown finishes closing — otherwise Radix
                                // restores focus to the trigger, the dialog sees focus leaving its
                                // tree, and dismisses itself immediately.
                                onSelect={() => setTimeout(() => setPending(snap), 0)}
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

            <ConfirmDialog
                open={!!pending}
                onOpenChange={(open) => !open && setPending(null)}
                title="Restore this version?"
                description={
                    pending
                        ? `Replace current contents with the ${formatDateTime(pending.createdAt)} version. ` +
                          `Anyone with this open will be reconnected; any local unsynced edits they had at that moment ` +
                          `may be re-applied on top. Comments and attachments are not rolled back. The current state ` +
                          `is saved as a new version first, so you can undo this by restoring it.`
                        : ''
                }
                confirmText="Restore"
                onConfirm={async () => {
                    if (!pending) return;
                    await restore.mutateAsync(pending.name);
                    setPending(null);
                }}
            />
        </>
    );
}
