import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useCheckPermissions, useIsEffectiveOwner, useUpdateACL } from '@workspace/lib/drive';
import {
    type DriveACLDelta,
    type DrivePath,
    type DriveVisibility,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { DriveAccessList } from '@workspace/ui/components/drive/drive-access-list';
import { DriveAccessListEdit } from '@workspace/ui/components/drive/drive-access-list-edit';
import { DriveEmailCollaborators } from '@workspace/ui/components/drive/drive-email-collaborators';
import { useEffect, useState } from 'react';

export type DriveAccessDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    path: DrivePath | null;
    prefillEmail?: string;
};

export function DriveAccessDialog({ open, onOpenChange, path, prefillEmail }: DriveAccessDialogProps) {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [emailPath, setEmailPath] = useState<DrivePath | null>(null);

    useEffect(() => {
        setEmailPath(null);
    }, [path]);

    const { user } = useAuth();
    const isGuest = useIsGuest();
    const updateACL = useUpdateACL(path?.ownerId || '', path?.mountId, user?.id);
    const isEffectiveOwner = useIsEffectiveOwner(path?.ownerId || '');
    const { data: permissions } = useCheckPermissions(path?.ownerId || '', path?.mountId || '', path?.id);

    if (!path) {
        return null;
    }

    // Guests and non-owner editors (when sharing is restricted) see read-only view
    const readOnly = isGuest || (path.sharingRestricted && !isEffectiveOwner);

    const handleEmailClick = () => {
        setEmailPath(path);
        onOpenChange(false);
    };

    const handleSave = async (delta: DriveACLDelta, visibility: DriveVisibility, sharingRestricted?: boolean) => {
        setIsSubmitting(true);
        await updateACL.mutateAsync({ path, add: delta.add, remove: delta.remove, visibility, sharingRestricted });
        onOpenChange(false);
        setIsSubmitting(false);
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    size="lg"
                    className="max-h-[80vh] flex flex-col overflow-hidden"
                    onOpenAutoFocus={readOnly ? (e) => e.preventDefault() : undefined}
                >
                    <DialogHeader>
                        <div className="sm:max-w-[600px]">
                            <DialogTitle className="truncate overflow-visible" title={stripEigenExtension(path.name)}>
                                Share '{stripEigenExtension(path.name)}'
                            </DialogTitle>
                        </div>
                    </DialogHeader>

                    {readOnly ? (
                        <div className="flex flex-col min-h-0">
                            <p className="text-sm text-muted-foreground shrink-0 mb-3">
                                Sharing is restricted by the owner.
                            </p>
                            <DriveAccessList path={path} scrollable />
                        </div>
                    ) : (
                        <DriveAccessListEdit
                            path={path}
                            onSave={handleSave}
                            onCancel={!isSubmitting ? () => onOpenChange(false) : undefined}
                            prefillEmail={prefillEmail}
                            onEmailClick={permissions?.canWrite ? handleEmailClick : undefined}
                        />
                    )}
                </DialogContent>
            </Dialog>
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
