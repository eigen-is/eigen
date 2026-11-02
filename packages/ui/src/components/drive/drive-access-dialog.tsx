// The Share dialog for one Drive item: who has access, the link's general access, and whether editors may share. An
// owner or editor edits the list and saves it; a guest, or an editor when the owner restricted sharing, only sees it.
// Drive's item menu and an editor's Share button open it, for example. Its envelope button closes Share and opens
// Email collaborators for the same item, which stays open even when the host drops the path as Share closes. A host
// that moves to another item, as Back does in an editor, gets a fresh dialog for that item.

import { useIsGuest } from '@workspace/lib/auth';
import { useCheckPermissions, useIsEffectiveOwner } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DriveAccessList } from '@workspace/ui/components/drive/drive-access-list';
import { DriveAccessListEdit } from '@workspace/ui/components/drive/drive-access-list-edit';
import { DriveEmailCollaborators } from '@workspace/ui/components/drive/drive-email-collaborators';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
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
    const isGuest = useIsGuest();
    const isEffectiveOwner = useIsEffectiveOwner(path.ownerId);
    const { data: permissions } = useCheckPermissions(path.ownerId, path.mountId, path.id);
    const readOnly = isGuest || (path.sharingRestricted && !isEffectiveOwner);

    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={`Share '${stripEigenExtension(path.name)}'`}
            size="lg"
        >
            {readOnly ? (
                // Close is the only button, so nothing submits.
                <FormDialogForm readOnly submitLabel="Save" onSubmit={() => {}}>
                    <p className="text-sm text-muted-foreground">Sharing is restricted by the owner.</p>
                    <DriveAccessList path={path} scrollable className="max-h-[60vh]" />
                </FormDialogForm>
            ) : (
                <DriveAccessListEdit
                    path={path}
                    prefillEmail={prefillEmail}
                    onEmailClick={permissions?.canWrite ? onEmailClick : undefined}
                />
            )}
        </FormDialog>
    );
}
