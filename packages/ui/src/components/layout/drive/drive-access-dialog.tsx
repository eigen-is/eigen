import {useAuth} from '@workspace/lib/auth';
import {useIsEffectiveOwner, useUpdateACL} from '@workspace/lib/drive';
import type {DriveACL, DrivePath, DriveVisibility} from '@workspace/lib/types/drive';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {DriveAccessList} from '@workspace/ui/components/layout/drive/drive-access-list';
import {DriveAccessListEdit} from '@workspace/ui/components/layout/drive/drive-access-list-edit';
import {useState} from 'react';

export type DriveAccessDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    path: DrivePath | null;
};

export function DriveAccessDialog({open, onOpenChange, path}: DriveAccessDialogProps) {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const {user} = useAuth();
    const updateACL = useUpdateACL(path?.ownerId || '', path?.mountId, user?.id);
    const isEffectiveOwner = useIsEffectiveOwner(path?.ownerId || '');

    if (!path) {
        return null;
    }

    // Non-owner editors see read-only view when sharing is restricted
    const readOnly = path.sharingRestricted && !isEffectiveOwner;

    const handleSave = async (updatedAcl: DriveACL[], visibility: DriveVisibility, sharingRestricted?: boolean) => {
        setIsSubmitting(true);
        await updateACL.mutateAsync({path, acl: updatedAcl, visibility, sharingRestricted});
        onOpenChange(false);
        setIsSubmitting(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="lg" className="overflow-y-scroll">
                <DialogHeader>
                    <div className="sm:max-w-[600px]">
                        <DialogTitle className="truncate overflow-visible" title={path.name}>
                            Share '{path.name}'
                        </DialogTitle>
                    </div>
                </DialogHeader>

                {readOnly ? (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">Sharing is restricted by the owner.</p>
                        <DriveAccessList path={path}/>
                    </div>
                ) : (
                    <DriveAccessListEdit
                        path={path}
                        onSave={handleSave}
                        onCancel={!isSubmitting ? () => onOpenChange(false) : undefined}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
