// The Share dialog for one Drive item: who has access, the link's general access, and whether editors may share. An
// owner or editor edits the list and saves it; a guest, or an editor when the owner restricted sharing, only sees it.
// Drive's item menu and an editor's Share button open it, for example. Its envelope button hands over to Email
// collaborators.

import { useIsGuest } from '@workspace/lib/auth';
import { useCheckPermissions, useIsEffectiveOwner } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DriveAccessList } from '@workspace/ui/components/drive/drive-access-list';
import { DriveAccessListEdit } from '@workspace/ui/components/drive/drive-access-list-edit';
import { DriveEmailCollaborators } from '@workspace/ui/components/drive/drive-email-collaborators';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useEffect, useState } from 'react';

export type DriveAccessDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    path: DrivePath | null;
    prefillEmail?: string;
};

export function DriveAccessDialog({ open, onOpenChange, path, prefillEmail }: DriveAccessDialogProps) {
    const [emailPath, setEmailPath] = useState<DrivePath | null>(null);

    useEffect(() => {
        setEmailPath(null);
    }, [path]);

    const isGuest = useIsGuest();
    const isEffectiveOwner = useIsEffectiveOwner(path?.ownerId || '');
    const { data: permissions } = useCheckPermissions(path?.ownerId || '', path?.mountId || '', path?.id);

    if (!path) {
        return null;
    }

    const readOnly = isGuest || (path.sharingRestricted && !isEffectiveOwner);

    const handleEmailClick = () => {
        setEmailPath(path);
        onOpenChange(false);
    };

    return (
        <>
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
                        onEmailClick={permissions?.canWrite ? handleEmailClick : undefined}
                    />
                )}
            </FormDialog>
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
