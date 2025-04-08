import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog"
import { DriveAccessListEdit } from "@workspace/ui/components/layout/drive/drive-access-list-edit"
import type { DriveACL, DrivePath } from "@apps/api-server/types/drive"
import { useUpdateACL } from "@workspace/lib/drive";

export interface DriveAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: DrivePath | null
  acl: DriveACL[] | null
}

export function DriveAccessDialog({
  open,
  onOpenChange,
  path,
  acl,
}: DriveAccessDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const updateACL = useUpdateACL(path!.ownerId);

  // Handler for when save is clicked in the access list edit component
  const handleSave = async (updatedAcl: DriveACL[]) => {
    setIsSubmitting(true)
    await updateACL.mutateAsync({pathId: path!.id, acl: updatedAcl, parentPathId: path!.parentId || null});
    onOpenChange(false);
    setIsSubmitting(false);
  }

  // Don't render if no path is provided
  if (!path) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Share '{path.name}'</DialogTitle>
        </DialogHeader>
        
        <DriveAccessListEdit
          acl={acl}
          path={path}
          onSave={handleSave}
          onCancel={!isSubmitting ? () => onOpenChange(false) : undefined}
        />
      </DialogContent>
    </Dialog>
  )
}
