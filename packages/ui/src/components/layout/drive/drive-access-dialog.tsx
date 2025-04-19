import {useState} from "react"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog"
import {DriveAccessListEdit} from "@workspace/ui/components/layout/drive/drive-access-list-edit"
import type {DriveACL, DrivePath} from "@apps/api-server/types/drive"
import {useUpdateACL} from "@workspace/lib/drive";

export interface DriveAccessDialogProps {
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

    // Always call hooks, even if path is null
    const updateACL = useUpdateACL(path?.ownerId || '');

    // Don't render if no path is provided
    if (!path) {
        return null
    }

    // Handler for when save is clicked in the access list edit component
    const handleSave = async (updatedAcl: DriveACL[]) => {
        setIsSubmitting(true)
        await updateACL.mutateAsync({path, acl: updatedAcl});
        onOpenChange(false);
        setIsSubmitting(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[700px] overflow-y-scroll">
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
