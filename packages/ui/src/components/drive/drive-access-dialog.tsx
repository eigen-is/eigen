// The Share dialog for one Drive item: who has access, the link's general access, and whether editors may share. An
// owner or an editor by name edits the list and saves it. Everyone else only sees it, such as a viewer, a guest,
// someone who edits only through the signed-in link, or an editor whose owner restricted sharing. Drive's item menu and an editor's Share button open it, for example. Its envelope button closes Share and
// opens Email collaborators for the same item, which stays open even when the host drops the path as Share closes. A
// host that moves to another item, as Back does in an editor, gets a fresh dialog for that item.

import { useCanShare } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DialogFooter } from '@workspace/ui/components/dialog';
import { DriveAccessList } from '@workspace/ui/components/drive/drive-access-list';
import { DriveAccessListEdit } from '@workspace/ui/components/drive/drive-access-list-edit';
import { DriveEmailCollaborators } from '@workspace/ui/components/drive/drive-email-collaborators';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import { useState } from 'react';

export type DriveAccessDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    path: DrivePath | null;
    prefillEmail?: string;
};

export function DriveAccessDialog({ open, onOpenChange, path, prefillEmail }: DriveAccessDialogProps) {
    // Its own state, not the path prop: a host such as Drive's folder page drops the path once Share closes.
    // A host that moves on to another item closes it.
    const [emailPath, setEmailPath] = useState<DrivePath | null>(null);
    if (emailPath && path && path.id !== emailPath.id) setEmailPath(null);

    return (
        <>
            {path && (
                // Keyed by the item, so another item starts from its own list while a refetch of this one keeps
                // the edits.
                <ShareDialog
                    key={path.id}
                    path={path}
                    open={open}
                    onOpenChange={onOpenChange}
                    prefillEmail={prefillEmail}
                    onEmailClick={() => {
                        setEmailPath(path);
                        onOpenChange(false);
                    }}
                />
            )}
            {emailPath && (
                <DriveEmailCollaborators
                    path={emailPath}
                    open={true}
                    onOpenChange={(open) => {
                        if (!open) setEmailPath(null);
                    }}
                />
            )}
        </>
    );
}

function ShareDialog({
    path,
    open,
    onOpenChange,
    prefillEmail,
    onEmailClick,
}: {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    prefillEmail?: string;
    onEmailClick: () => void;
}) {
    const canShare = useCanShare(path);

    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title={`Share '${stripEigenExtension(path.name)}'`}>
            {canShare ? (
                <DriveAccessListEdit path={path} prefillEmail={prefillEmail} onEmailClick={onEmailClick} />
            ) : (
                <>
                    <p className="text-sm text-muted-foreground">
                        {path.sharingRestricted
                            ? 'Sharing is restricted by the owner.'
                            : 'You can view who has access.'}
                    </p>
                    <DriveAccessList path={path} scrollable className="max-h-[60vh]" />
                    <DialogFooter showCloseButton />
                </>
            )}
        </FormDialog>
    );
}
