import {useState} from "react"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog"
import {DriveAccessListEdit} from "@workspace/ui/components/layout/drive/drive-access-list-edit"
import type {DriveACL, DrivePath, DriveVisibility} from "@workspace/lib/types/drive"
import {useUpdateACL} from "@workspace/lib/drive";

export type DriveAccessDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    path: DrivePath | null
}

export function DriveAccessDialog({
                                      open,
                                      onOpenChange,
                                      path
                                  }: DriveAccessDialogProps) {
    const [isSubmitting, setIsSubmitting] = useState(false)

    const updateACL = useUpdateACL(path?.ownerId || '', path?.mountId);

    if (!path) {
        return null
    }

    const handleSave = async (updatedAcl: DriveACL[], visibility: DriveVisibility) => {
        setIsSubmitting(true)
        await updateACL.mutateAsync({path, acl: updatedAcl, visibility});
        onOpenChange(false);
        setIsSubmitting(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="lg" className="overflow-y-scroll">
                <DialogHeader>
                    <div className="sm:max-w-[600px]"><DialogTitle className="truncate overflow-visible"
                                                                   title={path.name}>Share '{path.name}'</DialogTitle>
                    </div>
                </DialogHeader>

                <DriveAccessListEdit
                    path={path}
                    onSave={handleSave}
                    onCancel={!isSubmitting ? () => onOpenChange(false) : undefined}
                />
            </DialogContent>
        </Dialog>
    )
}
